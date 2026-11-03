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
    assert.strictEqual(await page.locator('[data-input="non_vat_deduction"]').count(), 0, 'Строка вычета теперь расчётная');
    assert.strictEqual(await page.locator('[data-input="retail_revenue"]').count(), 4);
    assert((await page.locator('.sheet-table thead').innerText()).includes('Итого за год'));
    const fonts = await page.evaluate(() => ({ body: getComputedStyle(document.body).fontSize,
      table: getComputedStyle(document.querySelector('.sheet-table td')).fontSize,
      input: getComputedStyle(document.querySelector('.sheet-input')).fontSize,
      heading: getComputedStyle(document.querySelector('.page-heading h1')).fontSize }));
    assert.deepStrictEqual(fonts, { body: '28px', table: '22px', input: '22px', heading: '54px' }, 'Шрифт должен быть ровно вдвое крупнее прежнего');

    await page.locator('#year-input').fill('2030');
    await page.locator('#year-input').press('Tab');
    await page.waitForFunction(() => document.querySelector('#context-year').textContent.includes('2030'));
    await page.locator('[data-fill-quarter="1"]').click();
    await page.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('120');
    await page.locator('[data-input="input_vat"][data-quarter="1"]').fill('10');
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
    await page.waitForFunction(() => document.querySelector('#expense-chart') && !document.querySelector('#expense-chart').classList.contains('hidden'));
    assert.strictEqual((await page.locator('[data-metric="non_vat_deduction"][data-quarter="1"]').innerText()).trim(), '0,00');
    const choice = page.locator('.expense-choice').filter({ hasText: 'Реклама — тест' });
    assert((await choice.innerText()).includes('13,39%'), 'Доля статьи учитывает НДС и налог на прибыль, но не себестоимость');
    assert((await page.locator('.expense-choice').filter({ hasText: 'Налог НДС' }).innerText()).includes('44,64%'));
    assert((await page.locator('.expense-choice').filter({ hasText: 'Налог на прибыль' }).innerText()).includes('41,96%'));
    const denominator = await page.locator('#expense-denominator').innerText();
    assert(denominator.includes('22,40') && denominator.includes('себестоимость реализации не входит'));
    const configuration = await page.evaluate(() => { const c = Chart.getChart(document.querySelector('#expense-chart'));
      return { horizontal: c.options.indexAxis, duration: c.options.animation.duration, tick: c.options.scales.x.ticks.font.size, labels: c.data.labels.length }; });
    assert.deepStrictEqual(configuration, { horizontal: 'y', duration: 1000, tick: 20, labels: 3 });
    await page.locator('[data-expense-choice="vat"]').uncheck();
    assert.strictEqual(await page.locator('#expense-denominator').innerText(), denominator, 'Скрытие статьи не должно менять знаменатель');
    assert((await choice.innerText()).includes('13,39%'), 'Проценты остальных статей не пересчитываются');
    assert.strictEqual(await page.evaluate(() => Chart.getChart(document.querySelector('#expense-chart')).data.labels.length), 2);
    await page.locator('[data-expense-choice="vat"]').check();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => { const plot = document.querySelector('.expense-chart-scroll'); return plot.scrollWidth <= plot.clientWidth; });
    assert(await page.locator('#expense-chart').isVisible(), 'График долей должен помещаться на мобильном экране');
    assert.deepStrictEqual(await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), [390, 390]);
    await page.setViewportSize({ width: 1360, height: 900 });

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

    // Обе книги источника принимаются на проверку, но в тестовую БД не загружаются.
    for (const filename of ['ОТЧЕТ ПО ОРГАНИЗАЦИИ мир.xlsx', 'ОТЧЕТ ПО ОРГАНИЗАЦИИ мир 2.xlsx']) {
      const source = path.resolve(__dirname, '..', filename);
      await importFile({ name: filename, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: fs.readFileSync(source) });
      assert((await page.locator('#import-summary').innerText()).includes('1, 2, 3'));
      await page.locator('[data-close-dialog="import-dialog"]').first().click();
    }
    // Архив скрывает строку, сохранение другого показателя не стирает историю.
    await categoryRow.locator('[data-archive]').click();
    await page.waitForFunction(() => document.querySelector('#archive-count').textContent === '1');
    assert.strictEqual(await categoryRow.count(), 0, 'Архивная строка должна быть скрыта');
    await page.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('121');
    const saveWithArchive = page.waitForResponse((response) => response.url().endsWith('/api/year') && response.request().method() === 'POST');
    await page.locator('#year-form button[type="submit"]').first().click();
    assert.strictEqual((await saveWithArchive).status(), 200);
    await page.waitForFunction(() => document.querySelector('#q-status-1').textContent === 'сохранён');
    await page.locator('#toggle-archive').click();
    const archived = page.locator('.archive-item').filter({ hasText: 'Реклама — тест' });
    assert((await archived.innerText()).includes('3,00'));
    await archived.locator('[data-archive]').click();
    await categoryRow.waitFor({ state: 'visible' });
    assert.strictEqual(await categoryRow.locator('[data-expense][data-quarter="1"]').inputValue(), '3');
    // Скрыть снова, затем увидеть все затронутые годы перед отдельным удалением.
    await categoryRow.locator('[data-archive]').click();
    await page.waitForFunction(() => document.querySelector('#archive-count').textContent === '1');
    await archived.locator('[data-delete-category]').click();
    await page.locator('#delete-category-dialog').waitFor({ state: 'visible' });
    const impact = await page.locator('#delete-category-impact').innerText();
    assert(impact.includes('2030') && impact.includes('2031'), `Должны быть перечислены все годы: ${impact}`);
    assert(await page.locator('#delete-category-apply').isDisabled());
    await page.locator('[data-close-dialog="delete-category-dialog"]').first().click();
    assert.strictEqual(await page.locator('#archive-count').innerText(), '1');
    await archived.locator('[data-delete-category]').click();
    await page.locator('#delete-category-confirm').check();
    await page.locator('#delete-category-apply').click();
    await page.locator('#delete-category-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !document.querySelector('#application').inert && document.querySelector('#archive-count').textContent === '0');
    assert.strictEqual(await page.locator('#archive-count').innerText(), '0');
    assert.strictEqual(await categoryRow.count(), 0);

    // Пропущенный 1-й квартал даёт Excel #ДЕЛ/0!, даже если H15 определён.
    await page.locator('#year-input').fill('2032'); await page.locator('#year-input').press('Tab');
    await page.waitForFunction(() => document.querySelector('#context-year').textContent.includes('2032'));
    await page.locator('[data-fill-quarter="2"]').click();
    await page.locator('[data-input="retail_revenue"][data-quarter="2"]').fill('120');
    await page.locator('[data-input="non_vat_sales"][data-quarter="2"]').fill('12');
    await page.locator('[data-input="input_vat"][data-quarter="2"]').fill('10');
    await page.waitForFunction(() => document.querySelector('[data-metric="non_vat_deduction"][data-quarter="2"]').textContent === '#ДЕЛ/0!');
    const note = await page.locator('#deduction-note').innerText();
    assert(note.includes('1,00') && note.includes('#ДЕЛ/0!') && note.includes('сумма квартальных вычетов'));
    assert((await page.locator('#expense-denominator').innerText()).includes('НДС к уплате содержит #ДЕЛ/0!'));
    await page.setViewportSize({ width: 390, height: 844 });
    const sizes = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert(sizes[0] <= sizes[1], `Мобильная страница переполнена: ${sizes}`);
    assert.deepStrictEqual(errors, [], `Ошибки браузера: ${errors.join('; ')}`);
    console.log('UI smoke: вычеты, шрифты 2×, выбор долей и налоги, архив/восстановление/удаление, XLSX, конкуренция и мобильный экран — OK.');
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) { /* Windows может освобождать файл с задержкой */ }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
