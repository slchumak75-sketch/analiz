from decimal import Decimal as D

import pytest

from analiz.calculations import INPUT_FIELDS, calculate_quarter, calculate_year, parse_amount


def inputs(**kwargs):
    return {key: D(str(kwargs.get(key, 0))) for key in INPUT_FIELDS}


def test_basic_formula_chain_and_fixed_tax_rates():
    result = calculate_quarter(inputs(retail_revenue=120, invoice_vat=3, input_vat=10,
                                      non_vat_deduction=2, cost_of_sales=50), [D("3")])
    assert result["revenue"] == D("120")
    assert result["output_vat"] == D("20")
    assert result["retail_vat"] == D("17")
    assert result["adjusted_input_vat"] == D("8")
    assert result["vat_due"] == D("12")
    assert result["expense_total"] == D("3")
    assert result["profit"] == D("47")
    assert result["profit_tax"] == D("9.4")
    assert result["net_profit"] == D("37.6")
    assert result["net_margin"] == D("37.6")


def test_annual_deduction_uses_h15_not_sum_or_replacement_for_h17():
    first = calculate_quarter(inputs(retail_revenue=120, non_vat_sales=10, input_vat=40,
                                     non_vat_deduction=2), [])
    second = calculate_quarter(inputs(retail_revenue=120, non_vat_sales=30, input_vat=20,
                                      non_vat_deduction=1), [])
    annual = calculate_year([first, second, None, None])
    assert annual["non_vat_deduction"] == D("10")  # H14 / H10 * H16
    assert annual["quarterly_deduction_sum"] == D("3")
    assert annual["deduction_difference"] == D("7")
    assert annual["adjusted_input_vat"] == D("57")  # SUM(D17:G17), not 60 - H15
    assert annual["adjusted_input_vat"] != annual["input_vat"] - annual["non_vat_deduction"]


def test_division_by_zero_is_undefined_not_zero():
    empty = calculate_quarter(inputs(), [])
    year = calculate_year([empty, None, None, None])
    assert year["revenue"] == 0
    assert year["non_vat_deduction"] is None
    assert year["deduction_difference"] is None
    assert year["net_margin"] is None


def test_negative_profit_and_tax_are_not_clamped():
    quarter = calculate_quarter(inputs(cost_of_sales=50, input_vat=10), [])
    assert quarter["profit"] == D("-50")
    assert quarter["profit_tax"] == D("-10")
    assert quarter["net_profit"] == D("-40")
    assert quarter["vat_due"] == D("-10")
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
