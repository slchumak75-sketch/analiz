"""Экспорт отчёта в CSV по выбранной организации и году."""
from __future__ import annotations

import csv
import io
from decimal import Decimal
from typing import Any

from .calculations import decimal_text

# Упорядочено как в книге; H15 отдельно получает формулу годового вычета.
REPORT_ROWS = (
    ("4", "Налог НДС", "vat_due"),
    ("5", "Налог на прибыль", "profit_tax"),
    ("6", "Прибыль", "profit"),
    ("7", "Чистая прибыль", "net_profit"),
    ("8", "Выручка по отчетам ККМ с НДС", "retail_revenue"),
    ("9", "Реализация (Накладные) с НДС", "invoice_revenue"),
    ("10", "Итого выручка", "revenue"),
    ("11", "НДС Выручка по отчетам ККМ", "retail_vat"),
    ("12", "НДС Реализация (Накладные)", "invoice_vat"),
    ("13", "Итого НДС", "output_vat"),
    ("14", "Товары реализация без НДС", "non_vat_sales"),
    ("15", "Вычет по товарам без НДС", "non_vat_deduction"),
    ("16", "Входящий НДС", "input_vat"),
    ("17", "Входящий НДС с вычетом", "adjusted_input_vat"),
    ("18", "Себестоимость реализация без НДС", "cost_of_sales"),
    ("19", "Себестоимость затрат без НДС", "expense_total"),
)


def safe_csv_text(value: Any) -> str:
    """Не допустить исполнения формул в Excel из названий организаций/статей."""
    text = str(value or "")
    if text.lstrip().startswith(("=", "+", "-", "@", "\t", "\r", "\n")):
        return "'" + text
    return text


def csv_number(value: Decimal | None) -> str:
    return "" if value is None else decimal_text(value).replace(".", ",")


def report_csv(summary: dict[str, Any]) -> bytes:
    out = io.StringIO(newline="")
    writer = csv.writer(out, delimiter=";", lineterminator="\r\n")
    org = summary["organization"]
    writer.writerow(["Организация", safe_csv_text(org["name"])])
    writer.writerow(["Год", summary["year"]])
    writer.writerow(["Валюта / единица", safe_csv_text(org["currency"])])
    writer.writerow(["Введено кварталов", summary["quarter_count"], "из 4"])
    writer.writerow([])
    writer.writerow(["Строка Excel", "Показатель", "1 квартал", "2 квартал", "3 квартал", "4 квартал", "Итого за введённые кварталы"])
    for row, label, key in REPORT_ROWS:
        q_values = [csv_number(q["metrics"][key]) if q["exists"] else "" for q in summary["quarters"]]
        annual = summary["annual"][key]
        annual_value = ("#ДЕЛ/0!" if key == "non_vat_deduction" and annual is None else csv_number(annual)) if summary["quarter_count"] else ""
        writer.writerow([row, label, *q_values, annual_value])
    writer.writerow(["", "Сумма квартальных вычетов (не H15)", "", "", "", "",
                     csv_number(summary["annual"]["quarterly_deduction_sum"]) if summary["quarter_count"] else ""])
    writer.writerow([])
    writer.writerow(["", "Статьи затрат", "1 квартал", "2 квартал", "3 квартал", "4 квартал", "Итого"])
    for expense in summary["expenses"]:
        name = expense["name"] + (f" · НДС: {expense['vat_rate']}%" if expense["vat_rate"] is not None else "")
        kind = {"fixed": "постоянные", "variable": "переменные", "unclassified": "тип не указан"}[expense["cost_type"]]
        name += f" · {kind}"
        writer.writerow([expense["source_row"] or "", safe_csv_text(name),
                         *[csv_number(n) for n in expense["quarters"]],
                         csv_number(expense["total"]) if summary["quarter_count"] else ""])
    return ("\ufeff" + out.getvalue()).encode("utf-8")
