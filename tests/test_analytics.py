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
