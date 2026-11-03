"""Точка входа Windows-приложения и локального сервера разработки."""
from __future__ import annotations

import argparse
from decimal import Decimal
import os
from pathlib import Path
import sys
import tempfile
import threading
import webbrowser

from analiz.calculations import INPUT_FIELDS, calculate_periods
from analiz.server import AnalizServer
from analiz.store import Store


def default_data_dir() -> Path:
    override = os.environ.get("ANALIZ_DATA_DIR")
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "AnalizOrganizaciy"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "analiz-organizaciy"


def self_test() -> None:
    """Короткий smoke test для собранного EXE, не использует реальные данные."""
    with tempfile.TemporaryDirectory(prefix="analiz-self-test-") as temp:
        store = Store(Path(temp) / "data.sqlite3")
        org = store.create_organization("Проверка")
        values = {key: "0" for key in INPUT_FIELDS}
        values.update(retail_revenue="120", non_vat_sales="12", input_vat="10")
        store.save_period(org["id"], 2026, 1, values, {})
        result = store.summary(org["id"], 2026)
        assert result["annual"]["output_vat"] == Decimal("18")
        assert result["quarters"][0]["metrics"]["non_vat_deduction"] == Decimal("1")
        assert result["annual"]["vat_due"] == Decimal("9")
        assert result["expense_structure"]["quarters"][0]["total"] == Decimal("29.4")
        assert next(item for item in result["expense_structure"]["items"] if item["kind"] == "vat")["quarter_amounts"][0] == Decimal("9")
        assert result["quarter_count"] == 1
        first = {key: Decimal(value) for key, value in values.items()}
        second = {**first, "non_vat_sales": Decimal("36")}
        periods, annual = calculate_periods([(first, []), (second, []), None, None])
        assert periods[1]["non_vat_deduction"] == Decimal("3")
        assert annual["non_vat_deduction"] == Decimal("4")
        from analiz.excel import make_report, parse_report
        report = parse_report(make_report(result))
        assert sorted(report["quarters"]) == [1] and report["metadata"]["year"] == "2026"
        assert (Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "web" / "index.html").exists()
        # Проверяем, что упакованный HTTP-сервер отдаёт HTML и health endpoint.
        from urllib.request import urlopen
        with AnalizServer(("127.0.0.1", 0), store) as server:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                base = f"http://127.0.0.1:{server.server_address[1]}"
                with urlopen(base + "/api/health", timeout=5) as response:
                    assert response.status == 200 and b'"status":"ok"' in response.read()
                with urlopen(base + "/", timeout=5) as response:
                    assert response.status == 200 and server.token.encode() in response.read()
            finally:
                server.shutdown()
                worker.join(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser(description="Локальный поквартальный анализ организации")
    parser.add_argument("--host", choices=("127.0.0.1", "0.0.0.0"), default="127.0.0.1", help="0.0.0.0 только для предпросмотра/разработки")
    parser.add_argument("--port", type=int, default=0, help="Порт; 0 выбирает свободный порт")
    parser.add_argument("--data-dir", type=Path, default=default_data_dir(), help="Папка локальной базы")
    parser.add_argument("--no-browser", action="store_true", help="Не открывать браузер автоматически")
    parser.add_argument("--self-test", action="store_true", help="Проверить сборку и выйти")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if not 0 <= args.port <= 65535:
        parser.error("Порт должен быть от 0 до 65535")
    store = Store(args.data_dir / "analiz.sqlite3")
    server = AnalizServer((args.host, args.port), store)
    port = server.server_address[1]
    url = f"http://127.0.0.1:{port}/"
    if sys.stdout:
        print(f"Адрес: {url}\nБаза: {store.database}\nОстановка: Ctrl+C или кнопка в приложении.", flush=True)
        if args.host != "127.0.0.1":
            print("Внимание: сервер доступен извне. Этот режим только для защищённого предпросмотра.", flush=True)
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        # В сборке --windowed нет консоли, поэтому критическую ошибку покажем в окне.
        if "--self-test" in sys.argv and getattr(sys, "frozen", False):
            raise SystemExit(1) from exc  # На CI не открывать модальное окно при ошибке.
        if os.name == "nt" and getattr(sys, "frozen", False):
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, str(exc), "Анализ организаций — ошибка запуска", 0x10)
        else:
            raise
        raise SystemExit(1)
