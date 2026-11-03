from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal as D
from pathlib import Path
import sqlite3

import pytest

from analiz.calculations import INPUT_FIELDS
from analiz.store import NotFoundError, Store


def values(**overrides):
    return {field: str(overrides.get(field, 0)) for field in INPUT_FIELDS}


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "data.sqlite3")


def test_initial_database_empty_and_categories_preserved(store):
    assert store.list_organizations() == []
    org = store.create_organization("Организация", "BYN")
    categories = store.categories(org["id"])
    assert len(categories) == 28
    duplicate = [c for c in categories if c["name"] == "комунальные услуги"]
    assert [c["tag"] for c in duplicate] == ["20", "0"]
    assert categories[0]["source_row"] == 20
    assert store.summary(org["id"], 2026)["quarter_count"] == 0


def test_persistence_replacement_and_explicit_empty_quarters(store):
    org = store.create_organization("А")
    oid = org["id"]
    cat = store.categories(oid)[0]["id"]
    store.save_period(oid, 2024, 2, values(retail_revenue="120,00"), {str(cat): "3,50"})
    store.save_period(oid, 2024, 2, values(retail_revenue="240"), {str(cat): "-1"})
    reopened = Store(store.database)
    period = reopened.get_period(oid, 2024, 2)
    assert period["inputs"]["retail_revenue"] == "240"
    assert period["expenses"][str(cat)] == "-1"
    summary = reopened.summary(oid, 2024)
    assert [q["exists"] for q in summary["quarters"]] == [False, True, False, False]
    assert summary["quarter_count"] == 1
    assert summary["annual"]["expense_total"] == -1
    assert summary["annual"]["revenue"] == 240
    assert reopened.get_period(oid, 2024, 1) is None


def test_isolation_and_atomic_failure(store):
    one = store.create_organization("Одна")
    two = store.create_organization("Другая")
    own = store.categories(one["id"])[0]["id"]
    foreign = store.categories(two["id"])[0]["id"]
    store.save_period(one["id"], 2026, 1, values(retail_revenue=120), {str(own): "9"})
    before = store.get_period(one["id"], 2026, 1)
    with pytest.raises(ValueError):
        store.save_period(one["id"], 2026, 1, values(retail_revenue=500), {str(foreign): "99"})
    invalid = values(retail_revenue=200)
    invalid["invoice_vat"] = ""
    with pytest.raises(ValueError):
        store.save_period(one["id"], 2026, 1, invalid, {})
    assert store.get_period(one["id"], 2026, 1) == before
    with store.connection() as con:
        pid = con.execute("SELECT id FROM periods WHERE organization_id=?", (one["id"],)).fetchone()[0]
        with pytest.raises(sqlite3.IntegrityError):
            con.execute("INSERT INTO expenses(period_id,category_id,amount) VALUES (?,?,?)", (pid, foreign, "4"))
    assert store.summary(two["id"], 2026)["quarter_count"] == 0


def test_archived_category_does_not_erase_history_when_omitted(store):
    oid = store.create_organization("Тест")["id"]
    cat = store.add_category(oid, "Проверка", "A")
    store.save_period(oid, 2026, 1, values(), {str(cat["id"]): "12"})
    store.update_category(oid, cat["id"], archived=True)
    store.save_period(oid, 2026, 1, values(retail_revenue=10), {})
    assert store.get_period(oid, 2026, 1)["expenses"][str(cat["id"])] == "12"
    assert store.summary(oid, 2026)["annual"]["expense_total"] == 12
    store.save_period(oid, 2026, 1, values(), {str(cat["id"]): "0"})
    assert str(cat["id"]) not in store.get_period(oid, 2026, 1)["expenses"]


def test_previous_year_compares_exactly_matching_quarters(store):
    oid = store.create_organization("Тест")["id"]
    store.save_period(oid, 2024, 1, values(retail_revenue=100), {})
    store.save_period(oid, 2024, 3, values(retail_revenue=999), {})
    store.save_period(oid, 2025, 1, values(retail_revenue=150), {})
    store.save_period(oid, 2025, 2, values(retail_revenue=200), {})
    assert store.summary(oid, 2025)["comparison"] is None
    store.save_period(oid, 2024, 2, values(retail_revenue=80), {})
    compare = store.summary(oid, 2025)["comparison"]
    assert compare["quarters"] == [1, 2]
    assert compare["annual"]["revenue"] == D("180")  # Исключён 3-й квартал прошлого года.


def test_backup_is_consistent_and_restorable(store, tmp_path):
    oid = store.create_organization("Копия", "ед.")["id"]
    store.save_period(oid, 2030, 4, values(retail_revenue="99.45"), {})
    backup = tmp_path / "restored.sqlite3"
    backup.write_bytes(store.backup_bytes())
    restored = Store(backup)
    assert restored.summary(oid, 2030)["annual"]["revenue"] == D("99.45")
    assert restored.list_organizations()[0]["name"] == "Копия"


def test_validations_and_delete_cascade(store):
    oid = store.create_organization("Тест")["id"]
    for year, quarter in [(1899, 1), (10000, 1), (2026, 0), (2026, 5), (2026, True)]:
        with pytest.raises(ValueError):
            store.save_period(oid, year, quarter, values(), {})
    with pytest.raises(ValueError):
        store.create_organization("  ")
    store.save_period(oid, 2026, 1, values(), {})
    store.delete_period(oid, 2026, 1)
    with pytest.raises(NotFoundError):
        store.delete_period(oid, 2026, 1)
    store.delete_organization(oid)
    assert store.list_organizations() == []
    with store.connection() as con:
        for table in ("categories", "periods", "expenses"):
            assert con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0


def test_large_values_keep_fractional_precision(store):
    oid = store.create_organization("Точность")["id"]
    cid = store.categories(oid)[0]["id"]
    amount = "999999999999999999.12345678"
    for q in range(1, 5):
        store.save_period(oid, 2026, q, values(), {str(cid): amount})
    s = store.summary(oid, 2026)
    assert s["annual"]["expense_total"] == D("3999999999999999996.49382712")
    assert s["expenses"][0]["total"] == D("3999999999999999996.49382712")


def test_parallel_quarter_writes(store):
    oid = store.create_organization("Параллельно")["id"]
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(lambda q: store.save_period(oid, 2026, q, values(retail_revenue=q * 100), {}), range(1, 5)))
    summary = store.summary(oid, 2026)
    assert summary["quarter_count"] == 4
    assert summary["annual"]["revenue"] == 1000
