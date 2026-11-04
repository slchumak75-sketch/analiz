/* End-to-end тест на временной БД и системном Chrome/Edge, только синтетические значения. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
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

async function assertNoHorizontalScroll(page, width) {
  await page.setViewportSize({ width, height: 900 });
  const result = await page.evaluate(() => {
    const selectors = '.table-scroll, .sheet-table, .analysis-table, .expense-chart-scroll, .stat-value';
    const offenders = [...document.querySelectorAll(selectors)]
      .filter((element) => element.offsetParent !== null && element.scrollWidth > element.clientWidth + 1)
      .map((element) => ({ name: element.className, scroll: element.scrollWidth, client: element.clientWidth }));
    const wide = [...document.querySelectorAll('body *')].filter((element) => element.offsetParent !== null && !element.matches('input, select, canvas'))
      .map((element) => ({ name: `${element.tagName}.${element.className}`, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }))
      .filter((element) => element.right > innerWidth + 1 || element.left < -1).slice(0, 10);
    return { document: document.documentElement.scrollWidth, viewport: innerWidth, offenders, wide };
  });
  assert(result.document <= result.viewport && result.offenders.length === 0 && result.wide.length === 0, `Горизонтальная прокрутка при ${width}px: ${JSON.stringify(result)}`);
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
    let acceptDialogs = true;
    page.on('dialog', (dialog) => acceptDialogs ? dialog.accept() : dialog.dismiss());
    await page.goto(url, { waitUntil: 'networkidle' });
    assert(await page.locator('#empty-onboarding').isVisible(), 'Новая база должна быть пустой');
    await page.locator('#onboarding-create').click();
    await page.locator('#org-name').fill('Тестовая организация');
    await page.locator('#org-currency').fill('ед.');
    await page.locator('#org-save').click();
    await page.waitForSelector('#main-content:not(.hidden)');
    assert.strictEqual(await page.locator('#context-org').innerText(), 'Тестовая организация');
    assert.strictEqual(await page.locator('.navigation').count(), 0, 'Разделы должны быть на одной странице');
    assert.strictEqual(await page.locator('[data-open-quarter-menu]').count(), 12, 'В каждом разделе есть заголовки четырёх кварталов');
    assert.strictEqual(await page.locator('#sheet-table [data-quarter-status], #sheet-table [data-fill-quarter], #sheet-table [data-delete-quarter], #sheet-table .quarter-actions').count(), 0, 'Статусы и кнопки убраны из всех шапок');
    assert.strictEqual(await page.locator('[data-input="non_vat_deduction"]').count(), 0, 'Строка вычета теперь расчётная');
    assert.strictEqual(await page.locator('[data-input="retail_revenue"]').count(), 4);
    const sheetGroups = ['financial', 'sales', 'expenses'];
    const quarterTrigger = (group, q) => page.locator(`[data-sheet-header="${group}"] [data-open-quarter-menu="${q}"]`);
    const openQuarterMenu = async (group, q) => {
      await quarterTrigger(group, q).click();
      await page.locator('#quarter-actions-menu').waitFor({ state: 'visible' });
    };
    const fillQuarter = async (q, group = 'financial') => {
      await openQuarterMenu(group, q);
      await page.locator(`#quarter-actions-menu [data-fill-quarter="${q}"]`).click();
      assert(await page.locator('#quarter-actions-menu').isHidden());
    };
    const assertCleanHeaders = async () => {
      assert.strictEqual(await page.locator('#sheet-table [data-quarter-status], #sheet-table [data-fill-quarter], #sheet-table [data-delete-quarter], #sheet-table .quarter-actions').count(), 0);
      for (const group of sheetGroups) {
        const text = await page.locator(`[data-sheet-header="${group}"]`).textContent();
        assert(!/сохранён|нет данных|не заполнен|черновик|\+ нули|×/.test(text), `Лишний текст в шапке ${group}: ${text}`);
      }
    };
    for (const group of sheetGroups) {
      const header = page.locator(`[data-sheet-header="${group}"]`);
      assert(await header.isVisible());
      for (const name of ['Показатель / статья затрат', 'НДС, %', 'Тип затрат', '1 квартал', '2 квартал', '3 квартал', '4 квартал', 'Итого за год']) assert((await header.innerText()).includes(name), `${group}: нет ${name}`);
      assert.strictEqual(await header.locator('th[scope="col"]').count(), 8);
      assert.strictEqual(await header.locator('[data-open-quarter-menu]').count(), 4);
    }
    await assertCleanHeaders();
    // Меню открывается клавиатурой и не показывает несуществующее удаление активным.
    const firstQuarter = quarterTrigger('financial', 1);
    await firstQuarter.press('Enter');
    assert.strictEqual(await firstQuarter.getAttribute('aria-expanded'), 'true');
    assert(await page.locator('#quarter-actions-menu [data-delete-quarter="1"]').isDisabled());
    await page.keyboard.press('ArrowDown');
    assert(await page.locator('#quarter-actions-menu [data-fill-quarter="1"]').evaluate((el) => el === document.activeElement));
    await page.keyboard.press('Escape');
    assert(await page.locator('#quarter-actions-menu').isHidden());
    assert(await firstQuarter.evaluate((el) => el === document.activeElement));
    await firstQuarter.click(); await page.keyboard.press('Tab');
    assert(await page.locator('#quarter-actions-menu').isHidden());
    assert(await quarterTrigger('financial', 2).evaluate((el) => el === document.activeElement));
    // Шапка непосредственно под каждым открытым разделом; все восемь комбинаций независимы.
    for (let mask = 0; mask < 8; mask++) {
      for (const [index, group] of sheetGroups.entries()) {
        const toggle = page.locator(`[data-panel-toggle="${group}"]`), shouldOpen = Boolean(mask & (1 << index));
        if ((await toggle.getAttribute('aria-expanded') === 'true') !== shouldOpen) await toggle.click();
        assert.strictEqual(await page.locator(`[data-sheet-header="${group}"]`).isVisible(), shouldOpen, `Шапка ${group}, комбинация ${mask}`);
      }
    }
    // На узком экране также проверяем любую комбинацию: шапка следует за своим разделом.
    await assertNoHorizontalScroll(page, 320);
    for (let mask = 0; mask < 8; mask++) {
      for (const [index, group] of sheetGroups.entries()) {
        const toggle = page.locator(`[data-panel-toggle="${group}"]`), shouldOpen = Boolean(mask & (1 << index));
        if ((await toggle.getAttribute('aria-expanded') === 'true') !== shouldOpen) await toggle.click();
        const header = page.locator(`[data-sheet-header="${group}"]`);
        assert.strictEqual(await header.isVisible(), shouldOpen, `Узкая шапка ${group}, комбинация ${mask}`);
        if (shouldOpen) {
          assert(await header.locator('[data-open-quarter-menu="4"]').isVisible());
          assert((await header.innerText()).includes('1 квартал'));
        }
      }
      await assertNoHorizontalScroll(page, 320);
    }
    assert.strictEqual((await page.locator('#expense-plot-area').boundingBox()).height, 660, 'График на узком экране вдвое выше');
    for (const button of await page.locator('.heading-actions .button').all()) {
      assert(await button.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'Текст кнопок помещается на узком экране');
    }
    // Настоящее касание заголовка открывает меню и оно помещается в окне.
    const touchQuarter = quarterTrigger('sales', 4);
    await touchQuarter.scrollIntoViewIfNeeded();
    const touchQuarterBox = await touchQuarter.boundingBox();
    const quarterCdp = await context.newCDPSession(page);
    await quarterCdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await quarterCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchQuarterBox.x + touchQuarterBox.width / 2, y: touchQuarterBox.y + touchQuarterBox.height / 2 }] });
    await quarterCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.locator('#quarter-actions-menu').waitFor({ state: 'visible' });
    const quarterMenuBox = await page.locator('#quarter-actions-menu').boundingBox();
    assert(quarterMenuBox.x >= 0 && quarterMenuBox.x + quarterMenuBox.width <= 320 && quarterMenuBox.y >= 0 && quarterMenuBox.y + quarterMenuBox.height <= 900);
    await page.keyboard.press('Escape');
    await quarterCdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await quarterCdp.detach();
    await page.setViewportSize({ width: 1360, height: 900 });
    assert.strictEqual((await page.locator('#expense-plot-area').boundingBox()).height, 800, 'График на широком экране вдвое выше');
    assert(await page.locator('#save-status').isHidden() && await page.locator('#preview-status').isHidden());
    assert.strictEqual(await page.locator('#deduction-note, #expense-chart-note, .sheet-note').count(), 0);
    const unwanted = ['ПРОДАЖИ · ЗАТРАТЫ · РЕЗУЛЬТАТ', 'Таблица и вся аналитика — на одной странице', 'Локальное хранение', 'КВАРТАЛЬНЫЙ ОТЧЁТ', 'Поля ввода выделены зелёным', 'Строки и формулы соответствуют исходной таблице', 'Все изменения сохранены', 'Данные на вашем компьютере', 'Вычет по формуле H15', 'Прежние ручные вычеты (не используются в расчётах)', 'ИНТЕРПРЕТАЦИЯ РЕЗУЛЬТАТОВ', 'Показатели по введённым кварталам', 'ВЫРУЧКА БЕЗ НДС', 'Себестоимость продаж — переменная', 'Точка безубыточности = постоянные затраты', 'НАГЛЯДНАЯ КАРТИНА', 'Суммы статей и налогов по кварталам выбранного года', 'СТРУКТУРА', 'Суммы выбранных статей и налогов по кварталам, руб.', 'Показаны суммы статей, НДС к уплате'];
    const visibleText = await page.locator('#main-content').innerText();
    for (const text of unwanted) assert(!visibleText.includes(text), `Убрана подпись: ${text}`);
    const fonts = await page.evaluate(() => ({ body: getComputedStyle(document.body).fontSize,
      table: getComputedStyle(document.querySelector('.sheet-table td')).fontSize,
      input: getComputedStyle(document.querySelector('.sheet-input')).fontSize,
      heading: getComputedStyle(document.querySelector('.page-heading h1')).fontSize }));
    assert.deepStrictEqual(fonts, { body: '21px', table: '16.5px', input: '16.5px', heading: '40.5px' }, 'Шрифты должны быть на 25% меньше версии 3.0');

    await page.locator('#year-input').fill('2030');
    await page.locator('#year-input').press('Tab');
    await page.waitForFunction(() => document.querySelector('#context-year').textContent.includes('2030'));
    await fillQuarter(1);
    await page.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('120');
    await page.locator('[data-input="input_vat"][data-quarter="1"]').fill('10');
    await page.locator('[data-input="cost_of_sales"][data-quarter="1"]').fill('50');
    // Статья создаётся сразу, но черновик всех четырёх кварталов не теряется.
    await page.locator('#add-category').click();
    await page.locator('#category-name').fill('Реклама — тест');
    await page.locator('#category-rate').fill('20');
    await page.locator('#category-kind').selectOption('fixed');
    await page.locator('#category-form button[type="submit"]').click();
    const categoryRow = page.locator('#sheet-expense-rows tr').filter({ hasText: 'Реклама — тест' });
    await categoryRow.waitFor({ state: 'visible' });
    assert.strictEqual(await page.locator('[data-input="retail_revenue"][data-quarter="1"]').inputValue(), '120');
    await categoryRow.locator('[data-expense][data-quarter="1"]').fill('3');
    await fillQuarter(2, 'sales');
    await page.locator('[data-input="retail_revenue"][data-quarter="2"]').fill('120');
    await page.locator('[data-input="input_vat"][data-quarter="2"]').fill('10');
    await page.locator('[data-input="cost_of_sales"][data-quarter="2"]').fill('50');
    await categoryRow.locator('[data-expense][data-quarter="2"]').fill('6');
    await page.waitForFunction(() => document.querySelector('[data-metric="net_profit"][data-quarter="1"]').textContent.replace(/\s/g, '') === '37,60');
    const breakEvenRow = page.locator('#analysis-body tr').filter({ hasText: 'Точка безубыточности' });
    await page.waitForFunction(() => [...document.querySelectorAll('#analysis-body tr')].some((r) => r.textContent.includes('Точка безубыточности') && r.cells[1].querySelector('.cell-value').textContent.trim() === '6,00'));
    assert.strictEqual((await breakEvenRow.locator('td').nth(1).innerText()).trim(), '6,00');
    assert(await page.locator('#save-status').isVisible(), 'Черновик нельзя выдать за сохранённый');
    await page.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('не число');
    await page.locator('#preview-status.error').waitFor({ state: 'visible' });
    await page.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('120');
    await page.waitForFunction(() => document.querySelector('#preview-status').classList.contains('hidden'));
    // Наведение на статью не должно отнимать фокус у меню квартала, открытого клавиатурой.
    const expenseQuarter = quarterTrigger('expenses', 1);
    await expenseQuarter.scrollIntoViewIfNeeded();
    await expenseQuarter.press('Enter');
    await page.locator('#sheet-expense-rows [data-open-category-menu]').first().hover();
    assert(await page.locator('#quarter-actions-menu').isVisible());
    assert(await page.locator('#category-actions-menu').isHidden());
    assert(await page.locator('#quarter-actions-menu [data-fill-quarter="1"]').evaluate((el) => el === document.activeElement));
    await page.keyboard.press('Escape');
    // Меню из ведомости затрат действует на общие поля выбранного квартала.
    await fillQuarter(3, 'expenses');
    for (const input of await page.locator('[data-input][data-quarter="3"]').all()) {
      assert.strictEqual(await input.inputValue(), '0'); await input.fill('');
    }
    await assertCleanHeaders();
    // Пять плашек независимы; сворачивание не исключает черновик из сохранения.
    const panels = [
      ['financial', '#sheet-financial-rows'], ['sales', '#sheet-sales-rows'], ['expenses', '#sheet-expense-rows'],
      ['analysis', '#panel-analysis'], ['chart', '#panel-expense-chart'],
    ];
    assert.strictEqual(await page.locator('[data-panel-toggle]').count(), 5);
    for (const [key, body] of panels) {
      const button = page.locator(`[data-panel-toggle="${key}"]`);
      assert.strictEqual(await button.getAttribute('aria-expanded'), 'true');
      if (key === 'financial') await button.press('Enter'); else await button.click();
      assert.strictEqual(await button.getAttribute('aria-expanded'), 'false');
      assert(await page.locator(body).isHidden(), `${key} должен свернуться`);
    }
    assert(await page.locator('#category-management').isHidden());
    assert.strictEqual(await page.locator('[data-input="retail_revenue"][data-quarter="1"]').inputValue(), '120');
    assert.strictEqual(await categoryRow.locator('[data-expense][data-quarter="2"]').inputValue(), '6');
    const savedClosedPanels = page.waitForResponse((response) => response.url().endsWith('/api/year') && response.request().method() === 'POST');
    await page.locator('#year-form button[type="submit"]').first().click();
    assert.strictEqual((await savedClosedPanels).status(), 200);
    await page.waitForFunction(() => !document.querySelector('#application').inert && document.querySelector('#save-status').classList.contains('hidden'));
    assert(await page.locator('#save-status').isHidden(), 'Статус сохранения не занимает место после успешной записи');
    await assertCleanHeaders();
    // Синтетическая история старой версии: проверяем доступ к ней без постоянного блока под таблицей.
    execFileSync(python, ['-c', `import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
 c=db.execute("UPDATE periods SET legacy_manual_deduction='7.25' WHERE year=2030 AND quarter=1")
 assert c.rowcount == 1
`, path.join(temp, 'analiz.sqlite3')]);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('[data-input="retail_revenue"][data-quarter="1"]')?.value === '120');
    await assertCleanHeaders();
    for (const [key, body] of panels) {
      const button = page.locator(`[data-panel-toggle="${key}"]`);
      assert.strictEqual(await button.getAttribute('aria-expanded'), 'false', 'Состояние плашки сохраняется при перезагрузке');
      assert(await page.locator(body).isHidden());
      await button.click();
      assert.strictEqual(await button.getAttribute('aria-expanded'), 'true');
      assert(await page.locator(body).isVisible());
    }
    assert.strictEqual(await page.locator('[data-input="retail_revenue"][data-quarter="1"]').inputValue(), '120');
    assert.strictEqual(await categoryRow.locator('[data-expense][data-quarter="2"]').inputValue(), '6');
    const legacyValue = page.locator('[data-metric="non_vat_deduction"][data-quarter="1"]');
    assert.strictEqual((await legacyValue.innerText()).trim(), '0,00', 'Исторический вычет не меняет расчёт');
    assert.strictEqual(await legacyValue.getAttribute('role'), 'button');
    assert((await legacyValue.getAttribute('aria-label')).includes('7,25'));
    await legacyValue.press('Enter');
    assert((await page.locator('#toast').innerText()).includes('7,25'));
    await legacyValue.click();
    assert((await page.locator('#toast').innerText()).includes('не используется'));
    await page.waitForFunction(() => Chart.getChart(document.querySelector('#expense-chart'))?.width > 0);
    assert.strictEqual(await page.locator('canvas').count(), 1, 'На странице должен остаться только график статей затрат');
    assert.strictEqual(await page.locator('#quarter-chart, #break-even-chart, #history-chart, #tax-chart').count(), 0);
    await page.waitForFunction(() => document.querySelector('#expense-chart') && !document.querySelector('#expense-chart').classList.contains('hidden'));
    assert.strictEqual((await page.locator('[data-metric="non_vat_deduction"][data-quarter="1"]').innerText()).trim(), '0,00');
    const choice = page.locator('.expense-choice').filter({ hasText: 'Реклама — тест' });
    assert.strictEqual((await choice.innerText()).trim(), 'Реклама — тест', 'Слева только название, без ставки, суммы и процента');
    assert.strictEqual((await page.locator('.expense-choice').filter({ hasText: 'Налог НДС' }).innerText()).trim(), 'Налог НДС');
    assert.strictEqual((await page.locator('.expense-choice').filter({ hasText: 'Налог на прибыль' }).innerText()).trim(), 'Налог на прибыль');
    assert(await page.locator('#expense-chart-warning').isHidden());
    assert((await page.locator('#expense-chart').getAttribute('title')).includes('без конвертации'));
    assert((await page.locator('#expense-chart').getAttribute('aria-label')).includes('без конвертации'));
    const configuration = await page.evaluate(() => {
      const c = Chart.getChart(document.querySelector('#expense-chart'));
      const line = c.data.datasets.find((d) => d.label === 'Реклама — тест');
      return { type: c.config.type, duration: c.options.animation.duration, tick: c.options.scales.y.ticks.font.size,
        unit: c.options.scales.y.title.text, labels: c.data.labels, names: c.data.datasets.map((d) => d.label), values: line.data,
        colors: c.data.datasets.map((d) => d.backgroundColor),
        swatches: c.data.datasets.map((d) => document.querySelector(`[data-expense-choice="${d.expenseKey}"]`).parentElement.querySelector('.expense-series-dot').style.getPropertyValue('--series-color')),
        tooltip: c.options.plugins.tooltip.callbacks.label({ dataset: line, dataIndex: 0, raw: line.data[0] }) };
    });
    assert.strictEqual(configuration.type, 'bar');
    assert.strictEqual(configuration.duration, 1000);
    assert.strictEqual(configuration.tick, 15);
    assert.strictEqual(configuration.unit, 'Сумма, руб.');
    assert.deepStrictEqual(configuration.labels, ['1 кв.', '2 кв.', '3 кв.', '4 кв.']);
    assert.deepStrictEqual(new Set(configuration.names), new Set(['Реклама — тест', 'Налог НДС', 'Налог на прибыль']));
    assert.strictEqual(new Set(configuration.colors).size, configuration.names.length, 'Выбранные ряды различаются цветом');
    assert.deepStrictEqual(configuration.swatches, configuration.colors, 'Цвета списка и столбцов совпадают');
    assert.deepStrictEqual(configuration.values, [3, 6, null, null], 'График использует суммы, не проценты');
    assert(configuration.tooltip.includes('3,00 руб.') && !configuration.tooltip.includes('%') && !configuration.tooltip.includes('ед.'), 'По решению владельца график всегда подписан в рублях');
    const heights = await page.evaluate(() => {
      const area = document.querySelector('#expense-plot-area'), chart = Chart.getChart(document.querySelector('#expense-chart'));
      const index = chart.data.datasets.findIndex((d) => d.label === 'Реклама — тест');
      const measure = () => { chart.stop(); chart.resize(); chart.update('none'); const bar = chart.getDatasetMeta(index).data[0]; return { canvas: chart.height, bar: Math.abs(bar.base - bar.y) }; };
      const tall = measure();
      area.style.height = '400px'; const original = measure();
      area.style.removeProperty('height'); measure();
      return { tall, original, values: chart.data.datasets[index].data };
    });
    assert.strictEqual(heights.tall.canvas, 800);
    assert.strictEqual(heights.original.canvas, 400);
    assert(heights.tall.bar >= heights.original.bar * 1.9 && heights.tall.bar <= heights.original.bar * 2.3, `Высота столбца: ${JSON.stringify(heights)}`);
    assert.deepStrictEqual(heights.values, configuration.values, 'Увеличение высоты не меняет данные');
    const initialBarWidth = await page.evaluate(() => {
      const c = Chart.getChart(document.querySelector('#expense-chart')); c.update('none');
      return c.getDatasetMeta(c.data.datasets.findIndex((d) => d.label === 'Реклама — тест')).data[0].width;
    });
    await page.locator('#expense-select-all').click();
    const allSelected = await page.evaluate(() => {
      const c = Chart.getChart(document.querySelector('#expense-chart')); c.update('none');
      const zero = c.data.datasets.filter((d) => d.grouped === false);
      return { width: c.getDatasetMeta(c.data.datasets.findIndex((d) => d.label === 'Реклама — тест')).data[0].width,
        zeroCount: zero.length, zeroValues: zero[0].data };
    });
    assert(allSelected.zeroCount >= 20 && allSelected.zeroValues[0] === 0, 'Нулевые ряды остаются нулями');
    assert(allSelected.width >= initialBarWidth * .95, 'Нулевые ряды не сжимают видимые столбцы');
    await page.locator('#expense-select-none').click();
    await choice.locator('input').check();
    await page.locator('[data-expense-choice="vat"]').check();
    await page.locator('[data-expense-choice="profit_tax"]').check();
    await page.locator('[data-expense-choice="vat"]').uncheck();
    assert(await page.locator('#expense-chart-warning').isHidden());
    const afterHide = await page.evaluate(() => { const c = Chart.getChart(document.querySelector('#expense-chart')); return { count: c.data.datasets.length, values: c.data.datasets.find((d) => d.label === 'Реклама — тест').data }; });
    assert.strictEqual(afterHide.count, 2);
    assert.deepStrictEqual(afterHide.values, configuration.values, 'Выбор других столбцов не меняет суммы');
    await page.locator('#expense-select-none').click();
    assert(await page.locator('#expense-chart').isHidden());
    await choice.locator('input').check();
    await page.locator('[data-expense-choice="vat"]').check();
    await page.locator('[data-expense-choice="profit_tax"]').check();
    assert.strictEqual(await page.evaluate(() => Chart.getChart(document.querySelector('#expense-chart')).data.datasets.length), 3);

    // Даже большие суммы и длинное название не создают горизонтальных полос.
    await page.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('123456789012345678.12345678');
    await page.waitForFunction(() => document.querySelector('[data-annual="revenue"]').textContent.replace(/\s/g, '').startsWith('123456789012345'));
    const longNameId = await categoryRow.locator('[data-open-category-menu]').getAttribute('data-open-category-menu');
    const longName = page.locator(`[data-open-category-menu="${longNameId}"]`).first();
    await longName.evaluate((element) => { element.dataset.originalText = element.textContent; element.textContent = 'Длинноеназваниестатьизатрат'.repeat(5); });
    await page.evaluate(() => {
      for (const [element, text] of [[document.querySelector('#context-org'), 'Длинноеназваниеорганизации'.repeat(5)],
        [document.querySelector('#currency-label'), 'Валюта: ' + 'В'.repeat(20)],
        [document.querySelector('#organization-select option:checked'), 'Длинноеназваниеорганизации'.repeat(5)]]) {
        element.dataset.originalText = element.textContent; element.textContent = text;
      }
    });
    for (const width of [1920, 1360, 1151, 1150, 1024, 900, 768, 600, 390, 320]) await assertNoHorizontalScroll(page, width);
    await longName.evaluate((element) => { element.textContent = element.dataset.originalText; });
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('#context-org, #currency-label, #organization-select option:checked')) element.textContent = element.dataset.originalText;
    });
    await page.locator('#add-category').click();
    await assertNoHorizontalScroll(page, 320);
    await page.locator('[data-close-dialog="category-dialog"]').first().click();
    assert(await page.locator('#expense-chart').isVisible(), 'График должен помещаться на мобильном экране');
    const mobileCell = categoryRow.locator('[data-expense][data-quarter="1"]');
    assert(await mobileCell.isVisible());
    assert((await mobileCell.locator('..').innerText()).includes('1 кв.'), 'На узком экране квартал подписан у каждого поля');
    await page.setViewportSize({ width: 390, height: 844 });
    await categoryRow.locator('[data-open-category-menu]').click();
    const mobileMenu = await page.locator('#category-actions-menu').boundingBox();
    assert(mobileMenu && mobileMenu.x >= 0 && mobileMenu.x + mobileMenu.width <= 390 && mobileMenu.y >= 0 && mobileMenu.y + mobileMenu.height <= 844, 'Меню должно помещаться в мобильном окне');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('120');
    await page.waitForFunction(() => document.querySelector('[data-annual="revenue"]').textContent.replace(/\s/g, '') === '240,00');

    // Проверяем настоящее сенсорное событие без дополнительного browser context.
    await page.setViewportSize({ width: 390, height: 844 });
    const touchName = categoryRow.locator('[data-open-category-menu]');
    await page.mouse.move(0, 0);
    await page.keyboard.press('Escape');
    await touchName.scrollIntoViewIfNeeded();
    await page.locator('#category-actions-menu').waitFor({ state: 'hidden' });
    const touchBox = await touchName.boundingBox();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchBox.x + touchBox.width / 2, y: touchBox.y + touchBox.height / 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.locator('#category-actions-menu').waitFor({ state: 'visible' });
    assert.strictEqual(await touchName.getAttribute('aria-expanded'), 'true', 'Меню должно открываться касанием названия');
    await page.keyboard.press('Escape');
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await cdp.detach();
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
    await page.waitForFunction(() => !document.querySelector('#application').inert && document.querySelector('#save-status').classList.contains('hidden'));
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
    await page.waitForFunction(() => !document.querySelector('#application').inert && document.querySelector('#save-status').classList.contains('hidden'));

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
    await page.waitForFunction(() => document.querySelector('[data-input="retail_revenue"][data-quarter="1"]').value === '120');
    await assertCleanHeaders();
    assert.strictEqual(await page.locator('[data-input="retail_revenue"][data-quarter="1"]').inputValue(), '120');
    assert.strictEqual(await categoryRow.locator('[data-kind]').inputValue(), 'fixed');
    assert((await page.locator('[data-metric="non_vat_deduction"][data-quarter="1"]').getAttribute('aria-label')).includes('7,25'), 'История вычета сохраняется при экспорте и импорте Excel');

    // Импорт в уже заполненный квартал по умолчанию не заменяет значения.
    await page.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('240');
    await page.locator('#year-form button[type="submit"]').first().click();
    await page.waitForFunction(() => !document.querySelector('#application').inert && document.querySelector('#save-status').classList.contains('hidden') && document.querySelector('[data-input="retail_revenue"][data-quarter="1"]').value === '240');
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
    // Действия статьи — в выпадающем меню с доступом с клавиатуры.
    const openMenu = async (row) => { await row.locator('[data-open-category-menu]').click(); await page.locator('#category-actions-menu').waitFor({ state: 'visible' }); };
    const chooseMenu = async (row, action) => { await openMenu(row); await page.locator(`#category-actions-menu ${action}`).click(); };
    assert.strictEqual(await categoryRow.locator('[data-archive], [data-delete-category]').count(), 0);
    const trigger = categoryRow.locator('[data-open-category-menu]');
    assert.strictEqual((await trigger.innerText()).trim(), 'Реклама — тест', 'Вместо троеточия используется название статьи');
    const workingInput = categoryRow.locator('[data-expense][data-quarter="1"]');
    await workingInput.focus();
    await trigger.hover();
    assert(await page.locator('#category-actions-menu').isVisible(), 'Меню должно открываться при наведении');
    assert(await workingInput.evaluate((element) => element === document.activeElement), 'Наведение не должно забирать фокус');
    await page.evaluate(() => {
      document.addEventListener('keydown', function observe(event) {
        if (event.key === 'ArrowDown') { window.__hoverKeyPrevented = event.defaultPrevented; document.removeEventListener('keydown', observe); }
      });
    });
    await page.keyboard.press('ArrowDown');
    assert.strictEqual(await page.evaluate(() => window.__hoverKeyPrevented), false, 'Меню по наведению не перехватывает клавиши из поля ввода');
    assert.strictEqual(await trigger.getAttribute('aria-expanded'), 'true');
    assert((await page.locator('#category-actions-menu').innerText()).includes('Скрыть в архив'));
    assert((await page.locator('#category-actions-menu').innerText()).includes('Удалить навсегда'));
    await page.locator('#category-actions-menu').hover();
    await page.waitForTimeout(500);
    assert(await page.locator('#category-actions-menu').isVisible(), 'В меню можно перевести указатель');
    await page.mouse.move(0, 0);
    await page.locator('#category-actions-menu').waitFor({ state: 'hidden' });
    await trigger.press('Enter');
    assert(await page.locator('#category-actions-menu').isVisible());
    await page.keyboard.press('Escape');
    assert(await page.locator('#category-actions-menu').isHidden());
    assert.strictEqual(await trigger.getAttribute('aria-expanded'), 'false');
    assert(await trigger.evaluate((element) => element === document.activeElement));
    await trigger.press('Enter');
    await page.keyboard.press('Tab');
    assert(await page.locator('#category-actions-menu').isHidden());
    assert(await categoryRow.locator('[data-rate]').evaluate((element) => element === document.activeElement), 'Tab закрывает меню и переводит фокус к следующему полю');
    await trigger.press('Enter');
    await page.keyboard.press('ArrowDown');
    assert(await page.locator('#category-actions-menu [data-delete-category]').evaluate((el) => el === document.activeElement));
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');  // скрыть, подтверждение обрабатывается тестом
    await page.waitForFunction(() => document.querySelector('#archive-count').textContent === '1');
    assert.strictEqual(await categoryRow.count(), 0, 'Архивная строка должна быть скрыта');
    await page.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('121');
    const saveWithArchive = page.waitForResponse((response) => response.url().endsWith('/api/year') && response.request().method() === 'POST');
    await page.locator('#year-form button[type="submit"]').first().click();
    assert.strictEqual((await saveWithArchive).status(), 200);
    await page.waitForFunction(() => !document.querySelector('#application').inert && document.querySelector('#save-status').classList.contains('hidden'));
    await page.locator('#toggle-archive').click();
    const archived = page.locator('.archive-item').filter({ hasText: 'Реклама — тест' });
    assert((await archived.innerText()).includes('9,00'));
    await chooseMenu(archived, '[data-archive]');
    await categoryRow.waitFor({ state: 'visible' });
    assert.strictEqual(await categoryRow.locator('[data-expense][data-quarter="1"]').inputValue(), '3');
    assert.strictEqual(await categoryRow.locator('[data-expense][data-quarter="2"]').inputValue(), '6');
    // Скрыть снова, затем увидеть все затронутые годы перед отдельным удалением.
    await chooseMenu(categoryRow, '[data-archive]');
    await page.waitForFunction(() => document.querySelector('#archive-count').textContent === '1');
    await chooseMenu(archived, '[data-delete-category]');
    await page.locator('#delete-category-dialog').waitFor({ state: 'visible' });
    const impact = await page.locator('#delete-category-impact').innerText();
    assert(impact.includes('2030') && impact.includes('2031'), `Должны быть перечислены все годы: ${impact}`);
    assert(await page.locator('#delete-category-apply').isDisabled());
    await page.locator('[data-close-dialog="delete-category-dialog"]').first().click();
    assert.strictEqual(await page.locator('#archive-count').innerText(), '1');
    await chooseMenu(archived, '[data-delete-category]');
    await page.locator('#delete-category-confirm').check();
    await page.locator('#delete-category-apply').click();
    await page.locator('#delete-category-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !document.querySelector('#application').inert && document.querySelector('#archive-count').textContent === '0');
    assert.strictEqual(await page.locator('#archive-count').innerText(), '0');
    assert.strictEqual(await categoryRow.count(), 0);

    // Неопределённый НДС больше не скрывает остальные денежные суммы квартала.
    await page.locator('#year-input').fill('2032'); await page.locator('#year-input').press('Tab');
    await page.waitForFunction(() => document.querySelector('#context-year').textContent.includes('2032'));
    await fillQuarter(2);
    await page.locator('[data-input="retail_revenue"][data-quarter="2"]').fill('120');
    await page.locator('[data-input="non_vat_sales"][data-quarter="2"]').fill('12');
    await page.locator('[data-input="input_vat"][data-quarter="2"]').fill('10');
    const unknownExpense = page.locator('#sheet-expense-rows [data-expense][data-quarter="2"]').first();
    const expenseId = await unknownExpense.getAttribute('data-expense');
    await unknownExpense.fill('5');
    await page.waitForFunction(() => document.querySelector('[data-metric="non_vat_deduction"][data-quarter="2"]').textContent === '#ДЕЛ/0!');
    assert.strictEqual((await page.locator('[data-annual="non_vat_deduction"]').innerText()).trim(), '1,00', 'Годовой вычет остаётся рассчитанным');
    await page.locator('[data-expense-choice="vat"]').check();
    await page.waitForFunction(() => document.querySelector('#expense-chart-warning').textContent.includes('#ДЕЛ/0!'));
    assert(await page.locator('#expense-chart-warning').isVisible());
    await page.locator('[data-expense-choice="vat"]').uncheck();
    assert(await page.locator('#expense-chart-warning').isHidden());
    await page.locator('[data-expense-choice="vat"]').check();
    const unknown = await page.evaluate((id) => {
      const c = Chart.getChart(document.querySelector('#expense-chart'));
      return { category: c.data.datasets.find((d) => d.expenseKey === `category:${id}`).data,
        vat: c.data.datasets.find((d) => d.expenseKey === 'vat').data };
    }, expenseId);
    assert.deepStrictEqual(unknown.category, [null, 5, null, null]);
    assert.deepStrictEqual(unknown.vat, [null, null, null, null]);

    // Отрицательный общий итог не блокирует график сумм и не меняет знак налогов.
    await page.locator('#year-input').fill('2033'); await page.locator('#year-input').press('Tab');
    await page.waitForFunction(() => document.querySelector('#context-year').textContent.includes('2033'));
    await fillQuarter(1);
    await page.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('120');
    await page.locator('[data-input="input_vat"][data-quarter="1"]').fill('40');
    await page.locator('[data-input="cost_of_sales"][data-quarter="1"]').fill('50');
    const negativeExpense = page.locator('#sheet-expense-rows [data-expense][data-quarter="1"]').first();
    const negativeId = await negativeExpense.getAttribute('data-expense');
    await negativeExpense.fill('3');
    await page.waitForFunction(() => document.querySelector('[data-metric="vat_due"][data-quarter="1"]').textContent.replace(/\s/g, '') === '−20,00');
    await page.waitForFunction((id) => Chart.getChart(document.querySelector('#expense-chart'))?.data.datasets.some((d) => d.expenseKey === `category:${id}` && d.data[0] === 3), negativeId);
    const negative = await page.evaluate((id) => {
      const c = Chart.getChart(document.querySelector('#expense-chart'));
      return { category: c.data.datasets.find((d) => d.expenseKey === `category:${id}`).data[0], vat: c.data.datasets.find((d) => d.expenseKey === 'vat').data[0] };
    }, negativeId);
    assert.deepStrictEqual(negative, { category: 3, vat: -20 });
    const geometry = await page.evaluate(() => {
      const chart = Chart.getChart(document.querySelector('#expense-chart')); chart.update('none');
      const vatIndex = chart.data.datasets.findIndex((dataset) => dataset.expenseKey === 'vat');
      const bar = chart.getDatasetMeta(vatIndex).data[0];
      return { element: bar.constructor.id, y: bar.y, base: bar.base, width: bar.width };
    });
    assert.strictEqual(geometry.element, 'bar');
    assert(geometry.width > 0 && geometry.y > geometry.base, 'Отрицательная сумма рисуется столбцом ниже нуля');
    await assertNoHorizontalScroll(page, 390);

    // Каждый раздел может быть единственным открытым: его кнопки квартала заполняют и удаляют общие данные.
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.locator('#year-input').fill('2034'); await page.locator('#year-input').press('Tab');
    await page.waitForFunction(() => document.querySelector('#context-year').textContent.includes('2034'));
    for (const [index, group] of sheetGroups.entries()) {
      const q = index + 1;
      await fillQuarter(q, group);
      await page.locator(`[data-input="retail_revenue"][data-quarter="${q}"]`).fill('120');
    }
    const savedDeleteTest = page.waitForResponse((response) => response.url().endsWith('/api/year') && response.request().method() === 'POST');
    await page.locator('#year-form button[type="submit"]').first().click();
    assert.strictEqual((await savedDeleteTest).status(), 200);
    await page.waitForFunction(() => !document.querySelector('#application').inert && document.querySelector('#save-status').classList.contains('hidden'));
    await assertCleanHeaders();
    // Удаление не перезаписывает несохранённый черновик и требует подтверждения.
    await page.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('121');
    await openQuarterMenu('financial', 1);
    await page.locator('#quarter-actions-menu [data-delete-quarter="1"]').click();
    assert((await page.locator('#toast').innerText()).includes('Сначала сохраните'));
    assert.strictEqual(await page.locator('[data-input="retail_revenue"][data-quarter="1"]').inputValue(), '121');
    await page.locator('[data-input="retail_revenue"][data-quarter="1"]').fill('120');
    const resaved = page.waitForResponse((response) => response.url().endsWith('/api/year') && response.request().method() === 'POST');
    await page.locator('#year-form button[type="submit"]').first().click();
    assert.strictEqual((await resaved).status(), 200);
    await page.waitForFunction(() => !document.querySelector('#application').inert && document.querySelector('#save-status').classList.contains('hidden'));
    await openQuarterMenu('financial', 1);
    await page.keyboard.press('ArrowDown');
    assert(await page.locator('#quarter-actions-menu [data-delete-quarter="1"]').evaluate((el) => el === document.activeElement));
    acceptDialogs = false;
    await page.keyboard.press('Enter');
    acceptDialogs = true;
    assert.strictEqual(await page.locator('[data-input="retail_revenue"][data-quarter="1"]').inputValue(), '120', 'Отмена подтверждения не удаляет квартал');
    for (const [index, group] of sheetGroups.entries()) {
      const q = index + 1;
      for (const other of sheetGroups) {
        const toggle = page.locator(`[data-panel-toggle="${other}"]`), shouldOpen = other === group;
        if ((await toggle.getAttribute('aria-expanded') === 'true') !== shouldOpen) await toggle.click();
      }
      await openQuarterMenu(group, q);
      assert(await page.locator(`#quarter-actions-menu [data-delete-quarter="${q}"]`).isEnabled());
      const deleted = page.waitForResponse((response) => response.url().endsWith('/api/period') && response.request().method() === 'DELETE');
      await page.locator(`#quarter-actions-menu [data-delete-quarter="${q}"]`).click();
      assert.strictEqual((await deleted).status(), 200);
      await page.waitForFunction((quarter) => document.querySelector(`[data-input="retail_revenue"][data-quarter="${quarter}"]`).value === '', q);
      await openQuarterMenu(group, q);
      assert(await page.locator(`#quarter-actions-menu [data-delete-quarter="${q}"]`).isDisabled());
      await page.keyboard.press('Escape');
      await assertCleanHeaders();
    }
    assert.deepStrictEqual(errors, [], `Ошибки браузера: ${errors.join('; ')}`);
    console.log('UI smoke: чистые шапки, меню кварталов, высокий график, сохранение истории, ширина, архив/удаление, XLSX и конкуренция — OK.');
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) { /* Windows может освобождать файл с задержкой */ }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
