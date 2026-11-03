/* End-to-end тест на временной БД и системном Chrome/Edge. Исходная книга не импортируется. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === 'win32' && path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    process.platform === 'win32' && path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    process.platform === 'win32' && path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    process.platform === 'linux' && '/usr/bin/google-chrome',
    process.platform === 'linux' && '/usr/bin/chromium',
    process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const result = candidates.find((candidate) => fs.existsSync(candidate));
  if (!result) throw new Error('Chrome/Edge не найден. Укажите CHROME_PATH для UI-теста.');
  return result;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
async function waitForServer(url, child, logs) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Сервер завершился: ${logs()}`);
    try { const response = await fetch(`${url}/api/health`); if (response.ok) return; } catch (_) { /* запуск */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Не дождались запуска сервера: ${logs()}`);
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'analiz-ui-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const python = process.env.PYTHON || 'python';
  const child = spawn(python, ['app.py', '--no-browser', '--port', String(port), '--data-dir', temp], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLogs = '';
  child.stdout.on('data', (chunk) => { serverLogs += chunk; });
  child.stderr.on('data', (chunk) => { serverLogs += chunk; });
  child.on('error', (error) => { serverLogs += error.stack; });
  let browser;
  try {
    await waitForServer(url, child, () => serverLogs);
    const args = process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process'] : [];
    browser = await chromium.launch({ executablePath: findBrowser(), headless: true, args });
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(url, { waitUntil: 'networkidle' });
    assert(await page.locator('#empty-onboarding').isVisible(), 'Новая база должна быть пустой');
    await page.locator('#onboarding-create').click();
    await page.locator('#org-name').fill('Тестовая организация');
    await page.locator('#org-currency').fill('ед.');
    await page.locator('#org-save').click();
    await page.waitForSelector('#main-content:not(.hidden)');
    assert.strictEqual(await page.locator('#context-org').innerText(), 'Тестовая организация');

    await page.locator('#year-input').fill('2030');
    await page.locator('#year-input').press('Tab');
    await page.waitForFunction(() => document.querySelector('#context-year').textContent.includes('2030'));
    await page.locator('.navigation [data-view="entry"]').click();
    assert(await page.locator('#entry-status').innerText() === 'Не заполнен');
    await page.locator('#fill-zero').click();
    await page.locator('#field-retail_revenue').fill('120');
    await page.locator('#field-input_vat').fill('10');
    await page.locator('#field-non_vat_deduction').fill('2');
    await page.locator('#field-cost_of_sales').fill('50');
    // Добавление статьи не должно терять ещё не сохранённые данные формы.
    await page.locator('#add-category-entry').click();
    await page.locator('#category-name').fill('Реклама — тест');
    await page.locator('#category-tag').fill('A');
    await page.locator('#category-form button[type="submit"]').click();
    await page.waitForSelector('#category-dialog', { state: 'hidden' });
    assert.strictEqual(await page.locator('#field-retail_revenue').inputValue(), '120');
    const categoryInput = page.locator('.expense-input').filter({ hasText: 'Реклама — тест' }).locator('input');
    await categoryInput.fill('3');
    await page.locator('#period-form button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#entry-status').textContent === 'Сохранён');
    await page.locator('.navigation [data-view="overview"]').click();
    const netProfit = page.locator('#financial-table-body tr').filter({ hasText: 'Чистая прибыль' }).first();
    assert.strictEqual((await netProfit.locator('td').nth(1).innerText()).replace(/\s/g, ''), '37,60');
    assert.strictEqual(await netProfit.locator('td').nth(2).innerText(), '—');
    assert((await page.locator('#deduction-note').innerText()).includes('H17'));

    await page.locator('.navigation [data-view="expenses"]').click();
    const categoryRow = page.locator('#expenses-table-body tr').filter({ hasText: 'Реклама — тест' });
    await categoryRow.locator('button').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#expenses-table-body tr')].some((r) => r.textContent.includes('Реклама — тест') && r.textContent.includes('архив')));
    await page.locator('.navigation [data-view="entry"]').click();
    assert.strictEqual(await page.locator('.expense-input').filter({ hasText: 'Реклама — тест' }).locator('input').inputValue(), '3');
    const savedArchivedPeriod = page.waitForResponse((response) => response.url().endsWith('/api/period') && response.request().method() === 'POST');
    await page.locator('#period-form button[type="submit"]').click();
    assert.strictEqual((await savedArchivedPeriod).status(), 200);
    await page.waitForLoadState('networkidle');
    await page.locator('.navigation [data-view="overview"]').click();
    assert.strictEqual((await netProfit.locator('td').nth(1).innerText()).replace(/\s/g, ''), '37,60');

    const [csvDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#export-csv').click()]);
    assert(fs.readFileSync(await csvDownload.path(), 'utf8').includes('37,6'), 'CSV должен содержать рассчитанную прибыль');
    await page.locator('.navigation [data-view="history"]').click();
    const [backupDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#backup').click()]);
    assert(fs.readFileSync(await backupDownload.path()).subarray(0, 15).toString() === 'SQLite format 3');
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.navigation [data-view="overview"]').click();
    assert.strictEqual((await netProfit.locator('td').nth(1).innerText()).replace(/\s/g, ''), '37,60', 'Квартал должен сохраниться после перезапуска страницы');
    await page.setViewportSize({ width: 390, height: 844 });
    const sizes = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert(sizes[0] <= sizes[1], `Мобильная страница переполнена: ${sizes}`);
    assert.deepStrictEqual(errors, [], `Ошибки браузера: ${errors.join('; ')}`);
    console.log('UI smoke test: организация, квартал, категории, расчёт, CSV, резервная копия и мобильный экран — OK.');
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) { /* Windows может освобождать файл с задержкой */ }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
