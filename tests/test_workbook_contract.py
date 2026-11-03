"""Сравнение ВСЕХ 80 формул с сохранённым кэшем Excel без импорта данных в БД."""
from decimal import Decimal
from hashlib import sha256
from pathlib import Path

import pytest
from openpyxl import load_workbook

from analiz.calculations import calculate_quarter, calculate_year
from analiz.store import DEFAULT_CATEGORIES
from scripts.audit_workbook import build_inventory

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "ОТЧЕТ ПО ОРГАНИЗАЦИИ мир.xlsx"
EXPECTED_SHA256 = "fa3d8385a33d4b6d6eea999224c370f0349d8b9a52db89269b06507848e52991"
INPUT_ROWS = {"retail_revenue": 8, "invoice_revenue": 9, "invoice_vat": 12,
              "non_vat_sales": 14, "non_vat_deduction": 15, "input_vat": 16, "cost_of_sales": 18}
OUTPUT_ROWS = {4: "vat_due", 5: "profit_tax", 6: "profit", 7: "net_profit",
               8: "retail_revenue", 9: "invoice_revenue", 10: "revenue", 11: "retail_vat",
               12: "invoice_vat", 13: "output_vat", 14: "non_vat_sales", 15: "non_vat_deduction",
               16: "input_vat", 17: "adjusted_input_vat", 18: "cost_of_sales", 19: "expense_total"}
FORMULA_Q_ROWS = (4, 5, 6, 7, 10, 11, 13, 17, 19)


def as_decimal(value):
    return Decimal(str(value if value is not None else 0))


def assert_cached(actual, expected, coordinate):
    assert expected is not None, f"Кэш Excel отсутствует: {coordinate}"
    assert abs(actual - as_decimal(expected)) < Decimal("0.000001"), coordinate


def test_source_fingerprint_and_documented_inventory():
    assert sha256(SOURCE.read_bytes()).hexdigest() == EXPECTED_SHA256, "Книга изменилась: повторно исследуйте формулы, не обновляйте хэш вслепую."
    assert build_inventory(SOURCE) == (ROOT / "docs" / "workbook-formulas.md").read_text(encoding="utf-8")


def test_all_workbook_formulas_against_cached_excel_results():
    formulas = load_workbook(SOURCE, data_only=False)
    cached = load_workbook(SOURCE, data_only=True)
    try:
        assert formulas.sheetnames == ["Лист1"]
        sheet, values = formulas.active, cached.active
        assert sum(cell.data_type == "f" for row in sheet for cell in row) == 80
        assert [(row, sheet.cell(row, 2).value, str(sheet.cell(row, 3).value)) for row in range(20, 48)] == list(DEFAULT_CATEGORIES)
        calculated = []
        covered = set()
        for col in range(4, 8):
            ins = {field: as_decimal(values.cell(row, col).value) for field, row in INPUT_ROWS.items()}
            expenses = [as_decimal(values.cell(row, col).value) for row in range(20, 56)]
            quarter = calculate_quarter(ins, expenses)
            calculated.append(quarter)
            for row in FORMULA_Q_ROWS:
                cell = sheet.cell(row, col)
                assert cell.data_type == "f"
                assert_cached(quarter[OUTPUT_ROWS[row]], values.cell(row, col).value, cell.coordinate)
                covered.add(cell.coordinate)
        annual = calculate_year(calculated)
        for row, key in OUTPUT_ROWS.items():
            cell = sheet.cell(row, 8)
            assert cell.data_type == "f"
            assert_cached(annual[key], values.cell(row, 8).value, cell.coordinate)
            covered.add(cell.coordinate)
        for row in range(20, 48):
            cell = sheet.cell(row, 8)
            assert cell.data_type == "f"
            total = sum((as_decimal(values.cell(row, col).value) for col in range(4, 8)), Decimal(0))
            assert_cached(total, values.cell(row, 8).value, cell.coordinate)
            covered.add(cell.coordinate)
        all_formulas = {cell.coordinate for row in sheet for cell in row if cell.data_type == "f"}
        assert covered == all_formulas  # 36 квартальных + 44 годовых, ни одна формула не пропущена.
        assert sheet["H15"].value == "=H14/H10*H16"
        assert sheet["H17"].value == "=D17+E17+F17+G17"
        assert all(sheet.cell(row, 8).value is None for row in range(48, 56))
        assert not formulas.defined_names and not formulas._external_links
    finally:
        formulas.close()
        cached.close()
