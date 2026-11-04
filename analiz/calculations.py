"""Формулы книги «ОТЧЕТ ПО ОРГАНИЗАЦИИ мир 2.xlsx».

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


# Прежнее ручное поле осталось в SQLite для сохранения истории, но больше не вводится.
LEGACY_DEDUCTION_FIELD = "non_vat_deduction"
STORED_FIELDS = (*INPUT_FIELDS, LEGACY_DEDUCTION_FIELD)
_AUTO_FIRST_QUARTER = object()


def calculate_quarter(inputs: Mapping[str, Decimal], expenses: Iterable[Decimal], *,
                      deduction: Decimal | None | object = _AUTO_FIRST_QUARTER) -> dict[str, Decimal | None]:
    """Расчёт одной колонки. Накопительный вычет передаёт calculate_periods()."""
    with localcontext() as context:
        context.prec = 40
        for key in INPUT_FIELDS:
            if key not in inputs:
                raise ValueError(f"Отсутствует обязательный показатель: {key}")
        result: dict[str, Decimal | None] = {key: inputs[key] for key in INPUT_FIELDS}
        cost_expenses = sum(expenses, ZERO)
        revenue = inputs["retail_revenue"] + inputs["invoice_revenue"]
        if deduction is _AUTO_FIRST_QUARTER:
            deduction = inputs["input_vat"] / revenue * inputs["non_vat_sales"] if revenue != ZERO else None
        if deduction is not None and not isinstance(deduction, Decimal):
            raise ValueError("Некорректный расчёт вычета.")
        taxable_revenue = revenue - inputs["non_vat_sales"]
        output_vat = taxable_revenue - taxable_revenue / VAT_DIVISOR
        retail_vat = output_vat - inputs["invoice_vat"]
        adjusted_input_vat = inputs["input_vat"] - deduction if deduction is not None else None
        vat_due = output_vat - adjusted_input_vat if adjusted_input_vat is not None else None
        profit = revenue - output_vat - inputs["cost_of_sales"] - cost_expenses
        profit_tax = profit * PROFIT_TAX_RATE
        net_profit = profit - profit_tax
        revenue_without_vat = revenue - output_vat
        result.update({
            "revenue": revenue,
            "retail_vat": retail_vat,
            "output_vat": output_vat,
            "non_vat_deduction": deduction,
            "adjusted_input_vat": adjusted_input_vat,
            "vat_due": vat_due,
            "expense_total": cost_expenses,
            "profit": profit,
            "profit_tax": profit_tax,
            "net_profit": net_profit,
            "revenue_without_vat": revenue_without_vat,
            "total_costs": inputs["cost_of_sales"] + cost_expenses,
            # Отдельная аналитика: по выбору владельца БЕЗ себестоимости реализации.
            # Налог на прибыль уже учтён в net_profit; формулы прибыли не меняем.
            "expense_tax_total": cost_expenses + vat_due + profit_tax if vat_due is not None else None,
            "net_margin": _margin(net_profit, revenue_without_vat),
        })
        return result


def calculate_year(quarters: Iterable[Mapping[str, Decimal | None] | None]) -> dict[str, Decimal | None]:
    """Итоги H: H15 из H14/H10*H16, H17 и H4 — суммы колонок D:G."""
    with localcontext() as context:
        context.prec = 40
        existing = [quarter for quarter in quarters if quarter is not None]
        additive = (*INPUT_FIELDS, "revenue", "retail_vat", "output_vat", "adjusted_input_vat",
                    "vat_due", "expense_total", "profit_tax")
        annual: dict[str, Decimal | None] = {}
        for key in additive:
            values = [quarter[key] for quarter in existing]
            annual[key] = None if any(value is None for value in values) else sum(values, ZERO)  # type: ignore[arg-type]

        annual["profit"] = annual["revenue"] - annual["output_vat"] - annual["cost_of_sales"] - annual["expense_total"]  # type: ignore[operator]
        annual["net_profit"] = annual["profit"] - annual["profit_tax"]  # type: ignore[operator]
        annual["revenue_without_vat"] = annual["revenue"] - annual["output_vat"]  # type: ignore[operator]
        annual["total_costs"] = annual["cost_of_sales"] + annual["expense_total"]  # type: ignore[operator]
        annual["expense_tax_total"] = (annual["expense_total"] + annual["vat_due"] + annual["profit_tax"]
                                       if annual["vat_due"] is not None else None)  # type: ignore[operator]
        annual["net_margin"] = _margin(annual["net_profit"], annual["revenue_without_vat"])  # type: ignore[arg-type]
        revenue = annual["revenue"]
        annual_deduction = (annual["non_vat_sales"] / revenue * annual["input_vat"]) if revenue != ZERO else None  # type: ignore[operator]
        deductions = [quarter["non_vat_deduction"] for quarter in existing]
        quarterly_sum = None if any(value is None for value in deductions) else sum(deductions, ZERO)  # type: ignore[arg-type]
        annual["quarterly_deduction_sum"] = quarterly_sum
        annual["non_vat_deduction"] = annual_deduction
        annual["deduction_difference"] = annual_deduction - quarterly_sum if annual_deduction is not None and quarterly_sum is not None else None
        return annual


def calculate_periods(periods: Iterable[tuple[Mapping[str, Decimal], Iterable[Decimal]] | None]
                      ) -> tuple[list[dict[str, Decimal | None]], dict[str, Decimal | None]]:
    """Все четыре колонки с накопительной строкой 15 и распространением #ДЕЛ/0!.

    Отсутствующие периоды участвуют в формулах как пустые ячейки Excel (нули),
    но вызывающий код отдельно сохраняет признак отсутствующего квартала.
    """
    items = list(periods)
    if len(items) != 4:
        raise ValueError("Для расчёта нужны четыре квартала.")
    with localcontext() as context:
        context.prec = 40
        empty = {key: ZERO for key in INPUT_FIELDS}
        inputs = [item[0] if item is not None else empty for item in items]
        revenues = [value["retail_revenue"] + value["invoice_revenue"] for value in inputs]
        vat = [value["input_vat"] for value in inputs]
        nonvat = [value["non_vat_sales"] for value in inputs]
        total_revenue = sum(revenues, ZERO)
        annual_deduction = (sum(nonvat, ZERO) / total_revenue * sum(vat, ZERO)) if total_revenue != ZERO else None
        d1 = vat[0] / revenues[0] * nonvat[0] if revenues[0] != ZERO else None
        rev2 = revenues[0] + revenues[1]
        d2 = ((vat[0] + vat[1]) / rev2 * (nonvat[0] + nonvat[1]) - d1
              if rev2 != ZERO and d1 is not None else None)
        rev3 = revenues[0] + revenues[1] + revenues[2]
        d3 = ((vat[0] + vat[1] + vat[2]) / rev3 * (nonvat[0] + nonvat[1] + nonvat[2]) - d1 - d2
              if rev3 != ZERO and d1 is not None and d2 is not None else None)
        d4 = (annual_deduction - d3 - d2 - d1
              if annual_deduction is not None and d3 is not None and d2 is not None and d1 is not None else None)
        deductions = [d1, d2, d3, d4]
        calculated = [calculate_quarter(inputs[i], items[i][1] if items[i] is not None else (), deduction=deductions[i])
                      for i in range(4)]
        return calculated, calculate_year(calculated)


def json_ready(value: Any) -> Any:
    """Преобразовать Decimal в строку; float в финансовых данных не использовать."""
    if isinstance(value, Decimal):
        return decimal_text(value)
    if isinstance(value, dict):
        return {str(key): json_ready(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_ready(item) for item in value]
    return value
