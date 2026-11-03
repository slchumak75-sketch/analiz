"""Формулы книги «ОТЧЕТ ПО ОРГАНИЗАЦИИ мир.xlsx».

Ввод хранится как Decimal, а не float. Промежуточное округление намеренно не
делается: формат Excel показывает две цифры, но формулы работают с полной
точностью. Отклонения в модели подробно описаны в docs/workbook-analysis.md.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation, localcontext
import re
from typing import Any, Iterable, Mapping

ZERO = Decimal("0")
VAT_DIVISOR = Decimal("1.2")
PROFIT_TAX_RATE = Decimal("0.2")

# Названия полей — стабильный формат БД и резервной копии.
INPUT_FIELDS = (
    "retail_revenue",       # 8: Выручка по отчётам ККМ с НДС
    "invoice_revenue",      # 9: Реализация (накладные) с НДС
    "invoice_vat",          # 12: НДС реализации по накладным
    "non_vat_sales",        # 14: Товары реализация без НДС
    "non_vat_deduction",    # 15: Вычет по товарам без НДС
    "input_vat",            # 16: Входящий НДС
    "cost_of_sales",        # 18: Себестоимость реализации без НДС
)

AMOUNT_RE = re.compile(r"^-?\d{1,18}(?:[.,]\d{1,8})?$")


def parse_amount(value: Any, label: str = "Сумма", *, empty_zero: bool = False) -> Decimal:
    """Разобрать сумму, не принимая NaN, бесконечность или неоднозначные записи."""
    if value is None or (isinstance(value, str) and not value.strip()):
        if empty_zero:
            return ZERO
        raise ValueError(f"«{label}»: укажите сумму; для отсутствующего значения введите 0.")
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise ValueError(f"«{label}»: требуется число.")
    text = str(value).strip().replace("\u00a0", "").replace("\u202f", "").replace(" ", "")
    if not AMOUNT_RE.fullmatch(text):
        raise ValueError(f"«{label}»: введите число до 18 цифр до запятой и до 8 знаков после неё.")
    try:
        result = Decimal(text.replace(",", "."))
    except InvalidOperation as exc:
        raise ValueError(f"«{label}»: неверное число.") from exc
    if not result.is_finite():
        raise ValueError(f"«{label}»: требуется конечное число.")
    return ZERO if result == 0 else result


def decimal_text(value: Decimal) -> str:
    """Запись в БД/JSON без экспоненты и без искусственного округления."""
    if value == 0:
        return "0"
    return format(value, "f")


def _margin(net_profit: Decimal, revenue_without_vat: Decimal) -> Decimal | None:
    # При нулевой базе показатель не определён. Отрицательная база тоже не
    # трактуется как обычная выручка для целей рентабельности.
    return net_profit / revenue_without_vat * 100 if revenue_without_vat > ZERO else None


def calculate_quarter(inputs: Mapping[str, Decimal], expenses: Iterable[Decimal]) -> dict[str, Decimal | None]:
    """Строки 4–19 для одной колонки D/E/F/G; затраты — строки 20–55."""
    with localcontext() as context:
        context.prec = 40
        for key in INPUT_FIELDS:
            if key not in inputs:
                raise ValueError(f"Отсутствует обязательный показатель: {key}")
        result: dict[str, Decimal | None] = {key: inputs[key] for key in INPUT_FIELDS}
        cost_expenses = sum(expenses, ZERO)                    # 19
        revenue = inputs["retail_revenue"] + inputs["invoice_revenue"]  # 10
        taxable_revenue = revenue - inputs["non_vat_sales"]
        output_vat = taxable_revenue - taxable_revenue / VAT_DIVISOR  # 13
        retail_vat = output_vat - inputs["invoice_vat"]        # 11
        adjusted_input_vat = inputs["input_vat"] - inputs["non_vat_deduction"]  # 17
        vat_due = output_vat - adjusted_input_vat              # 4
        profit = revenue - output_vat - inputs["cost_of_sales"] - cost_expenses  # 6
        profit_tax = profit * PROFIT_TAX_RATE                  # 5 (в т. ч. отрицательный!)
        net_profit = profit - profit_tax                      # 7
        revenue_without_vat = revenue - output_vat            # дополнительная аналитика
        result.update({
            "revenue": revenue,
            "retail_vat": retail_vat,
            "output_vat": output_vat,
            "adjusted_input_vat": adjusted_input_vat,
            "vat_due": vat_due,
            "expense_total": cost_expenses,
            "profit": profit,
            "profit_tax": profit_tax,
            "net_profit": net_profit,
            "revenue_without_vat": revenue_without_vat,
            "total_costs": inputs["cost_of_sales"] + cost_expenses,
            "net_margin": _margin(net_profit, revenue_without_vat),
        })
        return result


def calculate_year(quarters: Iterable[Mapping[str, Decimal | None] | None]) -> dict[str, Decimal | None]:
    """Итоги H: сохраняем особую H15 и не подменяем H17 = SUM(D17:G17)."""
    with localcontext() as context:
        context.prec = 40
        existing = [quarter for quarter in quarters if quarter is not None]
        additive = (*INPUT_FIELDS, "revenue", "retail_vat", "output_vat", "adjusted_input_vat",
                    "vat_due", "expense_total", "profit_tax")
        annual: dict[str, Decimal | None] = {}
        for key in additive:
            annual[key] = sum((quarter[key] for quarter in existing), ZERO)  # type: ignore[arg-type]

        # Эти строки в Excel вычисляются из годовых итогов, а не через H15.
        annual["profit"] = annual["revenue"] - annual["output_vat"] - annual["cost_of_sales"] - annual["expense_total"]  # type: ignore[operator]
        annual["net_profit"] = annual["profit"] - annual["profit_tax"]  # type: ignore[operator]
        annual["revenue_without_vat"] = annual["revenue"] - annual["output_vat"]  # type: ignore[operator]
        annual["total_costs"] = annual["cost_of_sales"] + annual["expense_total"]  # type: ignore[operator]
        annual["net_margin"] = _margin(annual["net_profit"], annual["revenue_without_vat"])  # type: ignore[arg-type]

        quarterly_deduction = annual["non_vat_deduction"]  # Сумма D15:G15, не формула H15.
        revenue = annual["revenue"]
        annual_deduction = (annual["non_vat_sales"] / revenue * annual["input_vat"]) if revenue != ZERO else None  # type: ignore[operator]
        annual["quarterly_deduction_sum"] = quarterly_deduction
        annual["non_vat_deduction"] = annual_deduction          # H15
        annual["deduction_difference"] = (annual_deduction - quarterly_deduction) if annual_deduction is not None else None  # type: ignore[operator]
        return annual


def json_ready(value: Any) -> Any:
    """Преобразовать Decimal в строку; float в финансовых данных не использовать."""
    if isinstance(value, Decimal):
        return decimal_text(value)
    if isinstance(value, dict):
        return {str(key): json_ready(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_ready(item) for item in value]
    return value
