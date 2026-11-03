from decimal import Decimal as D

import pytest

from analiz.calculations import INPUT_FIELDS, calculate_quarter
from analiz.analytics import period_analysis
from analiz.store import Store


def amounts(**kwargs):
    return {key: str(kwargs.get(key, 0)) for key in INPUT_FIELDS}


def empty_quarters():
    return {str(q): {"inputs": {}, "expenses": {}} for q in range(1, 5)}


def test_break_even_from_explicit_classification():
    metrics = calculate_quarter({key: D(v) for key, v in amounts(retail_revenue=120, cost_of_sales=50).items()}, [D(20), D(10)])
    result = period_analysis(metrics, {1: D(20), 2: D(10)}, {1: 'fixed', 2: 'variable'})
    assert result['fixed_costs'] == 20
    assert result['variable_costs'] == 60  # себестоимость 50 + переменные расходы 10
    assert result['contribution'] == 40
    assert result['contribution_margin'] == 40
    assert result['break_even_revenue'] == 50  # 20 / 40%
    assert result['safety_amount'] == 50
    assert result['safety_percent'] == 50
    assert metrics['profit'] == 20


def test_break_even_unavailable_when_not_classified_or_mathematically_impossible():
    metrics = calculate_quarter({key: D(v) for key, v in amounts(retail_revenue=120, cost_of_sales=50).items()}, [D(20)])
    missing = period_analysis(metrics, {7: D(20)}, {})
    assert missing['break_even_status'] == 'unclassified' and missing['break_even_revenue'] is None
    assert missing['unclassified_ids'] == [7]
    zero = calculate_quarter({key: D(v) for key, v in amounts().items()}, [])
    assert period_analysis(zero, {}, {})['break_even_status'] == 'no_positive_revenue'
    poor = calculate_quarter({key: D(v) for key, v in amounts(retail_revenue=120, cost_of_sales=110).items()}, [D(20)])
    assert period_analysis(poor, {7: D(20)}, {7: 'fixed'})['break_even_status'] == 'nonpositive_contribution'
    neg_fixed = period_analysis(metrics, {7: D(-1)}, {7: 'fixed'})
    assert neg_fixed['break_even_status'] == 'negative_fixed_costs'


def test_year_save_preview_and_rates_are_explicit_and_isolated(tmp_path):
    store = Store(tmp_path / 'data.sqlite3')
    oid = store.create_organization('Организация')['id']
    cats = store.categories(oid)
    a, b = cats[0]['id'], cats[1]['id']
    q = empty_quarters()
    q['1'] = {'inputs': amounts(retail_revenue=120, cost_of_sales=50), 'expenses': {str(a): '20', str(b): '10'}}
    settings = {str(a): {'cost_type': 'fixed', 'vat_rate': '20'}, str(b): {'cost_type': 'variable', 'vat_rate': '0'}}
    preview = store.preview_year(oid, 2026, q, settings)
    assert preview['analysis']['break_even_revenue'] == 50
    assert store.summary(oid, 2026)['quarter_count'] == 0  # предпросмотр ничего не сохраняет
    saved = store.save_year(oid, 2026, q, settings)
    assert saved['analysis']['break_even_revenue'] == 50
    assert saved['expenses'][0]['vat_rate'] == '20'
    assert saved['quarters'][0]['metrics']['output_vat'] == 20  # ставки статей не меняют НДС
    assert store.summary(oid, 2027)['expenses'][0]['cost_type'] == 'unclassified'
    assert store.summary(oid, 2027)['expenses'][0]['vat_rate'] == '0'  # оригинальная ставка по умолчанию


def test_incomplete_or_foreign_inputs_do_not_partially_save(tmp_path):
    store = Store(tmp_path / 'data.sqlite3')
    oid = store.create_organization('А')['id']
    other = store.create_organization('Б')['id']
    foreign = store.categories(other)[0]['id']
    q = empty_quarters()
    q['1'] = {'inputs': amounts(retail_revenue=120), 'expenses': {}}
    q['2'] = {'inputs': {'retail_revenue': '10'}, 'expenses': {}}
    preview = store.preview_year(oid, 2026, q, {})
    assert preview['quarters'][1]['state'] == 'incomplete'
    with pytest.raises(ValueError, match='2 квартал'):
        store.save_year(oid, 2026, q, {})
    assert store.summary(oid, 2026)['quarter_count'] == 0
    q['2'] = {'inputs': amounts(), 'expenses': {str(foreign): '5'}}
    with pytest.raises(ValueError):
        store.save_year(oid, 2026, q, {})
    assert store.summary(oid, 2026)['quarter_count'] == 0


def test_year_revision_blocks_stale_window_without_losing_the_newer_values(tmp_path):
    store = Store(tmp_path / 'revision.sqlite3')
    oid = store.create_organization('А')['id']
    old_revision = store.summary(oid, 2026)['revision']
    draft = empty_quarters()
    draft['1'] = {'inputs': amounts(retail_revenue=120), 'expenses': {}}
    saved = store.save_year(oid, 2026, draft, {}, expected_revision=old_revision)
    assert saved['revision'] != old_revision
    stale = empty_quarters()
    stale['2'] = {'inputs': amounts(retail_revenue=240), 'expenses': {}}
    with pytest.raises(ValueError, match='изменились в другом окне'):
        store.save_year(oid, 2026, stale, {}, expected_revision=old_revision)
    assert store.get_period(oid, 2026, 1)['inputs']['retail_revenue'] == '120'
    assert store.get_period(oid, 2026, 2) is None
    # Обновление и корректный revision дают сохранить другие изменения.
    draft['2'] = stale['2']
    fresh = store.summary(oid, 2026)['revision']
    store.save_year(oid, 2026, draft, {}, expected_revision=fresh)
    assert store.summary(oid, 2026)['quarter_count'] == 2


def test_structure_shares_include_two_taxes_but_not_cost_of_sales(tmp_path):
    store = Store(tmp_path / 'structure.sqlite3')
    oid = store.create_organization('А')['id']
    cid = store.categories(oid)[0]['id']
    store.save_period(oid, 2026, 1, amounts(retail_revenue=120, input_vat=10, cost_of_sales=50), {str(cid): '3'})
    summary = store.summary(oid, 2026)
    structure = summary['expense_structure']
    assert structure['status'] == 'ready' and structure['total'] == D('22.4')
    assert summary['annual']['total_costs'] == D('53')  # исходная формула прибыли не менялась
    assert summary['annual']['expense_tax_total'] == D('22.4')
    assert structure['includes_cost_of_sales'] is False
    vat = next(item for item in structure['items'] if item['kind'] == 'vat')
    profit_tax = next(item for item in structure['items'] if item['kind'] == 'profit_tax')
    category = next(item for item in structure['items'] if item['category_id'] == cid)
    assert vat['amount'] == D('10') and profit_tax['amount'] == D('9.4')
    assert abs(category['share_percent'] - D('13.39285714285714285714285714285714285714')) < D('1e-36')
    from decimal import localcontext
    with localcontext() as context:
        context.prec = 40
        assert abs(sum((item['share_percent'] for item in structure['items']), D(0)) - D(100)) < D('1e-36')


def test_structure_handles_negative_and_undefined_tax_without_inventing_percentages(tmp_path):
    store = Store(tmp_path / 'structure-negative.sqlite3')
    oid = store.create_organization('А')['id']
    cid = store.categories(oid)[0]['id']
    store.save_period(oid, 2026, 1, amounts(retail_revenue=120, input_vat=40, cost_of_sales=50), {str(cid): '3'})
    structure = store.summary(oid, 2026)['expense_structure']
    assert structure['total'] == D('-7.6') and structure['status'] == 'nonpositive_total'
    assert all(item['share_percent'] is None for item in structure['items'])
    store.delete_period(oid, 2026, 1)
    store.save_period(oid, 2026, 2, amounts(retail_revenue=120), {str(cid): '3'})
    structure = store.summary(oid, 2026)['expense_structure']
    assert structure['status'] == 'vat_undefined' and structure['total'] is None
    assert all(item['share_percent'] is None for item in structure['items'])


def test_positive_structure_total_keeps_negative_tax_and_signed_shares(tmp_path):
    store = Store(tmp_path / 'structure-signed.sqlite3')
    oid = store.create_organization('А')['id']
    cid = store.categories(oid)[0]['id']
    store.save_period(oid, 2026, 1, amounts(retail_revenue=120, input_vat=30, cost_of_sales=50), {str(cid): '50'})
    structure = store.summary(oid, 2026)['expense_structure']
    assert structure['status'] == 'ready' and structure['total'] == D('40')
    assert next(i for i in structure['items'] if i['kind'] == 'vat')['share_percent'] == D('-25')
    assert next(i for i in structure['items'] if i['category_id'] == cid)['share_percent'] == D('125')
    assert next(i for i in structure['items'] if i['kind'] == 'vat')['quarter_share_percent'][0] == D('-25')
    assert next(i for i in structure['items'] if i['category_id'] == cid)['quarter_share_percent'][0] == D('125')


def test_quarterly_structure_uses_each_quarter_total_and_keeps_taxes(tmp_path):
    store = Store(tmp_path / 'quarterly.sqlite3')
    oid = store.create_organization('А')['id']
    cid = store.categories(oid)[0]['id']
    store.save_period(oid, 2026, 1, amounts(retail_revenue=120, non_vat_sales=12, input_vat=10, cost_of_sales=50), {str(cid): '3'})
    store.save_period(oid, 2026, 2, amounts(retail_revenue=120, non_vat_sales=24, input_vat=10, cost_of_sales=50), {str(cid): '6'})
    structure = store.summary(oid, 2026)['expense_structure']
    assert [q['status'] for q in structure['quarters']] == ['ready', 'ready', 'no_data', 'no_data']
    # Q1: статья 3 + НДС 9 + налог на прибыль 9.8 = 21.8.
    # Q2: статья 6 + НДС 8 + налог на прибыль 9.6 = 23.6.
    assert [q['total'] for q in structure['quarters']] == [D('21.8'), D('23.6'), None, None]
    category = next(i for i in structure['items'] if i['category_id'] == cid)
    vat = next(i for i in structure['items'] if i['kind'] == 'vat')
    tax = next(i for i in structure['items'] if i['kind'] == 'profit_tax')
    assert category['quarter_amounts'] == [D('3'), D('6'), None, None]
    assert vat['quarter_amounts'] == [D('9'), D('8'), None, None]
    assert tax['quarter_amounts'] == [D('9.8'), D('9.6'), None, None]
    assert abs(category['quarter_share_percent'][0] - D('13.76146788990825688073394495412844036697')) < D('1e-36')
    assert abs(category['quarter_share_percent'][1] - D('25.42372881355932203389830508474576271186')) < D('1e-36')
    assert category['quarter_share_percent'][2:] == [None, None]
    # Скрытие в архив не меняет ни знаменатель, ни числитель.
    store.update_category(oid, cid, archived=True)
    archived = store.summary(oid, 2026)['expense_structure']
    assert archived['quarters'] == structure['quarters']
    assert next(i for i in archived['items'] if i['category_id'] == cid)['quarter_share_percent'] == category['quarter_share_percent']


def test_quarterly_structure_distinguishes_undefined_and_nonpositive(tmp_path):
    store = Store(tmp_path / 'quarterly-invalid.sqlite3')
    oid = store.create_organization('А')['id']
    cid = store.categories(oid)[0]['id']
    # Нет Q1 -> формульный НДС Q2 не определён, даже если доход есть.
    store.save_period(oid, 2026, 2, amounts(retail_revenue=120), {str(cid): '5'})
    data = store.summary(oid, 2026)['expense_structure']
    assert [q['status'] for q in data['quarters']] == ['no_data', 'vat_undefined', 'no_data', 'no_data']
    assert next(i for i in data['items'] if i['category_id'] == cid)['quarter_share_percent'][1] is None
    # При известном отрицательном налоге и отрицательной сумме проценты не выдаются.
    store.delete_period(oid, 2026, 2)
    store.save_period(oid, 2026, 1, amounts(retail_revenue=120, input_vat=40, cost_of_sales=50), {str(cid): '3'})
    data = store.summary(oid, 2026)['expense_structure']
    assert data['quarters'][0]['status'] == 'nonpositive_total' and data['quarters'][0]['total'] == D('-7.6')
    assert all(i['quarter_share_percent'][0] is None for i in data['items'])


def test_quarterly_share_can_be_available_even_when_year_total_is_nonpositive(tmp_path):
    store = Store(tmp_path / 'quarterly-independent.sqlite3')
    oid = store.create_organization('А')['id']
    cid = store.categories(oid)[0]['id']
    store.save_period(oid, 2026, 1, amounts(retail_revenue=120, input_vat=10, cost_of_sales=50), {str(cid): '3'})
    store.save_period(oid, 2026, 2, amounts(retail_revenue=120, input_vat=100, cost_of_sales=50), {str(cid): '3'})
    structure = store.summary(oid, 2026)['expense_structure']
    assert structure['status'] == 'nonpositive_total'
    assert [q['status'] for q in structure['quarters']] == ['ready', 'nonpositive_total', 'no_data', 'no_data']
    item = next(i for i in structure['items'] if i['category_id'] == cid)
    assert item['share_percent'] is None  # годовую долю выдавать нельзя
    assert abs(item['quarter_share_percent'][0] - D('13.39285714285714285714285714285714285714')) < D('1e-36')
    assert item['quarter_share_percent'][1] is None
