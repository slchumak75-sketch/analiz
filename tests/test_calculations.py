from decimal import Decimal as D

import pytest

from analiz.calculations import INPUT_FIELDS, calculate_periods, calculate_quarter, calculate_year, parse_amount


def inputs(**kwargs):
    return {key: D(str(kwargs.get(key, 0))) for key in INPUT_FIELDS}


def test_basic_formula_chain_and_fixed_tax_rates():
    result = calculate_quarter(inputs(retail_revenue=120, invoice_vat=3, non_vat_sales=12,
                                      input_vat=10, cost_of_sales=50), [D("3")])
    assert result["revenue"] == D("120")
    assert result["output_vat"] == D("18")
    assert result["retail_vat"] == D("15")
    assert result["non_vat_deduction"] == D("1")  # D16 / D10 * D14
    assert result["adjusted_input_vat"] == D("9")
    assert result["vat_due"] == D("9")
    assert result["expense_total"] == D("3")
    assert result["profit"] == D("49")
    assert result["profit_tax"] == D("9.8")
    assert result["net_profit"] == D("39.2")
    assert result["expense_tax_total"] == D("21.8")  # статьи + НДС + налог на прибыль, без себестоимости


def test_cumulative_deduction_uses_all_four_exact_formulas():
    rows = [
        (inputs(retail_revenue=100, non_vat_sales=10, input_vat=20), []),
        (inputs(retail_revenue=100, non_vat_sales=30, input_vat=40), []),
        (inputs(retail_revenue=100, non_vat_sales=20, input_vat=30), []),
        (inputs(retail_revenue=100, non_vat_sales=40, input_vat=10), []),
    ]
    quarters, annual = calculate_periods(rows)
    assert [q["non_vat_deduction"] for q in quarters] == [D("2"), D("10"), D("6"), D("7")]
    assert annual["non_vat_deduction"] == D("25")  # H14 / H10 * H16
    assert annual["quarterly_deduction_sum"] == D("25")
    assert annual["deduction_difference"] == 0
    assert annual["adjusted_input_vat"] == D("75")  # именно SUM(D17:G17)
    assert annual["vat_due"] == sum((q["vat_due"] for q in quarters), D(0))


def test_quarterly_zero_division_propagates_like_excel_even_if_year_has_revenue():
    periods, annual = calculate_periods([None, (inputs(retail_revenue=120, non_vat_sales=12, input_vat=10), []), None, None])
    assert periods[0]["non_vat_deduction"] is None  # пустой D10 -> D15 = #ДЕЛ/0!
    assert periods[1]["non_vat_deduction"] is None  # E15 ссылается на D15
    assert periods[1]["adjusted_input_vat"] is None and periods[1]["vat_due"] is None
    assert periods[1]["net_profit"] is not None  # независимые формулы не блокируются
    assert annual["non_vat_deduction"] == D("1")  # H15 имеет собственный знаменатель
    assert annual["quarterly_deduction_sum"] is None
    assert annual["adjusted_input_vat"] is None and annual["vat_due"] is None


def test_running_revenue_can_become_zero_and_error_propagates():
    periods, annual = calculate_periods([
        (inputs(retail_revenue=100, non_vat_sales=10, input_vat=20), []),
        (inputs(retail_revenue=-100, non_vat_sales=5, input_vat=5), []),
        (inputs(retail_revenue=200, non_vat_sales=10, input_vat=10), []), None,
    ])
    assert periods[0]["non_vat_deduction"] == 2
    assert all(q["non_vat_deduction"] is None for q in periods[1:])
    assert annual["non_vat_deduction"] is not None
    assert annual["vat_due"] is None


def test_division_by_zero_is_undefined_not_zero():
    quarters, year = calculate_periods([(inputs(), []), None, None, None])
    assert year["revenue"] == 0
    assert year["non_vat_deduction"] is None
    assert year["deduction_difference"] is None
    assert year["net_margin"] is None
    assert all(q["vat_due"] is None for q in quarters)


def test_negative_profit_and_tax_are_not_clamped():
    quarter = calculate_quarter(inputs(cost_of_sales=50, input_vat=10), [])
    assert quarter["profit"] == D("-50")
    assert quarter["profit_tax"] == D("-10")
    assert quarter["net_profit"] == D("-40")
    assert quarter["vat_due"] is None  # деление на ноль в D15 переносится на D4
    assert quarter["net_margin"] is None


def test_no_intermediate_rounding_and_negative_expenses():
    result = calculate_quarter(inputs(retail_revenue=1), [D("-0.01")])
    assert abs(result["output_vat"] - D("0.1666666666666666666666666666666666666667")) < D("1e-38")
    assert result["expense_total"] == D("-0.01")
    assert result["profit"] > D("0.84")


@pytest.mark.parametrize("value,expected", [
    ("12,50", D("12.50")), ("1 234,56", D("1234.56")), ("-15.12345678", D("-15.12345678")),
    (0, D("0")), ("-0,00", D("0")), ("", D("0")), (None, D("0")),
])
def test_parse_amount(value, expected):
    assert parse_amount(value, empty_zero=True) == expected


@pytest.mark.parametrize("value", [None, "", "NaN", "Infinity", "1e5", "1,2.3", True,
                                     "1.123456789", "1000000000000000000", "+1", "1-2"])
def test_reject_missing_or_ambiguous_amounts(value):
    with pytest.raises(ValueError):
        parse_amount(value)
