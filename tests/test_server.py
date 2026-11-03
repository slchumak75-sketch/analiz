from contextlib import contextmanager
import csv
import io
import json
from pathlib import Path
import threading
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pytest

from analiz.calculations import INPUT_FIELDS
from analiz.server import AnalizServer
from analiz.store import Store

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def running_server(tmp_path):
    server = AnalizServer(("127.0.0.1", 0), Store(tmp_path / "db.sqlite3"), ROOT / "web")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server, f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def request(base, path, *, method="GET", token=None, body=None, headers=None):
    all_headers = dict(headers or {})
    data = None
    if token is not None:
        all_headers["X-Analiz-Token"] = token
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        all_headers["Content-Type"] = "application/json"
    req = Request(base + path, data=data, method=method, headers=all_headers)
    try:
        with urlopen(req, timeout=5) as response:
            return response.status, response.headers, response.read()
    except HTTPError as exc:
        return exc.code, exc.headers, exc.read()


def test_static_health_and_security_boundaries(running_server):
    server, base = running_server
    status, headers, body = request(base, "/")
    assert status == 200 and server.token.encode() in body
    assert b"__ANALIZ_TOKEN__" not in body
    assert "frame-ancestors 'none'" in headers["Content-Security-Policy"]
    assert headers["Cache-Control"] == "no-store"
    assert request(base, "/api/health")[0] == 200
    assert request(base, "/vendor/chart.umd.js")[1]["Content-Type"].startswith("application/javascript")
    assert request(base, "/styles.css")[1]["Content-Type"].startswith("text/css")
    assert request(base, "/api/organizations")[0] == 403
    assert request(base, "/api/organizations", token="incorrect")[0] == 403
    assert request(base, "/api/organizations", token=server.token)[0] == 200
    assert request(base, "/api/health", headers={"Host": "evil.example"})[0] == 403
    assert request(base, "/api/organizations", method="POST", token=server.token,
                   headers={"Origin": "https://evil.example"}, body={"name": "x"})[0] == 403
    assert request(base, "/%2e%2e/app.py")[0] == 404
    assert request(base, "/app.py")[0] == 404
    assert request(base, "/api/organizations", method="POST", token=server.token,
                   body={"name": ""})[0] == 400


def test_api_end_to_end_csv_and_backup(running_server):
    server, base = running_server
    origin = {"Origin": base}
    status, _, body = request(base, "/api/organizations", method="POST", token=server.token,
                              headers=origin, body={"name": "=WEBSERVICE(\"bad\")", "currency": "ед."})
    assert status == 201
    oid = json.loads(body)["organization"]["id"]
    status, _, body = request(base, "/api/categories", method="POST", token=server.token,
                              headers=origin, body={"organization_id": oid, "name": "=1+1", "tag": ""})
    assert status == 201
    cid = json.loads(body)["category"]["id"]
    inputs = {key: "0" for key in INPUT_FIELDS}
    inputs.update(retail_revenue="120", input_vat="10", non_vat_deduction="2", cost_of_sales="50")
    status, _, _ = request(base, "/api/period", method="POST", token=server.token, headers=origin,
                           body={"organization_id": oid, "year": 2026, "quarter": 1, "inputs": inputs,
                                 "expenses": {str(cid): "3"}})
    assert status == 200
    qs = urlencode({"organization_id": oid, "year": 2026})
    status, _, body = request(base, "/api/summary?" + qs, token=server.token)
    summary = json.loads(body)
    assert status == 200
    assert summary["quarter_count"] == 1
    assert summary["annual"]["net_profit"] == "37.6"
    assert summary["quarters"][1]["metrics"] is None
    status, headers, data = request(base, "/api/report.csv?" + qs, token=server.token)
    assert status == 200 and headers["Content-Disposition"].endswith('"analiz-2026.csv"')
    rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig")), delimiter=";"))
    assert rows[0][1].startswith("'=WEBSERVICE")
    assert any(row[1].startswith("'=1+1") for row in rows if len(row) > 1)
    assert any(row[0] == "7" and row[2] == "37,6" for row in rows if len(row) > 2)
    status, headers, data = request(base, "/api/backup", token=server.token)
    assert status == 200 and data.startswith(b"SQLite format 3\x00")
    assert "analiz-backup.sqlite3" in headers["Content-Disposition"]
