"""Воспроизводимая инвентаризация исходной XLSX без публикации сумм.

python scripts/audit_workbook.py --write   # обновить оба отчёта в docs/
python scripts/audit_workbook.py --check   # убедиться, что инвентаризация актуальна
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.formula import Tokenizer

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "ОТЧЕТ ПО ОРГАНИЗАЦИИ мир.xlsx"
OUTPUT = ROOT / "docs" / "workbook-formulas.md"
SOURCE_NEW = ROOT / "ОТЧЕТ ПО ОРГАНИЗАЦИИ мир 2.xlsx"
OUTPUT_NEW = ROOT / "docs" / "workbook-2-formulas.md"


def clean(value: object) -> str:
    return str(value or "").replace("\n", " ").replace("|", r"\|").strip()


def build_inventory(source: Path = SOURCE) -> str:
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    wb = load_workbook(source, data_only=False, read_only=False, keep_links=True)
    try:
        lines = [
            "# Полная инвентаризация формул исходной книги",
            "",
            "> Сгенерировано командой `python scripts/audit_workbook.py --write`. Не редактируйте таблицы вручную.",
            "> Денежные значения и кэшированные результаты намеренно не выводятся.",
            "",
            f"- Файл: `{source.name}`; SHA-256: `{digest}`.",
            f"- Листов: {len(wb.sheetnames)}; имена: {', '.join('`' + name + '`' for name in wb.sheetnames)}.",
            f"- Именованные диапазоны: {len(wb.defined_names)}; внешние связи: {len(wb._external_links)}.",
            "- Формулы перечислены в A1-нотации, как прочитаны из XLSX. Диапазон в зависимостях включает все свои ячейки.",
            "",
        ]
        total = 0
        for sheet in wb:
            formulas = [cell for row in sheet for cell in row if cell.data_type == "f"]
            total += len(formulas)
            lines += [f"## Лист `{sheet.title}`: {len(formulas)} формул", "", "Ячейка | Строка отчёта | Формула | Непосредственные зависимости", "--- | --- | --- | ---"]
            for cell in formulas:
                tokens = Tokenizer(cell.value).items
                refs = list(dict.fromkeys(t.value for t in tokens if t.type == "OPERAND" and t.subtype == "RANGE"))
                row_name = clean(sheet.cell(cell.row, 2).value) or "(без названия)"
                dependencies = ", ".join(f"`{clean(ref)}`" for ref in refs) or "—"
                lines.append(f"`{cell.coordinate}` | {row_name} | `{clean(cell.value)}` | {dependencies}")
            lines += ["", "### Введённые в книге статьи затрат", "", "Строка | Название B | Значение C (значение без заголовка) | Годовая формула", "--- | --- | --- | ---"]
            for row in range(20, 48):
                lines.append(f"{row} | {clean(sheet.cell(row, 2).value)} | `{sheet.cell(row, 3).value}` | `{clean(sheet.cell(row, 8).value)}`")
            lines += ["", "Строки 48–55 пусты: они входят в квартальные `SUM(D20:D55)` и аналогичные диапазоны, но их годовые ячейки H48:H55 не содержат формул.", ""]
        lines.insert(7, f"- Всего формул: {total}.")
        return "\n".join(lines).rstrip() + "\n"
    finally:
        wb.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args()
    stale = False
    for source, output in ((SOURCE, OUTPUT), (SOURCE_NEW, OUTPUT_NEW)):
        content = build_inventory(source)
        if args.write:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(content, encoding="utf-8", newline="\n")
            print(f"Записано: {output.relative_to(ROOT)}")
        elif not output.exists() or output.read_text(encoding="utf-8") != content:
            print(f"Инвентаризация устарела: {source.name}. Проверьте книгу и выполните --write.")
            stale = True
        else:
            print(f"Инвентаризация соответствует книге: {source.name}.")
    return 1 if stale else 0



if __name__ == "__main__":
    raise SystemExit(main())
