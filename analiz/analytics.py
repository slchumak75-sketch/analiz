"""Дополнительная аналитика, не выдающая предположения за данные книги."""
from __future__ import annotations

from decimal import Decimal, localcontext
from typing import Any, Mapping

from .calculations import ZERO

COST_TYPES = {"fixed", "variable", "unclassified"}


def period_analysis(metrics: Mapping[str, Decimal | None], expenses: Mapping[int, Decimal],
                    classifications: Mapping[int, str]) -> dict[str, Any]:
    """Безубыточность по выручке без НДС при текущей структуре продаж/затрат.

    Себестоимость реализации — переменная (подтверждено владельцем). Типы прочих
    затрат задаются пользователем. Ненулевая неразмеченная статья блокирует порог.
    """
    with localcontext() as context:
        context.prec = 40
        fixed = ZERO
        variable = metrics["cost_of_sales"]
        unclassified = []
        for category_id, value in expenses.items():
            kind = classifications.get(category_id, "unclassified")
            if kind == "fixed":
                fixed += value
            elif kind == "variable":
                variable += value  # type: ignore[operator]
            elif value != ZERO:
                unclassified.append(category_id)
        revenue = metrics["revenue_without_vat"]
        assert isinstance(revenue, Decimal) and isinstance(variable, Decimal)
        contribution = revenue - variable
        ratio = contribution / revenue if revenue > ZERO else None
        result: dict[str, Any] = {
            "fixed_costs": fixed,
            "variable_costs": variable,
            "unclassified_ids": sorted(unclassified),
            "contribution": contribution if not unclassified else None,
            "contribution_margin": ratio * 100 if ratio is not None and not unclassified else None,
            "break_even_revenue": None,
            "safety_amount": None,
            "safety_percent": None,
            "break_even_status": "ready",
        }
        if unclassified:
            result["break_even_status"] = "unclassified"
        elif revenue <= ZERO:
            result["break_even_status"] = "no_positive_revenue"
        elif fixed < ZERO:
            result["break_even_status"] = "negative_fixed_costs"
        elif ratio is None or ratio <= ZERO:
            result["break_even_status"] = "nonpositive_contribution"
        else:
            threshold = fixed / ratio
            result["break_even_revenue"] = threshold
            result["safety_amount"] = revenue - threshold
            result["safety_percent"] = (revenue - threshold) / revenue * 100
        return result


def expense_structure(expenses: list[dict[str, Any]], annual: Mapping[str, Decimal | None],
                      quarters: list[dict[str, Any]], *, has_periods: bool) -> dict[str, Any]:
    """Доли статей и двух налогов за год и каждый квартал без себестоимости.

    На каждом квартале свой общий знаменатель, не зависящий от фильтра графика.
    Налоговые показатели берутся со знаком; прибыль и безубыточность не меняются.
    """
    if len(quarters) != 4:
        raise ValueError("Для структуры затрат нужны четыре квартала.")

    def denominator(metrics: Mapping[str, Decimal | None] | None) -> tuple[str, Decimal | None]:
        if metrics is None:
            return "no_data", None
        total = metrics["expense_tax_total"]
        if metrics["vat_due"] is None:
            return "vat_undefined", None
        if total is None or total <= ZERO:
            return "nonpositive_total", total
        return "ready", total

    with localcontext() as context:
        context.prec = 40
        items = [{"kind": "category", "category_id": item["id"], "name": item["name"],
                  "vat_rate": item["vat_rate"], "amount": item["total"],
                  "quarter_amounts": list(item["quarters"]), "archived": bool(item["archived"])}
                 for item in expenses]
        items.extend([
            {"kind": "vat", "category_id": None, "name": "Налог НДС", "vat_rate": None,
             "amount": annual["vat_due"],
             "quarter_amounts": [q["metrics"]["vat_due"] if q["metrics"] is not None else None for q in quarters]},
            {"kind": "profit_tax", "category_id": None, "name": "Налог на прибыль", "vat_rate": None,
             "amount": annual["profit_tax"],
             "quarter_amounts": [q["metrics"]["profit_tax"] if q["metrics"] is not None else None for q in quarters]},
        ])
        status, total = denominator(annual if has_periods else None)
        period_totals = [{"quarter": q["quarter"], "status": period_status, "total": period_total}
                         for q in quarters
                         for period_status, period_total in [denominator(q["metrics"] if q["exists"] else None)]]
        for item in items:
            amount = item["amount"]
            item["share_percent"] = amount / total * 100 if status == "ready" and amount is not None else None  # type: ignore[operator]
            item["quarter_share_percent"] = [
                amount / period["total"] * 100 if period["status"] == "ready" and amount is not None else None
                for amount, period in zip(item["quarter_amounts"], period_totals)
            ]
        return {"total": total, "status": status, "quarters": period_totals, "items": items,
                "includes_cost_of_sales": False}
