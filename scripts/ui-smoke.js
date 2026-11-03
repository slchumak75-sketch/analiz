/* End-to-end тест на временной БД и системном Chrome/Edge, только синтетические значения. */
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
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (process.env.DEBUG_UI) {
      page.on('console', (message) => console.log('BROWSER:', message.type(), message.text()));
      page.on('response', (response) => { if (response.url().includes('/api/excel/')) console.log('EXCEL:', response.status(), response.url()); });
    }
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(url, { waitUntil: 'networkidle' });
    assert(await page.locator('#empty-onboarding').isVisible(), 'Новая база должна быть пустой');
    await page.locator('#onboarding-create').click();
    await page.locator('#org-name').fill('Тестовая организация');
    await page.locator('#org-currency').fill('ед.');
    await page.locator('#org-save').click();
    await page.waitForSelector('#main-content:not(.hidden)');
    assert.strictEqual(await page.locator('#context-org').innerText(), 'Тестовая организация');
    assert.strictEqual(await page.locator('.navigation').count(), 0, 'Разделы должны быть на одной странице');
    assert.strictEqual(await page.locator('[data-fill-quarter]').count(), 4);
    assert((await page.locator('.sheet-table thead').innerText()).includes('Итого за год'));

    await page.locator('#year-input').fill('2030');
    await page.locator('#year-input').press('Tab');
    await page.waitForFunction(() => document.querySelector('#context-year').textContent.includes('2030'));
    await page.locator('[data-fill-quarter="1"]').click();
    await page.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('120');
    await page.locator('[data-input="input_vat"][data-quarter="1"]').fill('10');
    await page.locator('[data-input="non_vat_deduction"][data-quarter="1"]').fill('2');
    await page.locator('[data-input="cost_of_sales"][data-quarter="1"]').fill('50');
    // Статья создаётся сразу, но черновик всех четырёх кварталов не теряется.
    await page.locator('#add-category').click();
    await page.locator('#category-name').fill('Реклама — тест');
    await page.locator('#category-rate').fill('20');
    await page.locator('#category-kind').selectOption('fixed');
    await page.locator('#category-form button[type="submit"]').click();
    const categoryRow = page.locator('#sheet-body tr').filter({ hasText: 'Реклама — тест' });
    await categoryRow.waitFor({ state: 'visible' });
    assert.strictEqual(await page.locator('[data-input="retail_revenue"][data-quarter="1"]').inputValue(), '120');
    await categoryRow.locator('[data-expense][data-quarter="1"]').fill('3');
    await page.waitForFunction(() => document.querySelector('[data-metric="net_profit"][data-quarter="1"]').textContent.replace(/\s/g, '') === '37,60');
    const breakEvenRow = page.locator('#analysis-body tr').filter({ hasText: 'Точка безубыточности' });
    await page.waitForFunction(() => [...document.querySelectorAll('#analysis-body tr')].some((r) => r.textContent.includes('Точка безубыточности') && r.cells[1].textContent.trim() === '6,00'));
    assert.strictEqual((await breakEvenRow.locator('td').nth(1).innerText()).trim(), '6,00');
    assert((await page.locator('#deduction-note').innerText()).includes('H17'));
    await page.locator('#year-form button[type="submit"]').first().click();
    await page.waitForFunction(() => document.querySelector('#q-status-1').textContent === 'сохранён');
    assert.strictEqual(await page.locator('#q-status-2').innerText(), 'нет данных');
    assert(await page.locator('#break-even-chart').isVisible(), 'График порога должен появиться');

    // Два окна не должны молча перезаписывать друг друга.
    const second = await page.context().newPage();
    second.on('dialog', (dialog) => dialog.accept());
    await second.goto(url, { waitUntil: 'networkidle' });
    await second.waitForFunction(() => document.querySelector('#context-year').textContent.includes('2030'));
    await page.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('121');
    const savedFirst = page.waitForResponse((response) => response.url().endsWith('/api/year') && response.request().method() === 'POST');
    await page.locator('#year-form button[type="submit"]').first().click();
    assert.strictEqual((await savedFirst).status(), 200);
    await page.waitForFunction(() => !document.querySelector('#application').inert && document.querySelector('#save-status').textContent.includes('сохранены'));
    await second.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('122');
    const staleSave = second.waitForResponse((response) => response.url().endsWith('/api/year') && response.request().method() === 'POST');
    await second.locator('#year-form button[type="submit"]').first().click();
    assert.strictEqual((await staleSave).status(), 400);
    await second.waitForFunction(() => document.querySelector('#toast').textContent.includes('другом окне'));
    assert.strictEqual(await second.locator('[data-input="retail_revenue"][data-quarter="1"]').inputValue(), '122');
    assert.strictEqual(await page.locator('[data-input="retail_revenue"][data-quarter="1"]').inputValue(), '121');
    await second.close();
    await page.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('120');
    const restored = page.waitForResponse((response) => response.url().endsWith('/api/year') && response.request().method() === 'POST');
    await page.locator('#year-form button[type="submit"]').first().click();
    assert.strictEqual((await restored).status(), 200);
    await page.waitForFunction(() => !document.querySelector('#application').inert && document.querySelector('#save-status').textContent.includes('сохранены'));

    const [xlsxDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#export-xlsx').click()]);
    const xlsx = path.join(temp, 'report.xlsx'); await xlsxDownload.saveAs(xlsx);
    assert.strictEqual(fs.readFileSync(xlsx).subarray(0, 2).toString(), 'PK');
    const [csvDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#export-csv').click()]);
    assert(fs.readFileSync(await csvDownload.path(), 'utf8').includes('37,6'), 'CSV должен содержать рассчитанную прибыль');
    const [backupDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#backup').click()]);
    assert.strictEqual(fs.readFileSync(await backupDownload.path()).subarray(0, 15).toString(), 'SQLite format 3');
    await page.reload({ waitUntil: 'networkidle' });
    assert.strictEqual((await page.locator('[data-metric="net_profit"][data-quarter="1"]').innerText()).replace(/\s/g, ''), '37,60');
    assert.strictEqual(await categoryRow.locator('[data-kind]').inputValue(), 'fixed');

    // Экспорт своей книги и явный импорт в выбранный ДРУГОЙ год.
    await page.locator('#year-input').fill('2031'); await page.locator('#year-input').press('Tab');
    await page.waitForFunction(() => document.querySelector('#context-year').textContent.includes('2031'));
    const importFile = async (file) => {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#import-xlsx').click()]);
      await chooser.setFiles(file);
      if (process.env.DEBUG_UI) console.log('FILE STATE', file, await page.locator('#xlsx-file').evaluate((el) => ({ name: el.files[0]?.name, size: el.files[0]?.size, value: el.value })));
      try { await page.locator('#import-dialog').waitFor({ state: 'visible', timeout: 10000 }); }
      catch (error) { throw new Error(`Не открылся предпросмотр ${file}: ${await page.locator('#toast').innerText()}\n${serverLogs}\n${error.message}`); }
    };
    await importFile(xlsx);
    assert((await page.locator('#import-summary').innerText()).includes('2030'), 'Год файла должен быть показан');
    assert((await page.locator('#import-summary').innerText()).includes('2031'), 'Год назначения должен быть показан');
    assert(await page.locator('#import-apply').isDisabled());
    await page.locator('#import-confirm').check(); await page.locator('#import-apply').click();
    await page.locator('#import-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#q-status-1').textContent === 'сохранён');
    assert.strictEqual(await page.locator('[data-input="retail_revenue"][data-quarter="1"]').inputValue(), '120');
    assert.strictEqual(await categoryRow.locator('[data-kind]').inputValue(), 'fixed');

    // Импорт в уже заполненный квартал по умолчанию не заменяет значения.
    await page.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('240');
    await page.locator('#year-form button[type="submit"]').first().click();
    await page.waitForFunction(() => document.querySelector('#q-status-1').textContent === 'сохранён' && document.querySelector('[data-input="retail_revenue"][data-quarter="1"]').value === '240');
    await importFile(xlsx);
    assert(await page.locator('#import-conflicts').isVisible());
    assert(await page.locator('input[name="import-mode"][value="skip"]').isChecked());
    assert(!(await page.locator('#import-settings').isChecked()), 'Настройки существующего года нельзя заменять по умолчанию');
    await page.locator('input[name="import-mode"][value="replace"]').check();
    await page.locator('#import-confirm').check(); await page.locator('#import-apply').click();
    await page.locator('#import-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('[data-input="retail_revenue"][data-quarter="1"]').value === '120');

    // Оригинальный шаблон тоже принимается на проверку, но в тестовую БД не загружается.
    const original = path.resolve(__dirname, '..', 'ОТЧЕТ ПО ОРГАНИЗАЦИИ мир.xlsx');
    await importFile({ name: path.basename(original), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: fs.readFileSync(original) });
    assert((await page.locator('#import-summary').innerText()).includes('1, 2, 3'));
    await page.locator('[data-close-dialog="import-dialog"]').first().click();
    await categoryRow.locator('[data-archive]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#sheet-body tr')].some((r) => r.textContent.includes('Реклама — тест') && r.textContent.includes('архив')));
    assert.strictEqual(await categoryRow.locator('[data-expense][data-quarter="1"]').inputValue(), '3');
    await page.setViewportSize({ width: 390, height: 844 });
    const sizes = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert(sizes[0] <= sizes[1], `Мобильная страница переполнена: ${sizes}`);
    assert.deepStrictEqual(errors, [], `Ошибки браузера: ${errors.join('; ')}`);
    console.log('UI smoke: одна страница, четыре квартала, аналитика, безубыточность, XLSX roundtrip/замена, CSV, backup, мобильный экран — OK.');
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) { /* Windows может освобождать файл с задержкой */ }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
