"""Сверка ВСЕХ 84 формул актуальной книги с кэшем Excel; денежные данные не публикуются."""
from decimal import Decimal
from hashlib import sha256
from pathlib import Path

from openpyxl import load_workbook

from analiz.calculations import calculate_periods
from analiz.store import DEFAULT_CATEGORIES
from scripts.audit_workbook import build_inventory

ROOT = Path(__file__).resolve().parent.parent
OLD = ROOT / 'ОТЧЕТ ПО ОРГАНИЗАЦИИ мир.xlsx'
SOURCE = ROOT / 'ОТЧЕТ ПО ОРГАНИЗАЦИИ мир 2.xlsx'
INPUT_ROWS = {'retail_revenue': 8, 'invoice_revenue': 9, 'invoice_vat': 12,
              'non_vat_sales': 14, 'input_vat': 16, 'cost_of_sales': 18}
OUTPUT_ROWS = {4: 'vat_due', 5: 'profit_tax', 6: 'profit', 7: 'net_profit',
               8: 'retail_revenue', 9: 'invoice_revenue', 10: 'revenue', 11: 'retail_vat',
               12: 'invoice_vat', 13: 'output_vat', 14: 'non_vat_sales', 15: 'non_vat_deduction',
               16: 'input_vat', 17: 'adjusted_input_vat', 18: 'cost_of_sales', 19: 'expense_total'}
FORMULA_Q_ROWS = (4, 5, 6, 7, 10, 11, 13, 15, 17, 19)


def as_decimal(value):
    return Decimal(str(value if value is not None else 0))


def assert_cached(actual, expected, coordinate):
    assert expected is not None, f'Кэш Excel отсутствует: {coordinate}'
    if abs(actual - as_decimal(expected)) >= Decimal('0.000001'):
        # Не выводим реальные суммы из исходной книги в CI-логи.
        raise AssertionError(f'Расхождение с кэшем Excel: {coordinate}')


def test_both_source_fingerprints_and_documented_inventories():
    assert sha256(OLD.read_bytes()).hexdigest() == 'fa3d8385a33d4b6d6eea999224c370f0349d8b9a52db89269b06507848e52991'
    assert sha256(SOURCE.read_bytes()).hexdigest() == '124682e1af1dff791cccdbce119814d16cd04c5c54f52e691bfd730c6d477afd'
    assert build_inventory(OLD) == (ROOT / 'docs' / 'workbook-formulas.md').read_text(encoding='utf-8')
    assert build_inventory(SOURCE) == (ROOT / 'docs' / 'workbook-2-formulas.md').read_text(encoding='utf-8')


def test_formula_diff_between_sources_is_only_quarterly_deduction():
    old, new = load_workbook(OLD), load_workbook(SOURCE)
    try:
        assert old.sheetnames == new.sheetnames == ['Лист1']
        previous, current = old.active, new.active
        assert sum(c.data_type == 'f' for row in previous for c in row) == 80
        assert sum(c.data_type == 'f' for row in current for c in row) == 84
        differences = {current.cell(r, c).coordinate for r in range(1, max(previous.max_row, current.max_row) + 1)
                       for c in range(1, max(previous.max_column, current.max_column) + 1)
                       if previous.cell(r, c).value != current.cell(r, c).value}
        assert differences == {'D15', 'E15', 'F15', 'G15'}
        assert [current[f'{col}15'].value for col in 'DEFGH'] == [
            '=D16/D10*D14',
            '=(D16+E16)/(D10+E10)*(D14+E14)-D15',
            '=(D16+E16+F16)/(D10+E10+F10)*(D14+E14+F14)-D15-E15',
            '=H15-F15-E15-D15', '=H14/H10*H16',
        ]
    finally:
        old.close(); new.close()


def test_all_84_new_workbook_formulas_against_cached_excel_results():
    formulas = load_workbook(SOURCE, data_only=False)
    cached = load_workbook(SOURCE, data_only=True)
    try:
        sheet, values = formulas.active, cached.active
        assert [(r, sheet.cell(r, 2).value, str(sheet.cell(r, 3).value)) for r in range(20, 48)] == list(DEFAULT_CATEGORIES)
        inputs = []
        for col in range(4, 8):
            fields = {key: as_decimal(values.cell(row, col).value) for key, row in INPUT_ROWS.items()}
            expenses = [as_decimal(values.cell(row, col).value) for row in range(20, 56)]
            inputs.append((fields, expenses))
        periods, annual = calculate_periods(inputs)
        covered = set()
        for col, quarter in enumerate(periods, start=4):
            for row in FORMULA_Q_ROWS:
                cell = sheet.cell(row, col)
                assert cell.data_type == 'f'
                assert_cached(quarter[OUTPUT_ROWS[row]], values.cell(row, col).value, cell.coordinate)
                covered.add(cell.coordinate)
        for row, key in OUTPUT_ROWS.items():
            cell = sheet.cell(row, 8)
            assert cell.data_type == 'f'
            assert_cached(annual[key], values.cell(row, 8).value, cell.coordinate)
            covered.add(cell.coordinate)
        for row in range(20, 48):
            cell = sheet.cell(row, 8)
            assert cell.data_type == 'f'
            total = sum((as_decimal(values.cell(row, col).value) for col in range(4, 8)), Decimal(0))
            assert_cached(total, values.cell(row, 8).value, cell.coordinate)
            covered.add(cell.coordinate)
        assert covered == {cell.coordinate for row in sheet for cell in row if cell.data_type == 'f'}
        assert len(covered) == 84  # 40 квартальных + 44 годовых, ничего не пропущено
        assert sheet['H17'].value == '=D17+E17+F17+G17'
        assert all(sheet.cell(row, 8).value is None for row in range(48, 56))
        assert not formulas.defined_names and not formulas._external_links
    finally:
        formulas.close(); cached.close()
