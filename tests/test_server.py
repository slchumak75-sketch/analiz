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
    inputs.update(retail_revenue="120", input_vat="10", cost_of_sales="50")
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


def request_xlsx(base, path, *, token=None, data=b'', origin=None, content_type=None):
    headers = {'Content-Type': content_type or 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}
    if token is not None:
        headers['X-Analiz-Token'] = token
    if origin is not None:
        headers['Origin'] = origin
    req = Request(base + path, data=data, method='POST', headers=headers)
    try:
        with urlopen(req, timeout=10) as response:
            return response.status, response.headers, response.read()
    except HTTPError as exc:
        return exc.code, exc.headers, exc.read()


def test_year_preview_and_excel_http_roundtrip(running_server):
    server, base = running_server
    org = server.store.create_organization('Тест', 'BYN')
    oid = org['id']
    cid = server.store.categories(oid)[0]['id']
    inputs = {key: '0' for key in INPUT_FIELDS}
    inputs.update(retail_revenue='120', cost_of_sales='50')
    quarters = {str(q): {'inputs': {}, 'expenses': {}} for q in range(1, 5)}
    quarters['1'] = {'inputs': inputs, 'expenses': {str(cid): '20'}}
    payload = {'organization_id': oid, 'year': 2026, 'revision': server.store.summary(oid, 2026)['revision'], 'quarters': quarters,
               'settings': {str(cid): {'cost_type': 'fixed', 'vat_rate': '0'}}}
    status, _, data = request(base, '/api/year/preview', method='POST', token=server.token, headers={'Origin': base}, body=payload)
    assert status == 200 and json.loads(data)['analysis']['break_even_revenue'] == '40'
    assert server.store.summary(oid, 2026)['quarter_count'] == 0
    status, _, _ = request(base, '/api/year', method='POST', token=server.token, headers={'Origin': base}, body=payload)
    assert status == 200 and server.store.summary(oid, 2026)['quarter_count'] == 1
    qs = urlencode({'organization_id': oid, 'year': 2026})
    status, headers, exported = request(base, '/api/report.xlsx?' + qs, token=server.token)
    assert status == 200 and exported.startswith(b'PK') and headers['Content-Type'].startswith('application/vnd.openxmlformats')
    target_query = urlencode({'organization_id': oid, 'year': 2027})
    endpoint = '/api/excel/preview?' + target_query
    assert request_xlsx(base, endpoint, data=exported)[0] == 403
    assert request_xlsx(base, endpoint, data=exported, token=server.token, origin='https://evil.example')[0] == 403
    assert request_xlsx(base, endpoint, data=b'broken', token=server.token, origin=base)[0] == 400
    status, _, data = request_xlsx(base, endpoint, data=exported, token=server.token, origin=base)
    preview = json.loads(data)
    assert status == 200 and preview['plan']['metadata']['year'] == '2026'
    assert preview['plan']['year'] == 2027 and preview['plan']['all_existing_quarters'] == []
    assert server.store.summary(oid, 2027)['quarter_count'] == 0
    body = {'preview_token': preview['preview_token'], 'replace_existing': False, 'apply_settings': True}
    status, _, data = request(base, '/api/excel/import', method='POST', token=server.token, headers={'Origin': base}, body=body)
    assert status == 200 and json.loads(data)['imported_quarters'] == [1]
    assert server.store.summary(oid, 2027)['analysis']['break_even_revenue'] == 40
    assert request(base, '/api/excel/import', method='POST', token=server.token, headers={'Origin': base}, body=body)[0] == 400


def test_import_preview_rechecks_revision_before_overwrite(running_server):
    server, base = running_server
    oid = server.store.create_organization('Конкурентная запись')['id']
    inputs = {key: '0' for key in INPUT_FIELDS}
    inputs['retail_revenue'] = '120'
    server.store.save_period(oid, 2026, 1, inputs, {})
    query = urlencode({'organization_id': oid, 'year': 2026})
    exported = request(base, '/api/report.xlsx?' + query, token=server.token)[2]
    status, _, data = request_xlsx(base, '/api/excel/preview?' + query, token=server.token, data=exported, origin=base)
    assert status == 200
    token = json.loads(data)['preview_token']
    inputs['retail_revenue'] = '999'
    server.store.save_period(oid, 2026, 1, inputs, {})  # другое окно изменило данные
    payload = {'preview_token': token, 'replace_existing': True, 'apply_settings': True}
    status, _, data = request(base, '/api/excel/import', method='POST', token=server.token, headers={'Origin': base}, body=payload)
    assert status == 400 and 'другом окне' in json.loads(data)['error']
    assert server.store.get_period(oid, 2026, 1)['inputs']['retail_revenue'] == '999'


def test_adding_category_preserves_concurrent_edit_guard(running_server):
    server, base = running_server
    oid = server.store.create_organization('Черновик')['id']
    revision = server.store.summary(oid, 2026)['revision']
    inputs = {key: '0' for key in INPUT_FIELDS}
    inputs['retail_revenue'] = '120'
    server.store.save_period(oid, 2026, 1, inputs, {})
    body = {'organization_id': oid, 'year': 2026, 'revision': revision, 'name': 'Новая статья', 'tag': '20'}
    status, _, data = request(base, '/api/categories', method='POST', token=server.token, headers={'Origin': base}, body=body)
    assert status == 400 and 'другом окне' in json.loads(data)['error']
    assert all(item['name'] != 'Новая статья' for item in server.store.categories(oid))
    body['revision'] = server.store.summary(oid, 2026)['revision']
    status, _, data = request(base, '/api/categories', method='POST', token=server.token, headers={'Origin': base}, body=body)
    assert status == 201
    assert json.loads(data)['category']['year_revision'] == server.store.summary(oid, 2026)['revision']


def test_category_archive_restore_and_confirmed_delete_all_years(running_server):
    server, base = running_server
    store = server.store
    oid = store.create_organization('Удаление')['id']
    cid = store.add_category(oid, 'Историческая статья', '20')['id']
    inputs = {key: '0' for key in INPUT_FIELDS}; inputs['retail_revenue'] = '120'
    for year, value in ((2024, '5'), (2026, '7')):
        store.save_period(oid, year, 1, inputs, {str(cid): value})
    empty_quarters = {str(q): {'inputs': {}, 'expenses': {}} for q in range(1, 5)}
    store.save_year(oid, 2025, empty_quarters, {str(cid): {'cost_type': 'fixed', 'vat_rate': '20'}})
    origin = {'Origin': base}
    archive = {'organization_id': oid, 'category_id': cid, 'archived': True}
    assert request(base, '/api/categories', method='PATCH', token=server.token, headers=origin, body=archive)[0] == 200
    assert store.summary(oid, 2024)['annual']['expense_total'] == 5
    archive['archived'] = False
    assert request(base, '/api/categories', method='PATCH', token=server.token, headers=origin, body=archive)[0] == 200
    impact_url = '/api/category-impact?' + urlencode({'organization_id': oid, 'category_id': cid})
    status, _, raw = request(base, impact_url, token=server.token)
    impact = json.loads(raw)
    assert status == 200 and impact['years'] == [2024, 2025, 2026]
    assert impact['period_count'] == 2 and impact['settings_count'] == 1
    delete = {'organization_id': oid, 'category_id': cid, 'confirmed': False, 'revision': impact['revision']}
    assert request(base, '/api/categories', method='DELETE', token=server.token, headers=origin, body=delete)[0] == 400
    store.save_period(oid, 2026, 1, inputs, {str(cid): '9'})  # другое окно после предупреждения
    delete['confirmed'] = True
    status, _, raw = request(base, '/api/categories', method='DELETE', token=server.token, headers=origin, body=delete)
    assert status == 400 and 'другом окне' in json.loads(raw)['error']
    assert store.summary(oid, 2024)['annual']['expense_total'] == 5
    delete['revision'] = json.loads(request(base, impact_url, token=server.token)[2])['revision']
    assert request(base, '/api/categories', method='DELETE', token=server.token, headers=origin, body=delete)[0] == 200
    assert all(c['id'] != cid for c in store.categories(oid))
    assert store.summary(oid, 2024)['annual']['expense_total'] == 0
    assert store.summary(oid, 2026)['annual']['expense_total'] == 0


def test_csv_distinguishes_missing_quarters_and_formula_errors(running_server):
    server, base = running_server
    oid = server.store.create_organization('Ошибки формул')['id']
    inputs = {key: '0' for key in INPUT_FIELDS}
    inputs.update(retail_revenue='120', non_vat_sales='12', input_vat='10')
    server.store.save_period(oid, 2026, 2, inputs, {})
    query = urlencode({'organization_id': oid, 'year': 2026})
    status, _, data = request(base, '/api/report.csv?' + query, token=server.token)
    assert status == 200
    rows = list(csv.reader(io.StringIO(data.decode('utf-8-sig')), delimiter=';'))
    deduction = next(row for row in rows if row and row[0] == '15')
    adjusted = next(row for row in rows if row and row[0] == '17')
    from decimal import Decimal
    assert deduction[2] == '' and deduction[3] == '#ДЕЛ/0!' and Decimal(deduction[6].replace(',', '.')) == 1
    assert adjusted[3] == '#ДЕЛ/0!' and adjusted[6] == '#ДЕЛ/0!'
