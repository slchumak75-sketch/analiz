"""SQLite-хранилище, проверки ввода и агрегаты для интерфейса.

Суммы хранятся строками Decimal. В БД нет исходных значений из Excel: создаются
только организации и периоды, которые пользователь явно ввёл самостоятельно.
"""
from __future__ import annotations

from contextlib import contextmanager
from decimal import Decimal, localcontext
from pathlib import Path
import sqlite3
import tempfile
from typing import Any, Iterator

from .calculations import INPUT_FIELDS, ZERO, calculate_quarter, calculate_year, decimal_text, parse_amount

SCHEMA_VERSION = 1
INPUT_LABELS = {
    "retail_revenue": "Выручка ККМ с НДС",
    "invoice_revenue": "Реализация по накладным с НДС",
    "invoice_vat": "НДС реализации по накладным",
    "non_vat_sales": "Товары реализации без НДС",
    "non_vat_deduction": "Вычет по товарам без НДС",
    "input_vat": "Входящий НДС",
    "cost_of_sales": "Себестоимость реализации без НДС",
}

# Названия и значения из B20:C47 сохранены буквально. Столбец C не имеет
# заголовка и нигде не используется в формулах — это НЕ ставка НДС в коде.
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

    def _initialise(self) -> None:
        with self.connection() as con:
            version = con.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise RuntimeError("База создана более новой версией программы. Обновите приложение и сохраните копию базы.")
            if version == 0:
                con.executescript("""
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
                """)
            con.execute("PRAGMA journal_mode = WAL")

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
            con.executemany("""INSERT INTO categories(organization_id, name, tag, source_row, position)
                               VALUES (?, ?, ?, ?, ?)""",
                            [(oid, name, tag, row, row) for row, name, tag in DEFAULT_CATEGORIES])
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

    def add_category(self, organization_id: Any, name: Any, tag: Any = "") -> dict[str, Any]:
        name = clean_text(name, "Статья затрат", 120)
        tag = clean_text(tag, "Метка", 40, required=False)
        with self.connection() as con:
            oid = self._organization(con, organization_id)["id"]
            position = con.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM categories WHERE organization_id=?", (oid,)).fetchone()[0]
            cursor = con.execute("INSERT INTO categories(organization_id,name,tag,position) VALUES(?,?,?,?)", (oid, name, tag, position))
            return dict(con.execute("SELECT * FROM categories WHERE id=?", (cursor.lastrowid,)).fetchone())

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

    def get_period(self, organization_id: Any, year: Any, quarter: Any) -> dict[str, Any] | None:
        y, q = valid_year(year), valid_quarter(quarter)
        with self.connection() as con:
            oid = self._organization(con, organization_id)["id"]
            row = con.execute("SELECT * FROM periods WHERE organization_id=? AND year=? AND quarter=?", (oid, y, q)).fetchone()
            if row is None:
                return None
            expenses = {str(r["category_id"]): r["amount"] for r in con.execute(
                "SELECT category_id, amount FROM expenses WHERE period_id=?", (row["id"],))}
            return {"year": y, "quarter": q, "inputs": {key: row[key] for key in INPUT_FIELDS},
                    "expenses": expenses, "updated_at": row["updated_at"]}

    def save_period(self, organization_id: Any, year: Any, quarter: Any,
                    inputs: Any, expenses: Any) -> dict[str, Any]:
        y, q = valid_year(year), valid_quarter(quarter)
        if not isinstance(inputs, dict) or not isinstance(expenses, dict):
            raise ValueError("Нужны показатели и список затрат квартала.")
        unknown_inputs = set(inputs) - set(INPUT_FIELDS)
        if unknown_inputs:
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
        with self.connection() as con:
            oid = self._organization(con, organization_id)["id"]
            categories = {row["id"]: row for row in con.execute(
                "SELECT id, archived FROM categories WHERE organization_id=?", (oid,))}
            if not set(expense_values).issubset(categories):
                raise ValueError("В списке затрат есть статья другой организации или удалённая статья.")
            fields_sql = ", ".join(INPUT_FIELDS)
            placeholders = ", ".join("?" for _ in INPUT_FIELDS)
            updates = ", ".join(f"{field}=excluded.{field}" for field in INPUT_FIELDS)
            con.execute(f"""INSERT INTO periods(organization_id,year,quarter,{fields_sql})
                VALUES (?,?,?,{placeholders}) ON CONFLICT(organization_id,year,quarter)
                DO UPDATE SET {updates}, updated_at=CURRENT_TIMESTAMP""",
                (oid, y, q, *(decimal_text(values[field]) for field in INPUT_FIELDS)))
            pid = con.execute("SELECT id FROM periods WHERE organization_id=? AND year=? AND quarter=?", (oid, y, q)).fetchone()[0]
            # Не стирать архивные статьи, которые старая форма не отправила.
            replace_ids = {cid for cid, cat in categories.items() if not cat["archived"]} | set(expense_values)
            if replace_ids:
                con.executemany("DELETE FROM expenses WHERE period_id=? AND category_id=?", [(pid, cid) for cid in replace_ids])
            con.executemany("INSERT INTO expenses(period_id,category_id,amount) VALUES(?,?,?)",
                            [(pid, cid, decimal_text(value)) for cid, value in expense_values.items() if value != ZERO])
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

    def summary(self, organization_id: Any, year: Any) -> dict[str, Any]:
        y = valid_year(year)
        with self.connection() as con:
            organization = dict(self._organization(con, organization_id))
            oid = organization["id"]
            categories = [dict(r) for r in con.execute(
                "SELECT * FROM categories WHERE organization_id=? ORDER BY position,id", (oid,))]
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
                metrics = calculate_quarter(inputs, expenses.values())
                history.setdefault(row["year"], {})[row["quarter"]] = {
                    "quarter": row["quarter"], "metrics": metrics, "expenses": expenses,
                }

        selected = history.get(y, {})
        annual = calculate_year(item["metrics"] for item in selected.values())
        quarters = [{"quarter": q, "exists": q in selected,
                     "metrics": selected[q]["metrics"] if q in selected else None} for q in range(1, 5)]
        detail = []
        for category in categories:
            by_quarter = [selected[q]["expenses"].get(category["id"], ZERO) if q in selected else None
                          for q in range(1, 5)]
            with localcontext() as context:
                context.prec = 40
                category_total = sum((n for n in by_quarter if n is not None), ZERO)
            detail.append({**category, "quarters": by_quarter, "total": category_total})
        year_history = [{"year": history_year, "quarters": sorted(periods), "count": len(periods),
                         "annual": calculate_year(item["metrics"] for item in periods.values())}
                        for history_year, periods in sorted(history.items())]
        previous = history.get(y - 1, {})
        compare_quarters = sorted(selected)
        comparable = None
        if compare_quarters and all(q in previous for q in compare_quarters):
            comparable = {"year": y - 1, "quarters": compare_quarters,
                          "annual": calculate_year(previous[q]["metrics"] for q in compare_quarters)}
        return {"organization": organization, "year": y, "quarter_count": len(selected),
                "quarters": quarters, "annual": annual, "expenses": detail,
                "history": year_history, "comparison": comparable}

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
