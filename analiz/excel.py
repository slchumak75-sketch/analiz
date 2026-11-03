"""Безопасный обмен XLSX за выбранный год, без исполнения формул из файла."""
from __future__ import annotations

from decimal import Decimal
from io import BytesIO
import re
from pathlib import PurePosixPath
from typing import Any
from zipfile import BadZipFile, ZipFile

from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.workbook.properties import CalcProperties

from .calculations import INPUT_FIELDS, ZERO, decimal_text, parse_amount
from .reports import REPORT_ROWS
from .store import DEFAULT_CATEGORIES, valid_vat_rate

MAX_XLSX_BYTES = 10 * 1024 * 1024
MAX_UNCOMPRESSED = 80 * 1024 * 1024
MAX_ENTRIES = 1500
MAX_ROWS = 1020
META_SHEET = "__ANALIZ_META__"
SIGNATURE = "ANALIZ_XLSX_V3"
SUPPORTED_SIGNATURES = {"ANALIZ_XLSX_V2", SIGNATURE}
INPUT_ROWS = {"retail_revenue": 8, "invoice_revenue": 9, "invoice_vat": 12,
              "non_vat_sales": 14, "input_vat": 16, "cost_of_sales": 18}
DEDUCTION_FORMULAS = ("=D16/D10*D14", "=(D16+E16)/(D10+E10)*(D14+E14)-D15",
                      "=(D16+E16+F16)/(D10+E10+F10)*(D14+E14+F14)-D15-E15", "=H15-F15-E15-D15")
TYPE_LABEL = {"fixed": "Постоянные", "variable": "Переменные", "unclassified": "Не определено"}
TYPE_PARSE = {v.casefold(): k for k, v in TYPE_LABEL.items()}
TYPE_PARSE.update({"fixed": "fixed", "variable": "variable", "unclassified": "unclassified"})
STATUS_LABEL = {"ready": "Рассчитано", "unclassified": "Есть неразделённые затраты",
                "no_positive_revenue": "Нет положительной выручки без НДС",
                "negative_fixed_costs": "Постоянные затраты отрицательны",
                "nonpositive_contribution": "Маржинальный доход неположителен"}


def text_cell(cell: Any, value: Any) -> None:
    """Текст пользователя остаётся текстом, даже если начинается с '='."""
    cell.value = "" if value is None else str(value)
    cell.data_type = "s"


def write_number(cell: Any, value: Any) -> None:
    if value is not None:
        cell.value = Decimal(str(value))
        cell.number_format = '#,##0.00;[Red]-#,##0.00'


def write_input_number(cell: Any, value: Any) -> None:
    """Excel сохраняет только 15 значащих цифр; не теряем ввод молча."""
    if value is not None:
        amount = Decimal(str(value))
        digits = len(amount.normalize().as_tuple().digits) if amount else 1
        if digits > 15:
            raise ValueError(f"Ячейка {cell.coordinate}: Excel не сохраняет больше 15 значащих цифр. "
                             "Экспорт отменён, чтобы не потерять точность; используйте резервную копию или CSV.")
    write_number(cell, value)


def make_report(summary: dict[str, Any]) -> bytes:
    """Отчёт с исходными формулами в Лист1, результатами и диаграммами."""
    wb = Workbook()
    ws = wb.active
    ws.title = "Лист1"
    ws.sheet_view.showGridLines = False
    ws.freeze_panes = "D4"
    ws.column_dimensions["A"].width = 3
    ws.column_dimensions["B"].width = 42
    ws.column_dimensions["C"].width = 12
    for col in "DEFGH":
        ws.column_dimensions[col].width = 19
    ws.column_dimensions["I"].width = 20
    ws.merge_cells("B2:I2")
    text_cell(ws["B2"], f"{summary['organization']['name']} · {summary['year']} год")
    ws["B2"].font = Font(name="Calibri", size=14, bold=True, color="FFFFFF")
    ws["B2"].fill = PatternFill("solid", fgColor="176C53")
    ws["B2"].alignment = Alignment(vertical="center")
    ws.row_dimensions[2].height = 27
    for coord, value in {"B3": "Показатель / статья затрат", "C3": "НДС, %", "D3": "1кв", "E3": "2кв", "F3": "3кв", "G3": "4кв", "H3": "Итого", "I3": "Тип затрат"}.items():
        text_cell(ws[coord], value)
        ws[coord].font = Font(bold=True, color="FFFFFF")
        ws[coord].fill = PatternFill("solid", fgColor="347F64")
        ws[coord].alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.row_dimensions[3].height = 26
    row_labels = {int(row): label for row, label, _ in REPORT_ROWS}
    for row in range(4, 20):
        text_cell(ws.cell(row, 2), row_labels[row])
    expense_end = max(20, 19 + len(summary["expenses"]))
    for index, category in enumerate(summary["expenses"], start=20):
        text_cell(ws.cell(index, 2), category["name"])
        write_number(ws.cell(index, 3), category["vat_rate"])
        if category["vat_rate"] is not None:
            ws.cell(index, 3).number_format = '0.########'
        text_cell(ws.cell(index, 9), TYPE_LABEL[category["cost_type"]])
        for q, amount in enumerate(category["quarters"], start=4):
            write_input_number(ws.cell(index, q), amount)
        ws.cell(index, 8, f"=D{index}+E{index}+F{index}+G{index}")
    for q, col in enumerate("DEFG"):
        item = summary["quarters"][q]
        if item["exists"]:
            for field, row in INPUT_ROWS.items():
                write_input_number(ws[f"{col}{row}"], item["metrics"][field])
        formulas = {4: f"={col}13-{col}17", 5: f"=({col}10-{col}13-{col}18-{col}19)*0.2",
                    6: f"={col}10-{col}13-{col}18-{col}19", 7: f"={col}6-{col}5",
                    10: f"={col}8+{col}9", 11: f"={col}13-{col}12",
                    13: f"={col}10-{col}14-({col}10-{col}14)/1.2", 15: DEDUCTION_FORMULAS[q],
                    17: f"={col}16-{col}15", 19: f"=SUM({col}20:{col}{expense_end})"}
        for row, formula in formulas.items():
            ws[f"{col}{row}"] = formula
    for row in range(4, 20):
        if row == 6:
            formula = "=H10-H13-H18-H19"
        elif row == 7:
            formula = "=H6-H5"
        elif row == 15:
            formula = "=H14/H10*H16"
        elif row == 19:
            formula = f"=SUM(H20:H{expense_end})"
        else:
            formula = f"=D{row}+E{row}+F{row}+G{row}"
        ws[f"H{row}"] = formula
    border = Border(bottom=Side(style="hair", color="E1EAE3"))
    input_rows = set(INPUT_ROWS.values())
    for row in range(4, expense_end + 1):
        for col in range(2, 10):
            cell = ws.cell(row, col)
            cell.border = border
            if col in range(4, 8) and (row in input_rows or row >= 20):
                cell.fill = PatternFill("solid", fgColor="EDF7ED")
            elif col == 8 or (col in range(4, 8) and row < 20):
                cell.fill = PatternFill("solid", fgColor="F4F8F5")
            if col in range(4, 9):
                cell.number_format = '#,##0.00;[Red]-#,##0.00'
            if row in (4, 5, 6, 7, 10, 13, 19):
                cell.font = Font(bold=True, color="194F3B")
    ws.auto_filter.ref = f"B3:I{expense_end}"

    analysis = wb.create_sheet("Аналитика")
    analysis.sheet_view.showGridLines = False
    analysis.freeze_panes = "B6"
    analysis.column_dimensions["A"].width = 42
    for col in "BCDEF":
        analysis.column_dimensions[col].width = 20
    analysis.merge_cells("A1:F1")
    text_cell(analysis["A1"], "Анализ продаж, затрат и безубыточности")
    analysis["A1"].font = Font(size=14, bold=True, color="FFFFFF")
    analysis["A1"].fill = PatternFill("solid", fgColor="176C53")
    analysis.row_dimensions[1].height = 27
    text_cell(analysis["A2"], f"{summary['organization']['name']} · {summary['year']} год · {summary['quarter_count']}/4 кварталов")
    for col, value in enumerate(("Показатель", "1 квартал", "2 квартал", "3 квартал", "4 квартал", "Итого"), start=1):
        text_cell(analysis.cell(5, col), value)
        analysis.cell(5, col).fill = PatternFill("solid", fgColor="347F64")
        analysis.cell(5, col).font = Font(bold=True, color="FFFFFF")
    metrics = [
        ("Выручка с НДС", "metrics", "revenue"), ("Выручка без НДС", "metrics", "revenue_without_vat"),
        ("Себестоимость и затраты", "metrics", "total_costs"),
        ("Статьи затрат + НДС + налог на прибыль (без себестоимости реализации)", "metrics", "expense_tax_total"),
        ("Прибыль", "metrics", "profit"),
        ("Чистая прибыль", "metrics", "net_profit"), ("Чистая рентабельность, %", "metrics", "net_margin"),
        ("Постоянные затраты", "analysis", "fixed_costs"), ("Переменные затраты", "analysis", "variable_costs"),
        ("Маржинальный доход", "analysis", "contribution"), ("Маржинальность, %", "analysis", "contribution_margin"),
        ("Точка безубыточности, выручка без НДС", "analysis", "break_even_revenue"),
        ("Запас прочности", "analysis", "safety_amount"), ("Запас прочности, %", "analysis", "safety_percent"),
        ("Состояние расчёта безубыточности", "status", "break_even_status"),
    ]
    for row, (label, group, key) in enumerate(metrics, start=6):
        text_cell(analysis.cell(row, 1), label)
        for q in range(4):
            quarter = summary["quarters"][q]
            obj = quarter.get("analysis") if group in ("analysis", "status") else quarter.get("metrics")
            value = obj.get(key) if obj else None
            if group == "analysis" and obj and obj.get("break_even_status") == "unclassified" and key in {"fixed_costs", "variable_costs"}:
                value = None  # частичные суммы не выдаём за классифицированные целиком
            if group == "status":
                text_cell(analysis.cell(row, q + 2), STATUS_LABEL.get(value, "Нет данных"))
            elif key == "expense_tax_total" and value is None and quarter["exists"]:
                text_cell(analysis.cell(row, q + 2), "#ДЕЛ/0!")
            else:
                write_number(analysis.cell(row, q + 2), value)
        obj = summary.get("analysis") if group in ("analysis", "status") else summary.get("annual")
        value = obj.get(key) if obj and summary["quarter_count"] else None
        if group == "analysis" and obj and obj.get("break_even_status") == "unclassified" and key in {"fixed_costs", "variable_costs"}:
            value = None
        if group == "status":
            text_cell(analysis.cell(row, 6), STATUS_LABEL.get(value, "Нет данных"))
        elif key == "expense_tax_total" and value is None and summary["quarter_count"]:
            text_cell(analysis.cell(row, 6), "#ДЕЛ/0!")
        else:
            write_number(analysis.cell(row, 6), value)
        if row % 2 == 0:
            for cell in analysis[row][:6]:
                cell.fill = PatternFill("solid", fgColor="F4F8F5")
    text_cell(analysis["A21"], "Порог: постоянные затраты / (маржинальный доход / выручка без НДС). Себестоимость продаж — переменная.")
    text_cell(analysis["A22"], "Расчёт использует текущую структуру продаж и затрат; НДС статей показан только как ставка.")
    text_cell(analysis["A23"], "Аналитика и диаграммы — снимок при выгрузке. После правки входов загрузите и выгрузите отчёт заново.")
    for row in (21, 22, 23):
        analysis.merge_cells(f"A{row}:F{row}")
        analysis[f"A{row}"].font = Font(italic=True, size=10, color="668071")
        analysis[f"A{row}"].alignment = Alignment(wrap_text=True)
        analysis.row_dimensions[row].height = 28

    def make_chart(title: str, rows: list[int], anchor: str) -> None:
        chart = BarChart()
        chart.type = "col"
        chart.title = title
        chart.y_axis.title = "Сумма"
        chart.height = 8
        chart.width = 17
        chart.display_blanks = "gap"
        for row in rows:
            chart.add_data(Reference(analysis, min_col=1, max_col=5, min_row=row, max_row=row), titles_from_data=True, from_rows=True)
        chart.set_categories(Reference(analysis, min_col=2, max_col=5, min_row=5))
        analysis.add_chart(chart, anchor)

    make_chart("Выручка, затраты и чистая прибыль", [6, 8, 11], "A25")
    make_chart("Выручка без НДС и точка безубыточности", [7, 17], "J25")

    structure = summary["expense_structure"]
    text_cell(analysis["A49"], "Структура: все статьи + НДС к уплате + налог на прибыль; без себестоимости реализации")
    analysis.merge_cells("A49:F49")
    text_cell(analysis["A50"], "Статья / налог")
    text_cell(analysis["B50"], "Сумма")
    text_cell(analysis["C50"], "Доля, %")
    text_cell(analysis["D50"], "Все статьи и налоги — общий знаменатель")
    for row, item in enumerate(structure["items"], start=51):
        text_cell(analysis.cell(row, 1), item["name"] + (" (архив)" if item.get("archived") else ""))
        if item["amount"] is None:
            text_cell(analysis.cell(row, 2), "#ДЕЛ/0!")
        else:
            write_number(analysis.cell(row, 2), item["amount"])
        write_number(analysis.cell(row, 3), item["share_percent"])
    end = 51 + len(structure["items"])
    text_cell(analysis.cell(end, 1), "Общая сумма для долей")
    if structure["total"] is None and summary["quarter_count"]:
        text_cell(analysis.cell(end, 2), "#ДЕЛ/0!")
    else:
        write_number(analysis.cell(end, 2), structure["total"])

    meta = wb.create_sheet(META_SHEET)
    meta.sheet_state = "hidden"
    for coord, value in {"A1": SIGNATURE, "A2": "organization", "B2": summary["organization"]["name"],
                         "A3": "year", "B3": str(summary["year"]), "A4": "currency", "B4": summary["organization"]["currency"]}.items():
        text_cell(meta[coord], value)
    for q, period in enumerate(summary["quarters"], start=1):
        text_cell(meta.cell(1, 6 + q), f"q{q}_legacy_manual_deduction")
        if period.get("legacy_manual_deduction") is not None:
            text_cell(meta.cell(2, 6 + q), period["legacy_manual_deduction"])
    for col, value in enumerate(("sheet_row", "key", "name", "source_row", "archived"), start=1):
        text_cell(meta.cell(6, col), value)
    for row, category in enumerate(summary["expenses"], start=7):
        meta.cell(row, 1, row + 13)
        text_cell(meta.cell(row, 2), category["export_key"])
        text_cell(meta.cell(row, 3), category["name"])
        meta.cell(row, 4, category["source_row"])
        meta.cell(row, 5, bool(category["archived"]))
    wb.calculation = CalcProperties(calcMode="auto", fullCalcOnLoad=True, forceFullCalc=True)
    output = BytesIO()
    wb.save(output)
    wb.close()
    return output.getvalue()


def _validate_zip(data: bytes) -> None:
    if not data or len(data) > MAX_XLSX_BYTES:
        raise ValueError("Размер XLSX должен быть не более 10 МиБ.")
    try:
        with ZipFile(BytesIO(data)) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_ENTRIES or sum(info.file_size for info in infos) > MAX_UNCOMPRESSED:
                raise ValueError("XLSX слишком велик после распаковки.")
            names = set()
            for info in infos:
                path = PurePosixPath(info.filename)
                if path.is_absolute() or ".." in path.parts or info.flag_bits & 1:
                    raise ValueError("В XLSX обнаружен небезопасный или зашифрованный файл.")
                lower = info.filename.lower()
                if "vbaproject" in lower or lower.startswith("xl/externallinks/"):
                    raise ValueError("Файлы с макросами или внешними связями не поддерживаются.")
                names.add(info.filename)
            if "[Content_Types].xml" not in names or "xl/workbook.xml" not in names:
                raise ValueError("Это не книга XLSX.")
    except BadZipFile as exc:
        raise ValueError("Не удалось открыть XLSX: повреждённый файл.") from exc


def _name(value: Any) -> str:
    return " ".join(str(value or "").casefold().replace("ё", "е").split())


def _input_amount(cell: Any) -> Decimal | None:
    if cell.value is None or cell.value == "":
        return None
    if cell.data_type == "f":
        raise ValueError(f"Ячейка ввода {cell.coordinate} содержит формулу. Замените её сохранённым числовым значением.")
    if isinstance(cell.value, bool) or not isinstance(cell.value, (int, float, Decimal, str)):
        raise ValueError(f"В ячейке {cell.coordinate} ожидается число.")
    value = cell.value
    if isinstance(value, (int, float, Decimal)):
        value = format(Decimal(str(value)), "f")
    try:
        return parse_amount(value, f"Ячейка {cell.coordinate}")
    except ValueError as exc:
        raise ValueError(str(exc)) from exc


def _rate(cell: Any) -> str | None:
    if cell.value is None or cell.value == "":
        return None
    if cell.data_type == "f" or isinstance(cell.value, bool):
        raise ValueError(f"Ставка НДС в {cell.coordinate} должна быть числом, не формулой.")
    value = cell.value
    if isinstance(value, str) and value.strip().endswith("%"):
        value = value.strip()[:-1].strip()
    elif isinstance(value, (int, float, Decimal)):
        amount = Decimal(str(value))
        # Процент внутри кавычек или с экранированием — буквальная подпись,
        # а не масштабирование Excel на 100.
        numeric_format = re.sub(r'"[^"]*"|\\.', '', cell.number_format or "")
        if "%" in numeric_format:
            amount *= 100
        value = format(amount, "f")
    try:
        return valid_vat_rate(value)
    except ValueError as exc:
        raise ValueError(f"{cell.coordinate}: {exc}") from exc


def parse_report(data: bytes) -> dict[str, Any]:
    """Читает исходный шаблон или наш XLSX; формулы в полях ввода отклоняются."""
    _validate_zip(data)
    try:
        wb = load_workbook(BytesIO(data), data_only=False, read_only=True, keep_links=False)
    except Exception as exc:
        raise ValueError("Не удалось прочитать книгу XLSX; проверьте её формат и целостность.") from exc
    try:
        sheet = None
        for candidate in wb.worksheets:
            if candidate.sheet_state != "visible":
                continue
            row3 = next(candidate.iter_rows(min_row=3, max_row=3, min_col=4, max_col=7), ())
            headers = [re.sub(r"[^\w]", "", str(cell.value or "").casefold()) for cell in row3]
            if all(headers[i] in (f"{i+1}кв", f"{i+1}квартал", f"q{i+1}") for i in range(4)):
                sheet = candidate
                break
        if sheet is None:
            raise ValueError("Не найден лист с кварталами D3:G3 в формате исходной таблицы.")
        if sheet.max_row > MAX_ROWS:
            raise ValueError(f"На листе слишком много строк (предел {MAX_ROWS}).")
        # read_only .cell() заново разбирает XML от начала на каждый вызов.
        # Считываем 9 нужных столбцов один раз — линейно даже на 1000 статьях.
        sheet_rows = list(sheet.iter_rows(min_row=1, max_row=sheet.max_row, min_col=1, max_col=9))
        def cell(row: int, col: int) -> Any:
            return sheet_rows[row - 1][col - 1]
        for row, label, _key in REPORT_ROWS:
            if _name(cell(int(row), 2).value) != _name(label):
                raise ValueError(f"Строка B{row} не соответствует исходному шаблону: ожидается «{label}».")
        metadata: dict[str, Any] = {}
        meta_rows: dict[int, dict[str, Any]] = {}
        legacy_meta: list[Decimal | None] = [None] * 4
        if META_SHEET in wb.sheetnames:
            meta = wb[META_SHEET]
            signature = meta["A1"].value
            if signature not in SUPPORTED_SIGNATURES:
                raise ValueError("Неизвестная версия служебных данных XLSX.")
            metadata = {"organization": str(meta["B2"].value or ""), "year": str(meta["B3"].value or ""),
                        "currency": str(meta["B4"].value or ""), "format": signature}
            if signature == SIGNATURE:
                for q in range(1, 5):
                    header, value = meta.cell(1, 6 + q), meta.cell(2, 6 + q)
                    if header.value == f"q{q}_legacy_manual_deduction" and value.value not in (None, ""):
                        legacy_meta[q - 1] = _input_amount(value)
            if meta.max_row > MAX_ROWS + 10:
                raise ValueError("Слишком много строк служебных данных XLSX.")
            seen_keys = set()
            for meta_row in meta.iter_rows(min_row=7, max_row=meta.max_row, min_col=1, max_col=4):
                row_index, key, label, source_row = (item.value for item in meta_row)
                if row_index is None and key is None:
                    continue
                if not isinstance(row_index, int) or not 20 <= row_index <= MAX_ROWS or not isinstance(key, str):
                    raise ValueError("Повреждена привязка статей в XLSX.")
                if not re.fullmatch(r"(?:source:(?:2[0-9]|3[0-9]|4[0-7])|custom:[0-9a-f]{32})", key):
                    raise ValueError("Некорректный идентификатор статьи в XLSX.")
                if row_index in meta_rows or key in seen_keys:
                    raise ValueError("Повторная привязка статьи в XLSX.")
                seen_keys.add(key)
                meta_rows[row_index] = {"key": key, "name": str(label or ""), "source_row": source_row}
        categories = []
        source_names = {row: name for row, name, _tag in DEFAULT_CATEGORIES}
        for row in range(20, sheet.max_row + 1):
            label_cell = cell(row, 2)
            label = label_cell.value
            if label is None or not str(label).strip():
                if any(cell(row, col).value not in (None, "") for col in (3, 4, 5, 6, 7)):
                    raise ValueError(f"Строка {row}: укажите название статьи затрат.")
                if row in meta_rows:
                    raise ValueError(f"Статья из служебных данных в строке {row} отсутствует.")
                continue
            if label_cell.data_type == "f" or not isinstance(label, str) or len(label.strip()) > 120 or any(ord(c) < 32 for c in label):
                raise ValueError(f"Некорректное название статьи в B{row}.")
            label = label.strip()
            entry = meta_rows.get(row)
            if entry and _name(entry["name"]) != _name(label):
                raise ValueError(f"Название или порядок статьи B{row} изменён после экспорта. Добавляйте новые статьи в конце списка.")
            key = entry["key"] if entry else (f"source:{row}" if row in source_names and _name(source_names[row]) == _name(label) else None)
            rate = _rate(cell(row, 3))
            kind_cell = cell(row, 9)
            if kind_cell.data_type == "f":
                raise ValueError(f"Тип затрат в I{row} не должен быть формулой.")
            kind_text = str(kind_cell.value or "").strip().casefold()
            if kind_text and kind_text not in TYPE_PARSE:
                raise ValueError(f"Неизвестный тип затрат в I{row}: выберите «Постоянные» или «Переменные».")
            kind = TYPE_PARSE.get(kind_text, "unclassified") if metadata else None
            amounts = [_input_amount(cell(row, col)) for col in range(4, 8)]
            categories.append({"row": row, "name": label, "vat_rate": rate, "cost_type": kind,
                               "export_key": key, "amounts": amounts})
        if set(meta_rows) - {c["row"] for c in categories}:
            raise ValueError("Не все сохранённые статьи найдены в таблице.")
        quarters = {}
        for q in range(1, 5):
            values = {field: _input_amount(cell(row, q + 3)) for field, row in INPUT_ROWS.items()}
            expense_values = [category["amounts"][q - 1] for category in categories]
            if all(v is None for v in values.values()) and all(v is None for v in expense_values):
                continue
            missing = [field for field in INPUT_FIELDS if values[field] is None]
            if missing:
                missing_cell = f"{get_column_letter(q + 3)}{INPUT_ROWS[missing[0]]}"
                raise ValueError(f"{q} квартал заполнен не полностью: укажите число или 0 в {missing_cell}.")
            legacy = legacy_meta[q - 1]
            old_cell = cell(15, q + 3)
            # В старом шаблоне строка 15 была ручной. Новые формулы не исполняются;
            # числовое старое значение сохраняем только для истории.
            if legacy is None and old_cell.data_type not in ("f", "e") and old_cell.value not in (None, ""):
                legacy = _input_amount(old_cell)
            quarters[q] = {"inputs": values, "expenses": [v if v is not None else ZERO for v in expense_values],
                           "legacy_manual_deduction": legacy}
        if not quarters:
            raise ValueError("В книге нет заполненных кварталов для загрузки.")
        return {"metadata": metadata, "sheet": sheet.title, "categories": categories, "quarters": quarters}
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("Книга XLSX повреждена или содержит неподдерживаемые данные.") from exc
    finally:
        wb.close()
