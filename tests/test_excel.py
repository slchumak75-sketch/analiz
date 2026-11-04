from decimal import Decimal as D
from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from openpyxl import load_workbook

from analiz.calculations import INPUT_FIELDS
from analiz.excel import make_report, parse_report
from analiz.store import Store

ROOT = Path(__file__).resolve().parent.parent


def values(**kwargs):
    return {key: str(kwargs.get(key, 0)) for key in INPUT_FIELDS}


def quarters():
    return {str(q): {'inputs': {}, 'expenses': {}} for q in range(1, 5)}


def test_original_book_import_requires_selected_year_and_preserves_25(tmp_path):
    report = parse_report((ROOT / 'ОТЧЕТ ПО ОРГАНИЗАЦИИ мир.xlsx').read_bytes())
    assert sorted(report['quarters']) == [1, 2, 3] and report['metadata'] == {}
    assert next(c['vat_rate'] for c in report['categories'] if c['row'] == 31) == '25'
    store = Store(tmp_path / 'data.sqlite3')
    oid = store.create_organization('Выбрана пользователем')['id']
    plan = store.import_plan(oid, 2024, report)
    assert plan['quarters'] == [1, 2, 3] and plan['new_categories'] == []
    result = store.import_year(oid, 2024, report, replace_existing=False, apply_settings=True)
    assert result['imported_quarters'] == [1, 2, 3]
    assert result['summary']['quarter_count'] == 3
    assert result['summary']['quarters'][3]['state'] == 'empty'
    assert next(c['vat_rate'] for c in result['summary']['expenses'] if c['source_row'] == 31) == '25'
    assert store.summary(oid, 2025)['quarter_count'] == 0


def test_roundtrip_export_excel_with_formulas_charts_and_custom_categories(tmp_path):
    store = Store(tmp_path / 'one.sqlite3')
    oid = store.create_organization('=Формула не выполняется', 'BYN')['id']
    first = store.categories(oid)[0]
    custom = store.add_category(oid, '=Реклама', '20')
    q = quarters()
    q['1'] = {'inputs': values(retail_revenue=120, cost_of_sales=50), 'expenses': {str(first['id']): '20', str(custom['id']): '10'}}
    q['3'] = {'inputs': values(retail_revenue=240, cost_of_sales=100), 'expenses': {str(first['id']): '20', str(custom['id']): '20'}}
    settings = {str(first['id']): {'cost_type': 'fixed', 'vat_rate': '0'}, str(custom['id']): {'cost_type': 'variable', 'vat_rate': '20'}}
    original = store.save_year(oid, 2030, q, settings)
    data = make_report(original)
    wb = load_workbook(BytesIO(data), data_only=False)
    try:
        assert wb['Лист1']['H15'].value == '=H14/H10*H16'
        assert wb['Лист1']['D13'].value == '=D10-D14-(D10-D14)/1.2'
        assert wb['Лист1']['D8'].value == 120
        assert wb['Лист1']['E8'].value is None
        assert wb['__ANALIZ_META__'].sheet_state == 'hidden'
        assert len(wb['Аналитика']._charts) == 2
        custom_row = 19 + len(original['expenses'])
        assert wb['Лист1'].cell(custom_row, 2).data_type == 's'  # формула из названия не исполняется
        assert wb['Лист1'].cell(custom_row, 9).value == 'Переменные'
    finally:
        wb.close()
    report = parse_report(data)
    assert report['metadata']['year'] == '2030'
    assert sorted(report['quarters']) == [1, 3]
    destination = Store(tmp_path / 'two.sqlite3')
    dest_id = destination.create_organization('Другая организация')['id']
    plan = destination.import_plan(dest_id, 2030, report)
    assert '=Реклама' in plan['new_categories']
    imported = destination.import_year(dest_id, 2030, report, replace_existing=False, apply_settings=True)['summary']
    assert imported['annual']['revenue'] == original['annual']['revenue']
    assert imported['annual']['expense_total'] == original['annual']['expense_total']
    assert imported['analysis']['break_even_revenue'] == original['analysis']['break_even_revenue']
    dest_custom = next(c for c in imported['expenses'] if c['name'] == '=Реклама')
    assert dest_custom['cost_type'] == 'variable' and dest_custom['vat_rate'] == '20'


def test_import_skip_replace_and_no_overwrite_of_other_quarters(tmp_path):
    s = Store(tmp_path / 'db.sqlite3')
    source = s.create_organization('Источник')['id']
    target = s.create_organization('Приёмник')['id']
    s.save_period(source, 2026, 1, values(retail_revenue=120), {})
    s.save_period(source, 2026, 3, values(retail_revenue=360), {})
    report = parse_report(make_report(s.summary(source, 2026)))
    s.save_period(target, 2026, 1, values(retail_revenue=999), {})
    s.save_period(target, 2026, 4, values(retail_revenue=400), {})
    plan = s.import_plan(target, 2026, report)
    assert plan['existing_quarters'] == [1]
    out = s.import_year(target, 2026, report, replace_existing=False, apply_settings=False)
    assert out['imported_quarters'] == [3] and out['skipped_quarters'] == [1]
    assert D(s.get_period(target, 2026, 1)['inputs']['retail_revenue']) == 999
    out = s.import_year(target, 2026, report, replace_existing=True, apply_settings=True)
    assert out['imported_quarters'] == [1, 3]
    assert D(s.get_period(target, 2026, 1)['inputs']['retail_revenue']) == 120
    assert D(s.get_period(target, 2026, 4)['inputs']['retail_revenue']) == 400


def test_bad_workbooks_and_formulas_in_input_are_rejected(tmp_path):
    with pytest.raises(ValueError):
        parse_report(b'not a zip')
    source = ROOT / 'ОТЧЕТ ПО ОРГАНИЗАЦИИ мир.xlsx'
    wb = load_workbook(source)
    wb.active['D8'] = '=1+1'
    out = BytesIO(); wb.save(out); wb.close()
    with pytest.raises(ValueError, match='D8.*формул'):
        parse_report(out.getvalue())
    with ZipFile(source) as old:
        out = BytesIO()
        with ZipFile(out, 'w', ZIP_DEFLATED) as new:
            for item in old.infolist():
                new.writestr(item.filename, old.read(item.filename))
            new.writestr('xl/externalLinks/externalLink1.xml', '<test/>')
    with pytest.raises(ValueError, match='внешними связями'):
        parse_report(out.getvalue())


def test_excel_does_not_silently_lose_input_precision(tmp_path):
    s = Store(tmp_path / 'db.sqlite3')
    oid = s.create_organization('Точность')['id']
    s.save_period(oid, 2026, 1, values(retail_revenue='1234567890.12345678'), {})
    with pytest.raises(ValueError, match='15 значащих цифр'):
        make_report(s.summary(oid, 2026))


def test_many_expense_rows_parse_in_one_pass(tmp_path):
    """Линейное чтение read_only листа; без тысяч повторных разборов XML."""
    import time
    s = Store(tmp_path / 'db.sqlite3')
    oid = s.create_organization('Много статей')['id']
    # Быстрая синтетическая подготовка БД, не входят в репозиторий/демо-данные.
    with s.connection() as con:
        rows = [(oid, f'Статья {i}', '', 1000 + i, f'custom:{i:032x}') for i in range(350)]
        con.executemany('INSERT INTO categories(organization_id,name,tag,position,export_key) VALUES(?,?,?,?,?)', rows)
    s.save_period(oid, 2026, 1, values(retail_revenue=120), {})
    data = make_report(s.summary(oid, 2026))
    started = time.monotonic()
    report = parse_report(data)
    assert len(report['categories']) == 378
    # Щедрый предел для Windows CI; квадратичное чтение занимает минуты.
    assert time.monotonic() - started < 15


@pytest.mark.parametrize('value,number_format', [(25, r'0\%'), (25, '0"%"'), (0.25, '0%')])
def test_excel_percentage_formats_preserve_the_intended_vat_rate(value, number_format):
    wb = load_workbook(ROOT / 'ОТЧЕТ ПО ОРГАНИЗАЦИИ мир.xlsx')
    wb.active['C31'] = value
    wb.active['C31'].number_format = number_format
    out = BytesIO(); wb.save(out); wb.close()
    report = parse_report(out.getvalue())
    assert next(cat['vat_rate'] for cat in report['categories'] if cat['row'] == 31) == '25'


def test_old_and_new_source_deduction_import_is_history_only():
    old = parse_report((ROOT / 'ОТЧЕТ ПО ОРГАНИЗАЦИИ мир.xlsx').read_bytes())
    new = parse_report((ROOT / 'ОТЧЕТ ПО ОРГАНИЗАЦИИ мир 2.xlsx').read_bytes())
    assert old['quarters'].keys() == new['quarters'].keys()
    assert all(q['legacy_manual_deduction'] is not None for q in old['quarters'].values())
    assert all(q['legacy_manual_deduction'] is None for q in new['quarters'].values())
    assert all('non_vat_deduction' not in q['inputs'] for q in new['quarters'].values())


def test_v2_xlsx_manual_history_survives_v3_export_and_import(tmp_path):
    store = Store(tmp_path / 'legacy.xlsx.sqlite3')
    oid = store.create_organization('Синтетическая')['id']
    store.save_period(oid, 2026, 1, values(retail_revenue=120, non_vat_sales=12, input_vat=10), {})
    wb = load_workbook(BytesIO(make_report(store.summary(oid, 2026))))
    wb['__ANALIZ_META__']['A1'] = 'ANALIZ_XLSX_V2'
    wb['Лист1']['D15'] = 99.75  # формат старого экспорта: ручной ввод
    out = BytesIO(); wb.save(out); wb.close()
    parsed = parse_report(out.getvalue())
    assert parsed['metadata']['format'] == 'ANALIZ_XLSX_V2'
    assert parsed['quarters'][1]['legacy_manual_deduction'] == D('99.75')
    dest = Store(tmp_path / 'dest.sqlite3'); dest_id = dest.create_organization('Назначение')['id']
    imported = dest.import_year(dest_id, 2027, parsed, replace_existing=False, apply_settings=False)['summary']
    assert imported['quarters'][0]['legacy_manual_deduction'] == '99.75'
    assert imported['quarters'][0]['metrics']['non_vat_deduction'] == D('1')
    exported = make_report(imported)
    wb = load_workbook(BytesIO(exported), data_only=False)
    try:
        assert wb['__ANALIZ_META__']['A1'].value == 'ANALIZ_XLSX_V3'
        assert [wb['Лист1'][f'{col}15'].value for col in 'DEFGH'] == [
            '=D16/D10*D14', '=(D16+E16)/(D10+E10)*(D14+E14)-D15',
            '=(D16+E16+F16)/(D10+E10+F10)*(D14+E14+F14)-D15-E15',
            '=H15-F15-E15-D15', '=H14/H10*H16']
        assert wb['Лист1']['H17'].value == '=D17+E17+F17+G17'
        assert wb['Аналитика']['A9'].value.startswith('Статьи затрат + НДС')
        assert wb['Аналитика']['F9'].value == 29.4  # НДС 9 + налог на прибыль 20,4
    finally:
        wb.close()
    parsed_again = parse_report(exported)
    assert parsed_again['quarters'][1]['legacy_manual_deduction'] == D('99.75')
    assert parsed_again['quarters'][1]['inputs']['non_vat_sales'] == 12


def test_import_does_not_overwrite_preexisting_legacy_manual_history(tmp_path):
    store = Store(tmp_path / 'preserve-history.sqlite3')
    oid = store.create_organization('Синтетическая')['id']
    store.save_period(oid, 2026, 1, values(retail_revenue=120, non_vat_sales=12, input_vat=10), {})
    with store.connection() as con:
        con.execute('UPDATE periods SET legacy_manual_deduction=? WHERE organization_id=? AND year=? AND quarter=?', ('42.5', oid, 2026, 1))
    data = make_report(store.summary(oid, 2026))
    wb = load_workbook(BytesIO(data)); wb['__ANALIZ_META__']['A1'] = 'ANALIZ_XLSX_V2'; wb['Лист1']['D15'] = 99.75
    out = BytesIO(); wb.save(out); wb.close()
    imported = store.import_year(oid, 2026, parse_report(out.getvalue()), replace_existing=True, apply_settings=False)['summary']
    assert imported['quarters'][0]['legacy_manual_deduction'] == '42.5'
    assert imported['quarters'][0]['metrics']['non_vat_deduction'] == D('1')


def test_xlsx_analytics_marks_error_for_missing_initial_quarter(tmp_path):
    store = Store(tmp_path / 'error.sqlite3')
    oid = store.create_organization('Синтетическая')['id']
    store.save_period(oid, 2026, 2, values(retail_revenue=120, non_vat_sales=12, input_vat=10), {})
    data = make_report(store.summary(oid, 2026))
    wb = load_workbook(BytesIO(data), data_only=False)
    try:
        assert wb['Аналитика']['A9'].value.startswith('Статьи затрат + НДС')
        assert wb['Аналитика']['B9'].value is None
        assert wb['Аналитика']['C9'].value == '#ДЕЛ/0!'
        assert wb['Аналитика']['F9'].value == '#ДЕЛ/0!'
        assert wb['Лист1']['H15'].value == '=H14/H10*H16'
    finally:
        wb.close()
