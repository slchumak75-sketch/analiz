"""Только локальный HTTP-интерфейс; финансовые данные не отправляются в сеть."""
from __future__ import annotations

import hmac
import json
import secrets
import sqlite3
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from . import __version__
from .calculations import json_ready
from .excel import MAX_XLSX_BYTES, make_report, parse_report
from .reports import report_csv
from .store import NotFoundError, Store

MAX_BODY = 1024 * 1024


def resources_dir() -> Path:
    # PyInstaller распаковывает ресурсы во временный _MEIPASS.
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return base / "web"


class AnalizServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: Store, web_root: Path | None = None):
        self.store = store
        self.web_root = (web_root or resources_dir()).resolve()
        self.token = secrets.token_urlsafe(32)
        self.local_only = address[0] == "127.0.0.1"
        self.import_previews: dict[str, dict[str, Any]] = {}
        self.import_lock = threading.Lock()
        super().__init__(address, AnalizHandler)


class AnalizHandler(BaseHTTPRequestHandler):
    server: AnalizServer
    server_version = "Analiz"
    sys_version = ""

    # Не записывать данные/URL и не обращаться к sys.stderr в оконной сборке.
    def log_message(self, _format: str, *args: Any) -> None:
        return

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'"
        # В режиме предпросмотра Arena встраивает сайт в iframe. В обычном
        # режиме loopback встраивание в сторонние страницы запрещено.
        if self.server.local_only:
            csp += "; frame-ancestors 'none'"
        self.send_header("Content-Security-Policy", csp)
        super().end_headers()

    def _bytes(self, status: int, body: bytes, content_type: str, *, filename: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(json_ready(payload), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._bytes(status, body, "application/json; charset=utf-8")

    def _host_allowed(self) -> bool:
        host = self.headers.get("Host", "")
        try:
            hostname = urlsplit("http://" + host).hostname
        except ValueError:
            return False
        if not hostname:
            return False
        return not self.server.local_only or hostname.lower() in ("127.0.0.1", "localhost", "::1")

    def _authorized(self) -> bool:
        provided = self.headers.get("X-Analiz-Token", "")
        return hmac.compare_digest(provided, self.server.token)

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True  # не браузер; всё равно требуется непредсказуемый токен
        try:
            parsed = urlsplit(origin)
            forwarded = self.headers.get("X-Forwarded-Host", "").split(",")[0].strip()
            return parsed.scheme in ("http", "https") and parsed.netloc.lower() in {
                self.headers.get("Host", "").lower(), forwarded.lower()
            }
        except ValueError:
            return False

    def _body(self) -> dict[str, Any]:
        if self.headers.get("Transfer-Encoding"):
            raise ValueError("Передача данных по частям не поддерживается.")
        length_text = self.headers.get("Content-Length", "0")
        if not length_text.isdigit() or int(length_text) > MAX_BODY:
            raise ValueError("Слишком большой или некорректный запрос.")
        if "application/json" not in self.headers.get("Content-Type", "").lower():
            raise ValueError("Ожидаются данные JSON.")
        try:
            result = json.loads(self.rfile.read(int(length_text)).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ValueError("Некорректные данные JSON.") from exc
        if not isinstance(result, dict):
            raise ValueError("Запрос должен содержать объект JSON.")
        return result

    def _query(self) -> tuple[str, dict[str, str]]:
        url = urlsplit(self.path)
        query = {k: values[-1] for k, values in parse_qs(url.query, keep_blank_values=True).items()}
        return url.path, query

    def _guard(self, path: str, *, mutating: bool = False) -> bool:
        if not self._host_allowed():
            self._json(HTTPStatus.FORBIDDEN, {"error": "Недопустимый адрес сервера."})
            return False
        if path.startswith("/api/") and path != "/api/health" and not self._authorized():
            self._json(HTTPStatus.FORBIDDEN, {"error": "Откройте приложение заново: недействительный токен."})
            return False
        if mutating and not self._origin_allowed():
            self._json(HTTPStatus.FORBIDDEN, {"error": "Запрос с другого сайта отклонён."})
            return False
        return True

    def _handle_errors(self, action: Any) -> None:
        try:
            action()
        except NotFoundError as exc:
            self._json(HTTPStatus.NOT_FOUND, {"error": str(exc)})
        except (ValueError, TypeError, KeyError) as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc) or "Некорректные данные."})
        except sqlite3.IntegrityError:
            self._json(HTTPStatus.CONFLICT, {"error": "Не удалось сохранить данные: нарушена целостность базы."})
        except (sqlite3.Error, OSError):
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Ошибка доступа к локальной базе. Проверьте место на диске и права доступа."})

    def do_GET(self) -> None:
        def run() -> None:
            path, query = self._query()
            if not self._guard(path):
                return
            store = self.server.store
            if path == "/api/health":
                return self._json(HTTPStatus.OK, {"status": "ok", "version": __version__})
            if path == "/api/organizations":
                return self._json(HTTPStatus.OK, {"organizations": store.list_organizations()})
            if path == "/api/categories":
                return self._json(HTTPStatus.OK, {"categories": store.categories(query.get("organization_id"))})
            if path == "/api/category-impact":
                return self._json(HTTPStatus.OK, store.category_impact(query.get("organization_id"), query.get("category_id")))
            if path == "/api/period":
                return self._json(HTTPStatus.OK, {"period": store.get_period(query.get("organization_id"), query.get("year"), query.get("quarter"))})
            if path == "/api/summary":
                return self._json(HTTPStatus.OK, store.summary(query.get("organization_id"), query.get("year")))
            if path == "/api/report.csv":
                summary = store.summary(query.get("organization_id"), query.get("year"))
                return self._bytes(HTTPStatus.OK, report_csv(summary), "text/csv; charset=utf-8", filename=f"analiz-{summary['year']}.csv")
            if path == "/api/report.xlsx":
                summary = store.summary(query.get("organization_id"), query.get("year"))
                return self._bytes(HTTPStatus.OK, make_report(summary), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename=f"analiz-{summary['year']}.xlsx")
            if path == "/api/backup":
                return self._bytes(HTTPStatus.OK, store.backup_bytes(), "application/vnd.sqlite3", filename="analiz-backup.sqlite3")
            # Явный список исключает чтение соседних файлов и обход путей.
            allowed = {"/": "index.html", "/index.html": "index.html", "/styles.css": "styles.css", "/app.js": "app.js",
                       "/vendor/chart.umd.js": "vendor/chart.umd.js", "/favicon.svg": "favicon.svg"}
            if path not in allowed:
                return self._json(HTTPStatus.NOT_FOUND, {"error": "Страница не найдена."})
            file_path = self.server.web_root / allowed[path]
            data = file_path.read_bytes()
            if allowed[path] == "index.html":
                data = data.replace(b"__ANALIZ_TOKEN__", self.server.token.encode("ascii"))
            # Не зависеть от реестра MIME-типов Windows (nosniff блокирует JS с неверным типом).
            content_type = {
                ".html": "text/html; charset=utf-8",
                ".css": "text/css; charset=utf-8",
                ".js": "application/javascript; charset=utf-8",
                ".svg": "image/svg+xml",
            }[file_path.suffix]
            return self._bytes(HTTPStatus.OK, data, content_type)
        self._handle_errors(run)

    def do_POST(self) -> None:
        def run() -> None:
            path, _ = self._query()
            if not self._guard(path, mutating=True):
                return
            store = self.server.store
            if path == "/api/excel/preview":
                if self.headers.get("Transfer-Encoding"):
                    raise ValueError("Передача данных по частям не поддерживается.")
                length = self.headers.get("Content-Length", "0")
                if not length.isdigit() or not 0 < int(length) <= MAX_XLSX_BYTES:
                    raise ValueError("Размер XLSX должен быть не более 10 МиБ.")
                if "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" not in self.headers.get("Content-Type", "").lower():
                    raise ValueError("Выберите файл XLSX.")
                report = parse_report(self.rfile.read(int(length)))
                _, query = self._query()
                plan = store.import_plan(query.get("organization_id"), query.get("year"), report)
                import_token = secrets.token_urlsafe(24)
                with self.server.import_lock:
                    now = time.monotonic()
                    self.server.import_previews = {k: v for k, v in self.server.import_previews.items() if now - v["created"] < 600}
                    if len(self.server.import_previews) >= 3:
                        oldest = min(self.server.import_previews, key=lambda k: self.server.import_previews[k]["created"])
                        del self.server.import_previews[oldest]
                    self.server.import_previews[import_token] = {"created": now, "report": report, "organization_id": plan["organization"]["id"], "year": plan["year"], "revision": plan["revision"]}
                return self._json(HTTPStatus.OK, {"preview_token": import_token, "plan": plan})
            body = self._body()
            if path == "/api/year/preview":
                return self._json(HTTPStatus.OK, store.preview_year(body.get("organization_id"), body.get("year"), body.get("quarters"), body.get("settings")))
            if path == "/api/year":
                if not isinstance(body.get("revision"), str):
                    raise ValueError("Версия данных отсутствует. Обновите страницу перед сохранением.")
                return self._json(HTTPStatus.OK, store.save_year(body.get("organization_id"), body.get("year"), body.get("quarters"), body.get("settings"), expected_revision=body["revision"]))
            if path == "/api/excel/import":
                preview_token = body.get("preview_token")
                if not isinstance(preview_token, str):
                    raise ValueError("Сначала проверьте файл XLSX.")
                with self.server.import_lock:
                    saved = self.server.import_previews.get(preview_token)
                    if not saved or time.monotonic() - saved["created"] >= 600:
                        raise ValueError("Предпросмотр устарел. Загрузите файл ещё раз.")
                    result = store.import_year(saved["organization_id"], saved["year"], saved["report"],
                        replace_existing=body.get("replace_existing"), apply_settings=body.get("apply_settings"),
                        expected_revision=saved["revision"])
                    self.server.import_previews.pop(preview_token, None)
                return self._json(HTTPStatus.OK, result)
            if path == "/api/organizations":
                return self._json(HTTPStatus.CREATED, {"organization": store.create_organization(body.get("name"), body.get("currency", ""))})
            if path == "/api/categories":
                revision = body.get("revision")
                if (revision is not None or body.get("year") is not None) and not isinstance(revision, str):
                    raise ValueError("Версия данных отсутствует. Обновите страницу перед добавлением статьи.")
                return self._json(HTTPStatus.CREATED, {"category": store.add_category(body.get("organization_id"), body.get("name"), body.get("tag", ""), year=body.get("year"), expected_revision=revision)})
            if path == "/api/period":
                period = store.save_period(body.get("organization_id"), body.get("year"), body.get("quarter"), body.get("inputs"), body.get("expenses"))
                return self._json(HTTPStatus.OK, {"period": period})
            if path == "/api/shutdown":
                self._json(HTTPStatus.OK, {"message": "Приложение остановлено."})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            return self._json(HTTPStatus.NOT_FOUND, {"error": "Команда не найдена."})
        self._handle_errors(run)

    def do_PATCH(self) -> None:
        def run() -> None:
            path, _ = self._query()
            if not self._guard(path, mutating=True):
                return
            body = self._body()
            store = self.server.store
            if path == "/api/organizations":
                org = store.update_organization(body.get("organization_id"), body.get("name"), body.get("currency", ""))
                return self._json(HTTPStatus.OK, {"organization": org})
            if path == "/api/categories":
                category = store.update_category(body.get("organization_id"), body.get("category_id"), archived=body.get("archived"))
                return self._json(HTTPStatus.OK, {"category": category})
            return self._json(HTTPStatus.NOT_FOUND, {"error": "Команда не найдена."})
        self._handle_errors(run)

    def do_DELETE(self) -> None:
        def run() -> None:
            path, _ = self._query()
            if not self._guard(path, mutating=True):
                return
            body = self._body()
            store = self.server.store
            if path == "/api/organizations":
                store.delete_organization(body.get("organization_id"))
                return self._json(HTTPStatus.OK, {"ok": True})
            if path == "/api/period":
                store.delete_period(body.get("organization_id"), body.get("year"), body.get("quarter"))
                return self._json(HTTPStatus.OK, {"ok": True})
            if path == "/api/categories":
                store.delete_category(body.get("organization_id"), body.get("category_id"),
                                      confirmed=body.get("confirmed"), expected_revision=body.get("revision"))
                return self._json(HTTPStatus.OK, {"ok": True})
            return self._json(HTTPStatus.NOT_FOUND, {"error": "Команда не найдена."})
        self._handle_errors(run)
