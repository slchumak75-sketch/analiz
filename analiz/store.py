"""SQLite-хранилище, проверки ввода и агрегаты для интерфейса.

Суммы хранятся строками Decimal. В БД нет исходных значений из Excel: создаются
только организации и периоды, которые пользователь явно ввёл самостоятельно.
"""
from __future__ import annotations

from contextlib import contextmanager
from decimal import Decimal, localcontext
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import time
from typing import Any, Iterator
from uuid import uuid4

from .analytics import COST_TYPES, expense_structure, period_analysis
from .calculations import INPUT_FIELDS, STORED_FIELDS, ZERO, calculate_periods, calculate_year, decimal_text, parse_amount

SCHEMA_VERSION = 3
INPUT_LABELS = {
    "retail_revenue": "Выручка ККМ с НДС",
    "invoice_revenue": "Реализация по накладным с НДС",
    "invoice_vat": "НДС реализации по накладным",
    "non_vat_sales": "Товары реализации без НДС",
    "non_vat_deduction": "Вычет по товарам без НДС",
    "input_vat": "Входящий НДС",
    "cost_of_sales": "Себестоимость реализации без НДС",
}

# Названия и значения из B20:C47 сохранены буквально. Владелец подтвердил,
# что C — ставка НДС, включая 25%. Она показывается, но не влияет на формулы.
DEFAULT_CATEGORIES: tuple[tuple[int, str, str], ...] = (
    (20, "фонд заработной платы", "0"),
    (21, "фзн", "0"),
    (22, "бензин", "20"),
    (23, "амортизация основных средств", "0"),
    (24, "авто обслуживание", "20"),
    (25, "аренда", "0"),
    (26, "комунальные услуги", "20"),
    (27, "комунальные услуги", "0"),
    (28, "транспортные услуги", "20"),
    (29, "транспортные услуги", "0"),
    (30, "обслуживание компьютера", "0"),
    (31, "телефон интернет", "25"),
    (32, "услуги банка", "0"),
    (33, "обсл.кассы (МИКС)", "20"),
    (34, "обс.КСА (Забелла)", "20"),
    (35, "электронные ключи", "20"),
    (36, "товары приобритение", "20"),
    (37, "товары приобретение", "0"),
    (38, "списание товара собств.нужды", "20"),
    (39, "списание товара собств.нужды", "0"),
    (40, "Завадский (1С)", "0"),
    (41, "услуги больница", "20"),
    (42, "Забелла лицензия", "20"),
    (43, "обслуж.терм. (Туссон)", "20"),
    (44, "ТН Накладные", "20"),
    (45, "инвест.вычет", "0"),
    (46, "обслуж.эл.тг эрспектр", "20"),
    (47, "журнал", "20"),
)


class NotFoundError(Exception):
    """Объект не найден, например после удаления в другом окне приложения."""


def valid_id(value: Any, label: str = "Идентификатор") -> int:
    if isinstance(value, bool) or not str(value).isdigit():
        raise ValueError(f"{label}: неверное значение.")
    number = int(value)
    if number < 1 or number > 2**63 - 1:
        raise ValueError(f"{label}: неверное значение.")
    return number


def valid_year(value: Any) -> int:
    if isinstance(value, bool) or not str(value).isdigit():
        raise ValueError("Укажите год от 1900 до 9999.")
    number = int(value)
    if not 1900 <= number <= 9999:
        raise ValueError("Укажите год от 1900 до 9999.")
    return number


def valid_quarter(value: Any) -> int:
    if isinstance(value, bool) or not str(value).isdigit() or not 1 <= int(value) <= 4:
        raise ValueError("Квартал должен быть от 1 до 4.")
    return int(value)


def clean_text(value: Any, label: str, max_length: int, *, required: bool = True) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{label}: требуется текст.")
    text = value.strip()
    if required and not text:
        raise ValueError(f"Заполните поле «{label}».")
    if len(text) > max_length or any(ord(c) < 32 for c in text):
        raise ValueError(f"«{label}»: не более {max_length} символов и без управляющих знаков.")
    return text


def valid_vat_rate(value: Any) -> str | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    rate = parse_amount(value, "Ставка НДС")
    if not ZERO <= rate <= Decimal("100"):
        raise ValueError("Ставка НДС должна быть от 0 до 100% или не указана.")
    # Эквивалентные 25, 25.00 и 0.25 с форматом процентов — одна ставка.
    return "0" if rate == ZERO else format(rate.normalize(), "f")


class Store:
    def __init__(self, database: Path | str):
        self.database = Path(database)
        self.database.parent.mkdir(parents=True, exist_ok=True)
        self._initialise()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.database), timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        con = self._connect()
        try:
            yield con
            con.commit()
        except BaseException:
            con.rollback()
            raise
        finally:
            con.close()

    @staticmethod
    def _enable_wal(con: sqlite3.Connection) -> None:
        """Переключение журнала может кратко столкнуться с миграцией другого окна."""
        deadline = time.monotonic() + 10
        while True:
            try:
                mode = con.execute("PRAGMA journal_mode = WAL").fetchone()[0]
                if str(mode).lower() != "wal":
                    raise sqlite3.OperationalError("Не удалось включить WAL для базы.")
                return
            except sqlite3.OperationalError as exc:
                code = getattr(exc, "sqlite_errorcode", None)
                transient = (code is not None and (code & 0xFF) in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED))
                transient = transient or (code is None and str(exc).lower() in ("database is locked", "database is busy"))
                if not transient or time.monotonic() >= deadline:
                    raise
                time.sleep(0.02)

    def _initialise(self) -> None:
        with self.connection() as con:
            # Блокировка ДО чтения версии защищает от двух одновременных запусков,
            # а транзакция делает создание и миграции единым атомарным действием.
            con.execute("BEGIN IMMEDIATE")
            version = con.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise RuntimeError("База создана более новой версией программы. Обновите приложение и сохраните копию базы.")
            if version == 0:
                script = """
                    CREATE TABLE organizations (
                        id INTEGER PRIMARY KEY,
                        name TEXT NOT NULL,
                        currency TEXT NOT NULL DEFAULT '',
                        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                    );
                    CREATE TABLE categories (
                        id INTEGER PRIMARY KEY,
                        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                        name TEXT NOT NULL,
                        tag TEXT NOT NULL DEFAULT '',
                        source_row INTEGER,
                        position INTEGER NOT NULL,
                        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))
                    );
                    CREATE INDEX categories_org ON categories(organization_id, position, id);
                    CREATE TABLE periods (
                        id INTEGER PRIMARY KEY,
                        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                        year INTEGER NOT NULL CHECK(year BETWEEN 1900 AND 9999),
                        quarter INTEGER NOT NULL CHECK(quarter BETWEEN 1 AND 4),
                        retail_revenue TEXT NOT NULL,
                        invoice_revenue TEXT NOT NULL,
                        invoice_vat TEXT NOT NULL,
                        non_vat_sales TEXT NOT NULL,
                        non_vat_deduction TEXT NOT NULL,
                        input_vat TEXT NOT NULL,
                        cost_of_sales TEXT NOT NULL,
                        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(organization_id, year, quarter)
                    );
                    CREATE TABLE expenses (
                        period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
                        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
                        amount TEXT NOT NULL,
                        PRIMARY KEY(period_id, category_id)
                    );
                    CREATE TRIGGER expenses_same_org_insert BEFORE INSERT ON expenses
                    WHEN (SELECT organization_id FROM periods WHERE id=NEW.period_id)
                       != (SELECT organization_id FROM categories WHERE id=NEW.category_id)
                    BEGIN SELECT RAISE(ABORT, 'expense organization mismatch'); END;
                    CREATE TRIGGER expenses_same_org_update BEFORE UPDATE OF period_id, category_id ON expenses
                    WHEN (SELECT organization_id FROM periods WHERE id=NEW.period_id)
                       != (SELECT organization_id FROM categories WHERE id=NEW.category_id)
                    BEGIN SELECT RAISE(ABORT, 'expense organization mismatch'); END;
                    PRAGMA user_version = 1;
                """
                # executescript() не подходит: он неявно завершает транзакцию.
                statement = ""
                for line in script.splitlines(keepends=True):
                    statement += line
                    if sqlite3.complete_statement(statement):
                        con.execute(statement)
                        statement = ""
                if statement.strip():
                    raise RuntimeError("Неполная команда создания схемы.")
            if version <= 1:
                # Миграция без изменения прежних сумм; ключи нужны для обмена Excel.
                # Выполняется одной транзакцией, чтобы сбой не оставил полусхему.
                con.execute("ALTER TABLE categories ADD COLUMN export_key TEXT")
                for row in con.execute("SELECT id, organization_id, source_row FROM categories ORDER BY id").fetchall():
                    key = f"source:{row['source_row']}" if row["source_row"] is not None else f"custom:{uuid4().hex}"
                    if con.execute("SELECT 1 FROM categories WHERE organization_id=? AND export_key=?", (row["organization_id"], key)).fetchone():
                        key = f"custom:{uuid4().hex}"
                    con.execute("UPDATE categories SET export_key=? WHERE id=?", (key, row["id"]))
                con.execute("CREATE UNIQUE INDEX categories_export_key ON categories(organization_id, export_key)")
                con.execute("""CREATE TABLE category_year_settings (
                    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
                    year INTEGER NOT NULL CHECK(year BETWEEN 1900 AND 9999),
                    cost_type TEXT NOT NULL CHECK(cost_type IN ('fixed','variable','unclassified')),
                    vat_rate TEXT,
                    PRIMARY KEY(category_id, year)
                )""")
                con.execute("PRAGMA user_version = 2")
            if version <= 2:
                # Сохраняем прежний ручной вычет отдельно. Новые расчёты всех лет
                # используют формулы книги 2; исторические вводы не уничтожаются.
                con.execute("ALTER TABLE periods ADD COLUMN legacy_manual_deduction TEXT")
                con.execute("UPDATE periods SET legacy_manual_deduction = non_vat_deduction")
                con.execute("PRAGMA user_version = 3")
            con.commit()
            self._enable_wal(con)

    @staticmethod
    def _organization(con: sqlite3.Connection, organization_id: Any) -> sqlite3.Row:
        oid = valid_id(organization_id, "Организация")
        row = con.execute("SELECT * FROM organizations WHERE id = ?", (oid,)).fetchone()
        if row is None:
            raise NotFoundError("Организация не найдена.")
        return row

    def list_organizations(self) -> list[dict[str, Any]]:
        with self.connection() as con:
            return [dict(row) for row in con.execute(
                """SELECT o.*, COUNT(p.id) AS period_count FROM organizations o
                   LEFT JOIN periods p ON p.organization_id = o.id
                   GROUP BY o.id ORDER BY o.name COLLATE NOCASE, o.id""")]

    def create_organization(self, name: Any, currency: Any = "") -> dict[str, Any]:
        name = clean_text(name, "Название организации", 120)
        currency = clean_text(currency, "Валюта", 20, required=False)
        with self.connection() as con:
            cursor = con.execute("INSERT INTO organizations(name, currency) VALUES (?, ?)", (name, currency))
            oid = cursor.lastrowid
            con.executemany("""INSERT INTO categories(organization_id, name, tag, source_row, position, export_key)
                               VALUES (?, ?, ?, ?, ?, ?)""",
                            [(oid, name, tag, row, row, f"source:{row}") for row, name, tag in DEFAULT_CATEGORIES])
            return dict(self._organization(con, oid))

    def update_organization(self, organization_id: Any, name: Any, currency: Any) -> dict[str, Any]:
        name = clean_text(name, "Название организации", 120)
        currency = clean_text(currency, "Валюта", 20, required=False)
        with self.connection() as con:
            oid = self._organization(con, organization_id)["id"]
            con.execute("UPDATE organizations SET name=?, currency=? WHERE id=?", (name, currency, oid))
            return dict(self._organization(con, oid))

    def delete_organization(self, organization_id: Any) -> None:
        with self.connection() as con:
            oid = self._organization(con, organization_id)["id"]
            con.execute("DELETE FROM organizations WHERE id=?", (oid,))

    def categories(self, organization_id: Any) -> list[dict[str, Any]]:
        with self.connection() as con:
            oid = self._organization(con, organization_id)["id"]
            return [dict(row) for row in con.execute(
                "SELECT * FROM categories WHERE organization_id=? ORDER BY position, id", (oid,))]

    def add_category(self, organization_id: Any, name: Any, tag: Any = "", *,
                     year: Any = None, expected_revision: Any = None) -> dict[str, Any]:
        name = clean_text(name, "Статья затрат", 120)
        # Старые произвольные метки сохраняются как есть. Если это не число,
        # ставка для года остаётся неопределённой, пока её не задаст пользователь.
        tag = clean_text(tag, "Ставка НДС", 40, required=False)
        y = valid_year(year) if expected_revision is not None else None
        with self.connection() as con:
            con.execute("BEGIN IMMEDIATE")
            oid = self._organization(con, organization_id)["id"]
            if y is not None:
                self._check_revision(con, oid, y, expected_revision)
            count = con.execute("SELECT COUNT(*) FROM categories WHERE organization_id=?", (oid,)).fetchone()[0]
            if count >= 1000:
                raise ValueError("Допускается не более 1000 статей затрат.")
            position = con.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM categories WHERE organization_id=?", (oid,)).fetchone()[0]
            cursor = con.execute("INSERT INTO categories(organization_id,name,tag,position,export_key) VALUES(?,?,?,?,?)", (oid, name, tag, position, f"custom:{uuid4().hex}"))
            result = dict(con.execute("SELECT * FROM categories WHERE id=?", (cursor.lastrowid,)).fetchone())
            if y is not None:
                result["year_revision"] = self._year_revision(con, oid, y)
            return result

    def update_category(self, organization_id: Any, category_id: Any, *, archived: Any) -> dict[str, Any]:
        if not isinstance(archived, bool):
            raise ValueError("Состояние статьи должно быть логическим значением.")
        with self.connection() as con:
            oid = self._organization(con, organization_id)["id"]
            cid = valid_id(category_id, "Статья затрат")
            result = con.execute("UPDATE categories SET archived=? WHERE id=? AND organization_id=?", (int(archived), cid, oid))
            if result.rowcount == 0:
                raise NotFoundError("Статья затрат не найдена.")
            return dict(con.execute("SELECT * FROM categories WHERE id=?", (cid,)).fetchone())

    @staticmethod
    def _category_impact(con: sqlite3.Connection, oid: int, cid: int) -> dict[str, Any]:
        category = con.execute("SELECT * FROM categories WHERE organization_id=? AND id=?", (oid, cid)).fetchone()
        if category is None:
            raise NotFoundError("Статья затрат не найдена.")
        records = [tuple(row) for row in con.execute(
            """SELECT p.year,p.quarter,e.amount FROM expenses e JOIN periods p ON p.id=e.period_id
               WHERE p.organization_id=? AND e.category_id=? ORDER BY p.year,p.quarter""", (oid, cid))]
        settings = [tuple(row) for row in con.execute(
            "SELECT year,cost_type,vat_rate FROM category_year_settings WHERE category_id=? ORDER BY year", (cid,))]
        content = [oid, tuple(category), records, settings]
        revision = hashlib.sha256(json.dumps(content, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
        return {"category": dict(category), "period_count": len(records),
                "years": sorted({row[0] for row in records} | {row[0] for row in settings}),
                "settings_count": len(settings), "revision": revision}

    def category_impact(self, organization_id: Any, category_id: Any) -> dict[str, Any]:
        with self.connection() as con:
            con.execute("BEGIN")
            oid = self._organization(con, organization_id)["id"]
            return self._category_impact(con, oid, valid_id(category_id, "Статья затрат"))

    def delete_category(self, organization_id: Any, category_id: Any, *,
                        confirmed: Any, expected_revision: Any) -> None:
        """Явное необратимое удаление с проверкой влияния на ВСЕ годы."""
        if confirmed is not True or not isinstance(expected_revision, str):
            raise ValueError("Подтвердите удаление статьи и её истории.")
        with self.connection() as con:
            con.execute("BEGIN IMMEDIATE")
            oid = self._organization(con, organization_id)["id"]
            cid = valid_id(category_id, "Статья затрат")
            impact = self._category_impact(con, oid, cid)
            if impact["revision"] != expected_revision:
                raise ValueError("История статьи изменилась в другом окне. Проверьте удаление ещё раз.")
            con.execute("DELETE FROM categories WHERE organization_id=? AND id=?", (oid, cid))

    def get_period(self, organization_id: Any, year: Any, quarter: Any) -> dict[str, Any] | None:
        y, q = valid_year(year), valid_quarter(quarter)
        with self.connection() as con:
            con.execute("BEGIN")
            oid = self._organization(con, organization_id)["id"]
            row = con.execute("SELECT * FROM periods WHERE organization_id=? AND year=? AND quarter=?", (oid, y, q)).fetchone()
            if row is None:
                return None
            expenses = {str(r["category_id"]): r["amount"] for r in con.execute(
                "SELECT category_id, amount FROM expenses WHERE period_id=?", (row["id"],))}
            return {"year": y, "quarter": q, "inputs": {key: row[key] for key in INPUT_FIELDS},
                    "legacy_manual_deduction": row["legacy_manual_deduction"],
                    "expenses": expenses, "updated_at": row["updated_at"]}

    @staticmethod
    def _prepare_period(inputs: Any, expenses: Any) -> tuple[dict[str, Decimal], dict[int, Decimal]]:
        if not isinstance(inputs, dict) or not isinstance(expenses, dict):
            raise ValueError("Нужны показатели и список затрат квартала.")
        if set(inputs) - set(INPUT_FIELDS):
            raise ValueError("Неизвестный показатель квартала.")
        values = {key: parse_amount(inputs.get(key), INPUT_LABELS[key]) for key in INPUT_FIELDS}
        expense_values: dict[int, Decimal] = {}
        if len(expenses) > 1000:
            raise ValueError("Слишком много статей затрат.")
        for key, value in expenses.items():
            cid = valid_id(key, "Статья затрат")
            if cid in expense_values:
                raise ValueError("Статья затрат указана дважды.")
            expense_values[cid] = parse_amount(value, "Статья затрат", empty_zero=True)
        return values, expense_values

    @staticmethod
    def _put_period(con: sqlite3.Connection, oid: int, y: int, q: int,
                    values: dict[str, Decimal], expense_values: dict[int, Decimal],
                    categories: dict[int, Any], legacy_deduction: Decimal | None = None) -> None:
        if not set(expense_values).issubset(categories):
            raise ValueError("В списке затрат есть статья другой организации или удалённая статья.")
        fields_sql = ", ".join((*STORED_FIELDS, "legacy_manual_deduction"))
        placeholders = ", ".join("?" for _ in range(len(STORED_FIELDS) + 1))
        # При повторном сохранении прежний ручной ввод не стирается.
        updates = ", ".join(f"{field}=excluded.{field}" for field in INPUT_FIELDS)
        legacy = decimal_text(legacy_deduction) if legacy_deduction is not None else None
        con.execute(f"""INSERT INTO periods(organization_id,year,quarter,{fields_sql})
            VALUES (?,?,?,{placeholders}) ON CONFLICT(organization_id,year,quarter)
            DO UPDATE SET {updates}, legacy_manual_deduction=COALESCE(periods.legacy_manual_deduction,excluded.legacy_manual_deduction), updated_at=CURRENT_TIMESTAMP""",
            (oid, y, q, *(decimal_text(values[field]) for field in INPUT_FIELDS), legacy or "0", legacy))
        pid = con.execute("SELECT id FROM periods WHERE organization_id=? AND year=? AND quarter=?", (oid, y, q)).fetchone()[0]
        # Архивные статьи, отсутствующие в запросе, остаются нетронутыми.
        replace_ids = {cid for cid, cat in categories.items() if not cat["archived"]} | set(expense_values)
        con.executemany("DELETE FROM expenses WHERE period_id=? AND category_id=?", [(pid, cid) for cid in replace_ids])
        con.executemany("INSERT INTO expenses(period_id,category_id,amount) VALUES(?,?,?)",
                        [(pid, cid, decimal_text(value)) for cid, value in expense_values.items() if value != ZERO])

    def save_period(self, organization_id: Any, year: Any, quarter: Any,
                    inputs: Any, expenses: Any) -> dict[str, Any]:
        y, q = valid_year(year), valid_quarter(quarter)
        values, expense_values = self._prepare_period(inputs, expenses)
        with self.connection() as con:
            con.execute("BEGIN IMMEDIATE")
            oid = self._organization(con, organization_id)["id"]
            categories = {row["id"]: row for row in con.execute(
                "SELECT id, archived FROM categories WHERE organization_id=?", (oid,))}
            self._put_period(con, oid, y, q, values, expense_values, categories)
        result = self.get_period(oid, y, q)
        assert result is not None
        return result

    def delete_period(self, organization_id: Any, year: Any, quarter: Any) -> None:
        y, q = valid_year(year), valid_quarter(quarter)
        with self.connection() as con:
            oid = self._organization(con, organization_id)["id"]
            result = con.execute("DELETE FROM periods WHERE organization_id=? AND year=? AND quarter=?", (oid, y, q))
            if not result.rowcount:
                raise NotFoundError("Этот квартал ещё не сохранён.")

    @staticmethod
    def _year_revision(con: sqlite3.Connection, oid: int, year: int) -> str:
        """Отпечаток защищает год от незаметной перезаписи из другого окна."""
        category_rows = con.execute("""SELECT id,name,tag,source_row,position,archived,export_key
                                     FROM categories WHERE organization_id=? ORDER BY id""", (oid,))
        setting_rows = con.execute("""SELECT s.category_id,s.cost_type,s.vat_rate FROM category_year_settings s
                                     JOIN categories c ON c.id=s.category_id
                                     WHERE c.organization_id=? AND s.year=? ORDER BY s.category_id""", (oid, year))
        fields_sql = ",".join(STORED_FIELDS)
        period_rows = con.execute(f"SELECT quarter,{fields_sql},legacy_manual_deduction FROM periods WHERE organization_id=? AND year=? ORDER BY quarter", (oid, year))
        expense_rows = con.execute("""SELECT p.quarter,e.category_id,e.amount FROM expenses e
                                     JOIN periods p ON p.id=e.period_id
                                     WHERE p.organization_id=? AND p.year=? ORDER BY p.quarter,e.category_id""", (oid, year))
        content = [oid, year, *[[tuple(row) for row in rows] for rows in (category_rows, setting_rows, period_rows, expense_rows)]]
        return hashlib.sha256(json.dumps(content, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()

    @staticmethod
    def _check_revision(con: sqlite3.Connection, oid: int, year: int, expected: Any) -> None:
        if expected is not None and (not isinstance(expected, str) or expected != Store._year_revision(con, oid, year)):
            raise ValueError("Данные этого года изменились в другом окне. Скопируйте несохранённые значения, обновите страницу и повторите действие.")

    def _snapshot(self, organization_id: Any, year: int) -> tuple[dict[str, Any], list[dict[str, Any]], dict[int, dict[int, dict[str, Any]]], dict[tuple[int, int], dict[str, Any]], str]:
        """Согласованный снимок истории, разметки и версии выбранного года."""
        with self.connection() as con:
            con.execute("BEGIN")
            organization = dict(self._organization(con, organization_id))
            oid = organization["id"]
            categories = [dict(r) for r in con.execute("SELECT * FROM categories WHERE organization_id=? ORDER BY position,id", (oid,))]
            settings = {(r["year"], r["category_id"]): dict(r) for r in con.execute(
                """SELECT s.* FROM category_year_settings s JOIN categories c ON c.id=s.category_id
                   WHERE c.organization_id=?""", (oid,))}
            rows = list(con.execute("SELECT * FROM periods WHERE organization_id=? ORDER BY year,quarter", (oid,)))
            all_expenses = con.execute("""SELECT e.period_id,e.category_id,e.amount FROM expenses e
                                        JOIN periods p ON p.id=e.period_id WHERE p.organization_id=?""", (oid,))
            expense_map: dict[int, dict[int, Decimal]] = {}
            for row in all_expenses:
                expense_map.setdefault(row["period_id"], {})[row["category_id"]] = Decimal(row["amount"])
            history: dict[int, dict[int, dict[str, Any]]] = {}
            for row in rows:
                expenses = expense_map.get(row["id"], {})
                inputs = {key: Decimal(row[key]) for key in INPUT_FIELDS}
                history.setdefault(row["year"], {})[row["quarter"]] = {
                    "quarter": row["quarter"], "inputs": inputs, "expenses": expenses,
                    "legacy_manual_deduction": row["legacy_manual_deduction"],
                }
            revision = self._year_revision(con, oid, year)
        return organization, categories, history, settings, revision

    @staticmethod
    def _calculate_periods(periods: dict[int, dict[str, Any]]) -> tuple[list[dict[str, Decimal | None]], dict[str, Decimal | None]]:
        values = [(periods[q]["inputs"], periods[q]["expenses"].values()) if q in periods else None for q in range(1, 5)]
        return calculate_periods(values)

    @staticmethod
    def _summarize(organization: dict[str, Any], y: int, categories: list[dict[str, Any]],
                   history: dict[int, dict[int, dict[str, Any]]], settings: dict[tuple[int, int], dict[str, Any]],
                   statuses: dict[int, str] | None = None) -> dict[str, Any]:
        selected = history.get(y, {})
        effective_categories = []
        for category in categories:
            setting = settings.get((y, category["id"]))
            if setting is None:
                try:
                    rate = valid_vat_rate(category["tag"])
                except ValueError:
                    rate = None  # Старая произвольная метка не угадывается как ставка.
                kind = "unclassified"
            else:
                rate, kind = setting["vat_rate"], setting["cost_type"]
            effective_categories.append({**category, "vat_rate": rate, "cost_type": kind})
        classification = {cat["id"]: cat["cost_type"] for cat in effective_categories}
        calculated, annual = Store._calculate_periods(selected)
        quarters = []
        for q in range(1, 5):
            item = selected.get(q)
            metrics = calculated[q - 1]
            quarters.append({"quarter": q, "exists": item is not None,
                             "state": (statuses or {}).get(q, "saved" if item else "empty"),
                             "legacy_manual_deduction": item.get("legacy_manual_deduction") if item else None,
                             "metrics": metrics if item else None,
                             "analysis": period_analysis(metrics, item["expenses"], classification) if item else None})
        detail = []
        totals_by_category: dict[int, Decimal] = {}
        for category in effective_categories:
            by_quarter = [selected[q]["expenses"].get(category["id"], ZERO) if q in selected else None for q in range(1, 5)]
            with localcontext() as context:
                context.prec = 40
                category_total = sum((n for n in by_quarter if n is not None), ZERO)
            totals_by_category[category["id"]] = category_total
            detail.append({**category, "quarters": by_quarter, "total": category_total})
        year_history = [{"year": hy, "quarters": sorted(periods), "count": len(periods),
                         "annual": Store._calculate_periods(periods)[1]}
                        for hy, periods in sorted(history.items()) if periods]
        previous = history.get(y - 1, {})
        compare_quarters = sorted(selected)
        comparable = None
        if compare_quarters and all(q in previous for q in compare_quarters):
            previous_metrics, _ = Store._calculate_periods(previous)
            comparable = {"year": y - 1, "quarters": compare_quarters,
                          "annual": calculate_year(previous_metrics[q - 1] for q in compare_quarters)}
        return {"organization": organization, "year": y, "quarter_count": len(selected),
                "quarters": quarters, "annual": annual, "expenses": detail,
                "analysis": period_analysis(annual, totals_by_category, classification) if selected else None,
                "expense_structure": expense_structure(detail, annual, quarters, has_periods=bool(selected)),
                "history": year_history, "comparison": comparable}

    def summary(self, organization_id: Any, year: Any) -> dict[str, Any]:
        y = valid_year(year)
        organization, categories, history, settings, revision = self._snapshot(organization_id, y)
        result = self._summarize(organization, y, categories, history, settings)
        result["revision"] = revision
        return result

    @staticmethod
    def _parse_settings(raw: Any, categories: dict[int, Any]) -> dict[int, dict[str, Any]]:
        if not isinstance(raw, dict) or len(raw) > 1000:
            raise ValueError("Некорректные настройки статей затрат.")
        result: dict[int, dict[str, Any]] = {}
        for key, item in raw.items():
            cid = valid_id(key, "Статья затрат")
            if cid in result or cid not in categories or not isinstance(item, dict):
                raise ValueError("Некорректная статья затрат в настройках.")
            kind = item.get("cost_type")
            if kind not in COST_TYPES:
                raise ValueError("Выберите тип затрат: постоянные, переменные или не определён.")
            result[cid] = {"cost_type": kind, "vat_rate": valid_vat_rate(item.get("vat_rate"))}
        return result

    @staticmethod
    def _prepare_quarters(raw: Any, existing: set[int], *, allow_incomplete: bool) -> tuple[dict[int, tuple[dict[str, Decimal], dict[int, Decimal]]], dict[int, str]]:
        if not isinstance(raw, dict) or set(raw) != {"1", "2", "3", "4"}:
            raise ValueError("Необходимо передать все четыре квартала.")
        prepared: dict[int, tuple[dict[str, Decimal], dict[int, Decimal]]] = {}
        statuses: dict[int, str] = {}
        for q in range(1, 5):
            item = raw[str(q)]
            if not isinstance(item, dict) or not isinstance(item.get("inputs"), dict) or not isinstance(item.get("expenses"), dict):
                raise ValueError(f"Некорректные данные {q} квартала.")
            inputs, expenses = item["inputs"], item["expenses"]
            if set(inputs) - set(INPUT_FIELDS):
                raise ValueError(f"Неизвестный показатель {q} квартала.")
            has_value = any(value is not None and str(value).strip() != "" for value in [*inputs.values(), *expenses.values()])
            if not has_value and q not in existing:
                statuses[q] = "empty"
                continue
            missing = [INPUT_LABELS[key] for key in INPUT_FIELDS if inputs.get(key) is None or str(inputs.get(key)).strip() == ""]
            if missing:
                statuses[q] = "incomplete"
                if not allow_incomplete:
                    raise ValueError(f"{q} квартал: заполните «{missing[0]}» или введите 0. Для удаления квартала используйте отдельную кнопку.")
                continue
            try:
                prepared[q] = Store._prepare_period(inputs, expenses)
            except ValueError as exc:
                raise ValueError(f"{q} квартал: {exc}") from exc
            statuses[q] = "ready"
        return prepared, statuses

    def preview_year(self, organization_id: Any, year: Any, quarters: Any, raw_settings: Any) -> dict[str, Any]:
        y = valid_year(year)
        organization, categories, history, settings, revision = self._snapshot(organization_id, y)
        cat_map = {c["id"]: c for c in categories}
        parsed_settings = self._parse_settings(raw_settings, cat_map)
        existing = set(history.get(y, {}))
        prepared, statuses = self._prepare_quarters(quarters, existing, allow_incomplete=True)
        for cid, setting in parsed_settings.items():
            settings[(y, cid)] = setting
        selected: dict[int, dict[str, Any]] = {}
        for q, (values, expenses) in prepared.items():
            if not set(expenses).issubset(cat_map):
                raise ValueError("В затратах есть статья другой организации.")
            # Если архивная статья не видна в форме, сохраняем её прежнюю сумму.
            for cid, amount in history.get(y, {}).get(q, {}).get("expenses", {}).items():
                if cid not in expenses and cat_map[cid]["archived"]:
                    expenses[cid] = amount
            selected[q] = {"quarter": q, "inputs": values, "expenses": expenses,
                           "legacy_manual_deduction": history.get(y, {}).get(q, {}).get("legacy_manual_deduction")}
        history[y] = selected
        result = self._summarize(organization, y, categories, history, settings, statuses)
        result["revision"] = revision
        return result

    def save_year(self, organization_id: Any, year: Any, quarters: Any, raw_settings: Any,
                  *, expected_revision: Any = None) -> dict[str, Any]:
        y = valid_year(year)
        with self.connection() as con:
            con.execute("BEGIN IMMEDIATE")
            oid = self._organization(con, organization_id)["id"]
            self._check_revision(con, oid, y, expected_revision)
            categories = {row["id"]: row for row in con.execute("SELECT id,archived FROM categories WHERE organization_id=?", (oid,))}
            existing = {row[0] for row in con.execute("SELECT quarter FROM periods WHERE organization_id=? AND year=?", (oid, y))}
            parsed_settings = self._parse_settings(raw_settings, categories)
            prepared, _ = self._prepare_quarters(quarters, existing, allow_incomplete=False)
            for q, (values, expenses) in prepared.items():
                self._put_period(con, oid, y, q, values, expenses, categories)
            con.executemany("""INSERT INTO category_year_settings(category_id,year,cost_type,vat_rate) VALUES(?,?,?,?)
                ON CONFLICT(category_id,year) DO UPDATE SET cost_type=excluded.cost_type,vat_rate=excluded.vat_rate""",
                [(cid, y, setting["cost_type"], setting["vat_rate"]) for cid, setting in parsed_settings.items()])
        return self.summary(oid, y)


    @staticmethod
    def _map_import_categories(existing: list[dict[str, Any]], incoming: list[dict[str, Any]]) -> list[int | None]:
        by_key = {cat["export_key"]: cat for cat in existing if cat.get("export_key")}
        used: set[int] = set()
        result: list[int | None] = []
        for item in incoming:
            key, name = item.get("export_key"), item["name"]
            match = by_key.get(key) if key else None
            if match and match["name"].strip().casefold() != name.strip().casefold():
                raise ValueError(f"Статья «{name}» не совпадает с сохранённой статьёй для того же идентификатора.")
            if not key:
                candidates = []
                for cat in existing:
                    if cat["id"] in used or cat["name"].strip().casefold() != name.strip().casefold():
                        continue
                    try:
                        default_rate = valid_vat_rate(cat["tag"])
                    except ValueError:
                        default_rate = None
                    if default_rate == item.get("vat_rate"):
                        candidates.append(cat)
                if len(candidates) > 1:
                    raise ValueError(f"Неоднозначная статья «{name}»: несколько совпадений. Используйте экспорт программы с идентификаторами.")
                match = candidates[0] if candidates else None
            if match:
                if match["id"] in used:
                    raise ValueError(f"Статья «{name}» сопоставлена дважды.")
                used.add(match["id"])
                result.append(match["id"])
            else:
                result.append(None)
        return result

    def import_plan(self, organization_id: Any, year: Any, report: dict[str, Any]) -> dict[str, Any]:
        y = valid_year(year)
        organization, categories, history, _, revision = self._snapshot(organization_id, y)
        incoming = report["categories"]
        mapping = self._map_import_categories(categories, incoming)
        q_file = sorted(report["quarters"])
        existing = set(history.get(y, {}))
        metadata = report.get("metadata", {})
        return {"organization": organization, "year": y, "sheet": report["sheet"], "metadata": metadata, "revision": revision,
                "quarters": q_file, "existing_quarters": sorted(existing.intersection(q_file)),
                "all_existing_quarters": sorted(existing), "category_count": len(incoming),
                "new_categories": [item["name"] for item, cid in zip(incoming, mapping) if cid is None],
                "unassigned_types": sum(item.get("cost_type") in (None, "unclassified") for item in incoming),
                "unknown_rates": sum(item.get("vat_rate") is None for item in incoming),
                "legacy_deductions": sum(q.get("legacy_manual_deduction") is not None for q in report["quarters"].values())}

    def import_year(self, organization_id: Any, year: Any, report: dict[str, Any], *,
                    replace_existing: Any, apply_settings: Any, expected_revision: Any = None) -> dict[str, Any]:
        """Импорт одного года атомарен; явный режим не перезаписывает кварталы молча."""
        y = valid_year(year)
        if not isinstance(replace_existing, bool) or not isinstance(apply_settings, bool):
            raise ValueError("Укажите режим замены и применения ставок/типов затрат.")
        with self.connection() as con:
            con.execute("BEGIN IMMEDIATE")
            oid = self._organization(con, organization_id)["id"]
            self._check_revision(con, oid, y, expected_revision)
            existing_rows = [dict(row) for row in con.execute("SELECT * FROM categories WHERE organization_id=? ORDER BY position,id", (oid,))]
            incoming = report["categories"]
            mapping = self._map_import_categories(existing_rows, incoming)
            existing_quarters = {row[0] for row in con.execute("SELECT quarter FROM periods WHERE organization_id=? AND year=?", (oid, y))}
            selected_quarters = [q for q in sorted(report["quarters"]) if replace_existing or q not in existing_quarters]
            if not selected_quarters and not apply_settings:
                raise ValueError("Нет новых кварталов: выберите замену существующих или применение настроек.")
            if len(existing_rows) + sum(cid is None for cid in mapping) > 1000:
                raise ValueError("Импорт превысит предел 1000 статей затрат.")
            position = max((cat["position"] for cat in existing_rows), default=0)
            for index, (item, cid) in enumerate(zip(incoming, mapping)):
                if cid is not None:
                    continue
                position += 1
                key = item.get("export_key") or f"custom:{uuid4().hex}"
                source_row = int(key.split(":", 1)[1]) if key.startswith("source:") else None
                cursor = con.execute("""INSERT INTO categories(organization_id,name,tag,source_row,position,export_key)
                                        VALUES(?,?,?,?,?,?)""", (oid, item["name"], item.get("vat_rate") or "", source_row, position, key))
                mapping[index] = cursor.lastrowid
            categories = {row["id"]: row for row in con.execute("SELECT id,archived FROM categories WHERE organization_id=?", (oid,))}
            imported = []
            for q in selected_quarters:
                item = report["quarters"][q]
                # Явная замена квартала означает замену ВСЕХ статей, даже архивных.
                expense_values = {cid: ZERO for cid in categories}
                expense_values.update({int(cid): amount for cid, amount in zip(mapping, item["expenses"])})
                self._put_period(con, oid, y, q, item["inputs"], expense_values, categories,
                                 legacy_deduction=item.get("legacy_manual_deduction"))
                imported.append(q)
            if apply_settings:
                for item, cid in zip(incoming, mapping):
                    old = con.execute("SELECT cost_type FROM category_year_settings WHERE category_id=? AND year=?", (cid, y)).fetchone()
                    # В исходной книге типа затрат нет — прежний выбор не стираем.
                    kind = item.get("cost_type") or (old["cost_type"] if old else "unclassified")
                    if kind not in COST_TYPES:
                        raise ValueError("Неизвестный тип затрат в книге.")
                    con.execute("""INSERT INTO category_year_settings(category_id,year,cost_type,vat_rate) VALUES(?,?,?,?)
                        ON CONFLICT(category_id,year) DO UPDATE SET cost_type=excluded.cost_type,vat_rate=excluded.vat_rate""",
                        (cid, y, kind, valid_vat_rate(item.get("vat_rate"))))
        return {"imported_quarters": imported, "skipped_quarters": sorted(set(report["quarters"]) - set(imported)),
                "summary": self.summary(oid, y)}


    def backup_bytes(self) -> bytes:
        """Согласованная копия SQLite, включая неприменённый WAL."""
        with tempfile.TemporaryDirectory(prefix="analiz-backup-") as temporary:
            backup_path = Path(temporary) / "backup.sqlite3"
            with self.connection() as source:
                destination = sqlite3.connect(str(backup_path))
                try:
                    source.backup(destination)
                finally:
                    destination.close()
            return backup_path.read_bytes()
