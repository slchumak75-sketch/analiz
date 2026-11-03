/* Локальный интерфейс; формулы и проверки находятся на сервере в analiz/. */
'use strict';

const token = document.querySelector('meta[name="analiz-token"]').content;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {
  organizations: [], organizationId: null, year: new Date().getFullYear(), quarter: 1,
  view: 'overview', summary: null, categories: [], period: null, dirty: false,
  dialogMode: 'create', refreshId: 0, charts: {}, toastTimer: null,
};
const viewLabels = { overview: 'Обзор', entry: 'Ввод данных', expenses: 'Затраты', history: 'Сравнение лет' };
const fieldGroups = {
  sales: [
    ['retail_revenue', 'Выручка по отчётам ККМ с НДС', '8'],
    ['invoice_revenue', 'Реализация по накладным с НДС', '9'],
    ['cost_of_sales', 'Себестоимость реализации без НДС', '18'],
  ],
  vat: [
    ['invoice_vat', 'НДС реализации по накладным', '12'],
    ['non_vat_sales', 'Товары реализации без НДС', '14'],
    ['non_vat_deduction', 'Вычет по товарам без НДС', '15'],
    ['input_vat', 'Входящий НДС', '16'],
  ],
};
const reportRows = [
  ['4', 'Налог НДС', 'vat_due', false],
  ['5', 'Налог на прибыль', 'profit_tax', false],
  ['6', 'Прибыль', 'profit', false],
  ['7', 'Чистая прибыль', 'net_profit', false],
  ['8', 'Выручка по отчётам ККМ с НДС', 'retail_revenue', true],
  ['9', 'Реализация по накладным с НДС', 'invoice_revenue', true],
  ['10', 'Итого выручка', 'revenue', false],
  ['11', 'НДС выручки по отчётам ККМ', 'retail_vat', false],
  ['12', 'НДС реализации по накладным', 'invoice_vat', true],
  ['13', 'Итого НДС', 'output_vat', false],
  ['14', 'Товары реализации без НДС', 'non_vat_sales', true],
  ['15', 'Вычет по товарам без НДС', 'non_vat_deduction', true],
  ['16', 'Входящий НДС', 'input_vat', true],
  ['17', 'Входящий НДС с вычетом', 'adjusted_input_vat', false],
  ['18', 'Себестоимость реализации без НДС', 'cost_of_sales', true],
  ['19', 'Себестоимость затрат без НДС', 'expense_total', false],
];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function svg(name) { return `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`; }

// Таблицы форматируются из десятичных строк через BigInt, без потери копеек
// из-за ограничений Number. Преобразование в Number используется лишь в графиках.
function fixed(value, decimals = 2, trim = false) {
  if (value === null || value === undefined || value === '') return '—';
  let text = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    text = new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: Math.min(decimals + 2, 10) }).format(n);
  }
  const negative = text.startsWith('-');
  if (negative) text = text.slice(1);
  let [whole, fraction = ''] = text.split('.');
  fraction = fraction.padEnd(decimals + 1, '0');
  const factor = 10n ** BigInt(decimals);
  let scaled = BigInt(whole || '0') * factor + BigInt((fraction.slice(0, decimals) || '0'));
  if (Number(fraction[decimals] || '0') >= 5) scaled += 1n;
  const intPart = (scaled / factor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  let decimalPart = decimals ? (scaled % factor).toString().padStart(decimals, '0') : '';
  if (trim) decimalPart = decimalPart.replace(/0+$/, '');
  return `${negative && scaled !== 0n ? '−' : ''}${intPart}${decimalPart ? ',' + decimalPart : ''}`;
}
function money(value, unit = false) {
  const result = fixed(value, 2);
  const currency = state.summary?.organization?.currency || '';
  return result === '—' || !unit || !currency ? result : `${result} ${currency}`;
}
function n(value) { return value === null || value === undefined ? null : Number(value); }
function compact(value) {
  return new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.classList.add('hidden'), 4500);
}
function fail(error) { console.error(error); toast(error?.message || 'Не удалось выполнить действие.', true); }
async function api(path, options = {}) {
  const headers = { 'X-Analiz-Token': token, ...(options.headers || {}) };
  const request = { method: options.method || 'GET', headers };
  if (options.body !== undefined) { headers['Content-Type'] = 'application/json'; request.body = JSON.stringify(options.body); }
  const response = await fetch(path, request);
  if (!response.ok) {
    let message = `Ошибка ${response.status}`;
    try { message = (await response.json()).error || message; } catch (_) { /* no JSON */ }
    throw new Error(message);
  }
  return response.json();
}
function query(values) { return new URLSearchParams(values).toString(); }
function selectedQuery(extra = {}) { return query({ organization_id: state.organizationId, year: state.year, ...extra }); }
function confirmDiscard() {
  return !state.dirty || window.confirm('В квартале есть несохранённые изменения. Отбросить их?');
}
function remember() {
  try {
    localStorage.setItem('analiz-selection', JSON.stringify({ organizationId: state.organizationId, year: state.year, quarter: state.quarter }));
  } catch (_) { /* localStorage может быть отключён */ }
}
function restoreSelection() {
  try {
    const saved = JSON.parse(localStorage.getItem('analiz-selection') || '{}');
    if (Number.isInteger(saved.organizationId)) state.organizationId = saved.organizationId;
    if (Number.isInteger(saved.year) && saved.year >= 1900 && saved.year <= 9999) state.year = saved.year;
    if (Number.isInteger(saved.quarter) && saved.quarter >= 1 && saved.quarter <= 4) state.quarter = saved.quarter;
  } catch (_) { /* игнорируем повреждённые настройки интерфейса */ }
}

async function refreshOrganizations() {
  state.organizations = (await api('/api/organizations')).organizations;
  if (!state.organizations.some((org) => org.id === state.organizationId)) {
    state.organizationId = state.organizations[0]?.id ?? null;
  }
  renderTopbar();
}
async function refresh() {
  const serial = ++state.refreshId;
  renderTopbar();
  if (!state.organizationId) {
    state.summary = null; state.categories = []; state.period = null;
    $('#empty-onboarding').classList.remove('hidden');
    $('#main-content').classList.add('hidden');
    return;
  }
  const [summary, categories, period] = await Promise.all([
    api(`/api/summary?${selectedQuery()}`),
    api(`/api/categories?${query({ organization_id: state.organizationId })}`),
    api(`/api/period?${selectedQuery({ quarter: state.quarter })}`),
  ]);
  if (serial !== state.refreshId) return;
  state.summary = summary;
  state.categories = categories.categories;
  state.period = period.period;
  state.dirty = false;
  $('#empty-onboarding').classList.add('hidden');
  $('#main-content').classList.remove('hidden');
  renderTopbar();
  renderOverview();
  renderForm();
  renderExpenses();
  renderHistory();
  activateView();
  remember();
}
function renderTopbar() {
  const select = $('#organization-select');
  select.innerHTML = state.organizations.length
    ? state.organizations.map((org) => `<option value="${org.id}">${esc(org.name)}</option>`).join('')
    : '<option value="">Нет организации</option>';
  select.value = state.organizationId === null ? '' : String(state.organizationId);
  select.disabled = state.organizations.length === 0;
  $('#manage-organization').disabled = !state.organizationId;
  $('#export-csv').disabled = !state.organizationId;
  $('#year-input').value = state.year;
  $('#breadcrumb-current').textContent = viewLabels[state.view];
}

function changeBadge(key, current, comparable) {
  if (!comparable) return '<span>Нет данных за те же кварталы прошлого года</span>';
  const before = n(comparable.annual[key]);
  const now = n(current);
  if (before === null || now === null || before <= 0) return '<span>Сравнение с прошлым годом недоступно</span>';
  const delta = (now - before) / before * 100;
  if (!Number.isFinite(delta)) return '<span>Сравнение с прошлым годом недоступно</span>';
  const favorable = key === 'total_costs' ? delta <= 0 : delta >= 0;
  const prefix = delta > 0 ? '+' : delta < 0 ? '−' : '';
  const quarters = comparable.quarters.map((q) => `${q} кв.`).join(', ');
  return `<span class="change-badge ${favorable ? '' : 'down'}">${prefix}${esc(fixed(Math.abs(delta), 1))}%</span><span>к ${esc(quarters)} ${comparable.year}</span>`;
}
function renderOverview() {
  const s = state.summary;
  const annual = s.annual;
  const hasData = s.quarter_count > 0;
  $('#overview-subtitle').textContent = `Главные показатели и динамика за ${state.year} год`;
  $('#context-org').textContent = s.organization.name;
  $('#context-year').textContent = `${state.year} год`;
  $('#context-status').textContent = `${s.quarter_count} из 4 кварталов`;
  $('#chart-year').textContent = String(state.year);
  const cards = [
    ['Выручка с НДС', 'revenue', 'wallet', ''],
    ['Себестоимость и затраты', 'total_costs', 'stack', 'sand'],
    ['Прибыль', 'profit', 'trend', 'blue'],
    ['Чистая прибыль', 'net_profit', 'coins', 'lime'],
  ];
  $('#stats-grid').innerHTML = cards.map(([label, key, icon, tone]) => {
    const amount = hasData ? money(annual[key]) : '—';
    const unit = hasData && s.organization.currency ? `<small>${esc(s.organization.currency)}</small>` : '';
    const caption = hasData ? changeBadge(key, annual[key], s.comparison) : '<span>Данные ещё не внесены</span>';
    return `<article class="stat-card"><div class="stat-top"><span class="stat-label">${esc(label)}</span><span class="stat-icon ${tone}">${svg(icon)}</span></div><div class="stat-value" title="${esc(money(annual[key], true))}">${esc(amount)}${unit}</div><div class="stat-caption">${caption}</div></article>`;
  }).join('');
  const insightItems = [
    ['pie', 'Чистая рентабельность', hasData && annual.net_margin !== null ? `${fixed(annual.net_margin, 2)}%` : '—', 'Чистая прибыль / выручка без НДС'],
    ['coins', 'Налог НДС', hasData ? money(annual.vat_due, true) : '—', 'По формуле исходной книги'],
    ['wallet', 'Налог на прибыль', hasData ? money(annual.profit_tax, true) : '—', '20% от прибыли, без ограничения нулём'],
  ];
  $('#insight-row').innerHTML = insightItems.map(([icon, title, value, sub]) => `<div class="insight"><span class="insight-icon">${svg(icon)}</span><div><div class="insight-title">${esc(title)}</div><div class="insight-value">${esc(value)}</div><div class="insight-sub">${esc(sub)}</div></div></div>`).join('');
  $('#financial-table-body').innerHTML = reportRows.map(([row, label, key, manual]) => {
    const cells = s.quarters.map((q) => `<td class="${q.exists ? '' : 'muted-cell'}">${q.exists ? esc(money(q.metrics[key])) : '—'}</td>`).join('');
    const value = !hasData ? '—' : (key === 'non_vat_deduction' && annual[key] === null ? '#ДЕЛ/0!' : money(annual[key]));
    const kind = manual ? (row === '15' ? 'ввод / год: формула' : 'ввод') : 'расчёт';
    return `<tr><td><span class="row-code">${row}</span>${esc(label)} <span class="row-kind ${manual ? 'manual' : ''}">${kind}</span></td>${cells}<td>${esc(value)}</td></tr>`;
  }).join('');
  const note = $('#deduction-note');
  if (!hasData) {
    note.innerHTML = '<strong>О годовом вычете:</strong> в строке 15 год считается по отдельной формуле H14 / H10 × H16. Квартальные вычеты вводятся вручную.';
  } else if (annual.non_vat_deduction === null) {
    note.innerHTML = '<strong>Годовой вычет H15 не определён (#ДЕЛ/0!):</strong> годовая выручка равна нулю. Это не подменяется нулём. H17 остаётся суммой квартальных значений.';
  } else {
    note.innerHTML = `<strong>Особенность исходной книги:</strong> годовой вычет H15 = H14 / H10 × H16: <strong>${esc(money(annual.non_vat_deduction))}</strong>; сумма квартальных вычетов: <strong>${esc(money(annual.quarterly_deduction_sum))}</strong>; разница (до 8 знаков): <strong>${esc(fixed(annual.deduction_difference, 8, true))}</strong>. H17 — сумма квартальных значений, а не H16 − H15.`;
  }
}

function fieldHtml([key, label, row], value) {
  return `<label class="field" for="field-${key}"><span>${esc(label)} <b>*</b><span class="field-code">стр. ${row}</span></span><input id="field-${key}" name="${key}" inputmode="decimal" autocomplete="off" required maxlength="32" value="${esc(value ?? '')}" placeholder="0,00"></label>`;
}
function renderQuarterTabs() {
  $('#quarter-tabs').innerHTML = [1, 2, 3, 4].map((q) => {
    const exists = state.summary.quarters[q - 1].exists;
    return `<button type="button" class="quarter-tab ${state.quarter === q ? 'active' : ''}" data-quarter="${q}" aria-pressed="${state.quarter === q}">${q} квартал${exists ? '<span class="quarter-dot" title="Сохранён"></span>' : ''}</button>`;
  }).join('');
}
function categoryMeta(category) {
  const bits = [];
  if (category.source_row) bits.push(`стр. ${category.source_row}`);
  if (category.tag !== '') bits.push(`метка C: ${category.tag}`);
  if (category.archived) bits.push('в архиве');
  return bits.join(' · ');
}
function renderExpenseInputs(expenses = {}) {
  const visible = state.categories.filter((category) => !category.archived || (expenses[String(category.id)] !== undefined && n(expenses[String(category.id)]) !== 0));
  $('#expense-inputs').innerHTML = visible.length ? visible.map((category) => {
    const value = expenses[String(category.id)] ?? '';
    return `<label class="expense-input" for="expense-${category.id}"><div><span class="expense-input-label">${esc(category.name)}</span><span class="expense-input-meta">${esc(categoryMeta(category))}</span></div><input id="expense-${category.id}" name="expense-${category.id}" inputmode="decimal" autocomplete="off" maxlength="32" value="${esc(value)}" placeholder="0,00"></label>`;
  }).join('') : '<p class="no-rows">Нет активных статей. Добавьте новую статью.</p>';
}
function renderForm() {
  const period = state.period;
  renderQuarterTabs();
  $('#entry-period-label').textContent = `${state.year} · ${state.quarter} квартал`;
  $('#entry-status').textContent = period ? 'Сохранён' : 'Не заполнен';
  $('#entry-status').classList.toggle('empty', !period);
  $('#savebar-title').textContent = period ? `${state.quarter} квартал сохранён` : 'Новый квартал';
  $('#delete-period').classList.toggle('hidden', !period);
  $('#sales-fields').innerHTML = fieldGroups.sales.map((field) => fieldHtml(field, period?.inputs[field[0]])).join('');
  $('#vat-fields').innerHTML = fieldGroups.vat.map((field) => fieldHtml(field, period?.inputs[field[0]])).join('');
  renderExpenseInputs(period?.expenses || {});
}
function collectForm() {
  const inputs = {};
  for (const [key] of [...fieldGroups.sales, ...fieldGroups.vat]) inputs[key] = $(`#field-${key}`).value.trim();
  const expenses = {};
  $$('#expense-inputs input').forEach((input) => { expenses[input.name.slice('expense-'.length)] = input.value.trim(); });
  return { inputs, expenses };
}

function renderExpenses() {
  const s = state.summary, hasData = s.quarter_count > 0;
  $('#expense-year').textContent = String(state.year);
  const nonzero = s.expenses.filter((item) => n(item.total) !== 0);
  const costCards = [
    ['Расходы по статьям', hasData ? money(s.annual.expense_total, true) : '—', 'stack'],
    ['Себестоимость реализации', hasData ? money(s.annual.cost_of_sales, true) : '—', 'wallet'],
    ['Статей с затратами', hasData ? String(nonzero.length) : '—', 'pie'],
  ];
  $('#expense-summary').innerHTML = costCards.map(([label, value, icon]) => `<div class="stat-card"><div class="stat-top"><span class="stat-label">${esc(label)}</span><span class="stat-icon">${svg(icon)}</span></div><div class="stat-value">${esc(value)}</div><div class="stat-caption">за ${s.quarter_count} из 4 кварталов</div></div>`).join('');
  $('#expenses-table-body').innerHTML = s.expenses.length ? s.expenses.map((item) => {
    const quarters = item.quarters.map((amount) => `<td class="${amount === null ? 'muted-cell' : ''}">${esc(money(amount))}</td>`).join('');
    const label = item.archived ? 'Вернуть' : 'В архив';
    return `<tr><td>${esc(item.name)}${item.archived ? '<span class="archived-label">архив</span>' : ''}<span class="category-meta">${esc(categoryMeta(item))}</span></td>${quarters}<td>${hasData ? esc(money(item.total)) : '—'}</td><td><button class="archive-btn" data-category-id="${item.id}" data-archived="${item.archived ? 'false' : 'true'}">${label}</button></td></tr>`;
  }).join('') : '<tr><td colspan="7" class="no-rows">Статей затрат пока нет.</td></tr>';
}
function renderHistory() {
  const s = state.summary;
  $('#tax-year').textContent = String(state.year);
  $('#history-table-body').innerHTML = s.history.length ? [...s.history].reverse().map((item) => {
    const a = item.annual;
    return `<tr><td>${item.year}</td><td>${esc(item.quarters.map((q) => `${q} кв.`).join(', '))} <span class="row-kind">${item.count}/4</span></td><td>${esc(money(a.revenue))}</td><td>${esc(money(a.total_costs))}</td><td>${esc(money(a.profit))}</td><td>${esc(money(a.net_profit))}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="no-rows">Сохраните первый квартал, чтобы появилась история.</td></tr>';
}

const COLORS = { green: '#1d8464', light: '#b9d9bb', yellow: '#d8bd72', ink: '#486c5a', grid: '#f0f3f0', red: '#cf8775', blue: '#83b8ad' };
function commonOptions() {
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'bottom', align: 'start', labels: { boxWidth: 9, boxHeight: 9, padding: 17, color: '#83958a', font: { size: 10, family: 'Segoe UI, Arial' }, usePointStyle: true, pointStyle: 'circle' } },
      tooltip: { backgroundColor: '#284c3c', padding: 10, cornerRadius: 7,
        callbacks: { label: (context) => ` ${context.dataset.label}: ${money(context.dataset.original?.[context.dataIndex] ?? context.raw, true)}` } },
    },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: '#a2b0a6', font: { size: 10 } } },
      y: { grid: { color: COLORS.grid }, border: { display: false }, ticks: { color: '#a2b0a6', font: { size: 10 }, maxTicksLimit: 5, callback: (value) => compact(value) } },
    },
  };
}
function plot(id, emptyId, config, hasData) {
  const canvas = $(`#${id}`), empty = $(`#${emptyId}`);
  if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
  canvas.classList.toggle('hidden', !hasData);
  empty.classList.toggle('hidden', hasData);
  if (!hasData) return;
  if (typeof Chart === 'undefined') { empty.textContent = 'Не удалось загрузить библиотеку графиков.'; empty.classList.remove('hidden'); return; }
  state.charts[id] = new Chart(canvas, config);
}
function dataset(label, original, color, extra = {}) {
  return { label, original, data: original.map(n), backgroundColor: color, borderColor: color, borderRadius: 4, maxBarThickness: 28, ...extra };
}
function renderQuarterChart() {
  const s = state.summary, quarters = s.quarters;
  const values = (key) => quarters.map((q) => q.exists ? q.metrics[key] : null);
  const options = commonOptions();
  plot('quarter-chart', 'quarter-chart-empty', { type: 'bar', data: { labels: ['1 квартал', '2 квартал', '3 квартал', '4 квартал'], datasets: [
    dataset('Выручка с НДС', values('revenue'), COLORS.green),
    dataset('Себестоимость и затраты', values('total_costs'), COLORS.light),
    dataset('Чистая прибыль', values('net_profit'), COLORS.yellow, { type: 'line', borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 5, tension: .25, fill: false, spanGaps: false }),
  ] }, options }, s.quarter_count > 0);
}
function expenseChart(id, emptyId, maxItems) {
  const list = state.summary.expenses.filter((item) => n(item.total) !== 0).sort((a, b) => Math.abs(n(b.total)) - Math.abs(n(a.total))).slice(0, maxItems);
  const options = commonOptions();
  options.indexAxis = 'y';
  options.plugins.legend.display = false;
  options.interaction = { mode: 'nearest', intersect: true };
  options.scales = {
    x: { grid: { color: COLORS.grid }, border: { display: false }, ticks: { color: '#a2b0a6', font: { size: 10 }, maxTicksLimit: 4, callback: (value) => compact(value) } },
    y: { grid: { display: false }, border: { display: false }, ticks: { color: '#7c9082', font: { size: 10 }, autoSkip: false } },
  };
  const labels = list.map((item) => item.name + (item.tag !== '' ? ` · ${item.tag}` : ''));
  const original = list.map((item) => item.total);
  plot(id, emptyId, { type: 'bar', data: { labels, datasets: [dataset('Затраты', original, COLORS.green, { backgroundColor: original.map((v) => n(v) < 0 ? COLORS.red : COLORS.green), maxBarThickness: 17 })] }, options }, list.length > 0);
}
function renderHistoryCharts() {
  const history = state.summary.history;
  const values = (key) => history.map((item) => item.annual[key]);
  const options = commonOptions();
  options.scales.x.ticks.maxRotation = 0;
  const line = (label, key, color) => dataset(label, values(key), color, { borderWidth: 2, pointRadius: 4, pointHoverRadius: 5, tension: .2, fill: false });
  plot('history-chart', 'history-chart-empty', { type: 'line', data: { labels: history.map((item) => `${item.year}${item.count < 4 ? ` · ${item.count}/4` : ''}`), datasets: [
    line('Выручка с НДС', 'revenue', COLORS.green), line('Себестоимость и затраты', 'total_costs', COLORS.blue), line('Чистая прибыль', 'net_profit', COLORS.yellow),
  ] }, options }, history.length > 0);
  const quarters = state.summary.quarters;
  const qValues = (key) => quarters.map((q) => q.exists ? q.metrics[key] : null);
  plot('tax-chart', 'tax-chart-empty', { type: 'bar', data: { labels: ['1 кв.', '2 кв.', '3 кв.', '4 кв.'], datasets: [
    dataset('Итого НДС', qValues('output_vat'), COLORS.light), dataset('Налог НДС', qValues('vat_due'), COLORS.green), dataset('Налог на прибыль', qValues('profit_tax'), COLORS.yellow),
  ] }, options: commonOptions() }, state.summary.quarter_count > 0);
}
function activateView() {
  $$('.view').forEach((section) => section.classList.toggle('hidden', section.id !== `view-${state.view}`));
  $$('.nav-item[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
  $('#breadcrumb-current').textContent = viewLabels[state.view];
  if (!state.summary) return;
  requestAnimationFrame(() => {
    if (state.view === 'overview') { renderQuarterChart(); expenseChart('expense-chart', 'expense-chart-empty', 7); }
    if (state.view === 'expenses') expenseChart('all-expenses-chart', 'all-expenses-empty', 15);
    if (state.view === 'history') renderHistoryCharts();
  });
}
function navigate(view) {
  if (!Object.hasOwn(viewLabels, view) || view === state.view) return;
  if (state.view === 'entry' && !confirmDiscard()) return;
  if (state.dirty) { state.dirty = false; renderForm(); }
  state.view = view;
  activateView();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function openOrganization(mode) {
  if (!confirmDiscard()) return;
  state.dialogMode = mode;
  const org = state.organizations.find((item) => item.id === state.organizationId);
  $('#organization-dialog-title').textContent = mode === 'create' ? 'Добавить организацию' : 'Настроить организацию';
  $('#org-name').value = mode === 'edit' ? org?.name || '' : '';
  $('#org-currency').value = mode === 'edit' ? org?.currency || '' : '';
  $('#org-save').textContent = mode === 'create' ? 'Добавить' : 'Сохранить';
  $('#delete-organization').classList.toggle('hidden', mode !== 'edit');
  $('#organization-dialog').showModal();
  $('#org-name').focus();
}
function openCategory() {
  if (!state.organizationId) return;
  $('#category-form').reset();
  $('#category-dialog').showModal();
  $('#category-name').focus();
}
async function download(path, filename) {
  const response = await fetch(path, { headers: { 'X-Analiz-Token': token } });
  if (!response.ok) {
    let message = 'Не удалось скачать файл.';
    try { message = (await response.json()).error || message; } catch (_) { /* ignore */ }
    throw new Error(message);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function initialize() {
  restoreSelection();
  await refreshOrganizations();
  await refresh();
}

document.addEventListener('click', (event) => {
  const view = event.target.closest('[data-view]');
  if (view) { event.preventDefault(); navigate(view.dataset.view); return; }
  const openEntry = event.target.closest('[data-open-entry]');
  if (openEntry) { navigate('entry'); return; }
  const close = event.target.closest('[data-close-dialog]');
  if (close) { $(`#${close.dataset.closeDialog}`).close(); return; }
  const quarter = event.target.closest('[data-quarter]');
  if (quarter) {
    const next = Number(quarter.dataset.quarter);
    if (next === state.quarter || !confirmDiscard()) return;
    state.quarter = next; state.dirty = false;
    refresh().catch(fail); return;
  }
  const archive = event.target.closest('[data-category-id]');
  if (archive) {
    const isArchived = archive.dataset.archived === 'true';
    const message = isArchived ? 'Перенести статью в архив? Прошлые суммы сохранятся.' : 'Вернуть статью из архива?';
    if (!window.confirm(message)) return;
    api('/api/categories', { method: 'PATCH', body: { organization_id: state.organizationId, category_id: Number(archive.dataset.categoryId), archived: isArchived } })
      .then(refresh).then(() => toast(isArchived ? 'Статья перенесена в архив.' : 'Статья восстановлена.')).catch(fail);
  }
});
$('#onboarding-create').addEventListener('click', () => openOrganization('create'));
$('#add-organization').addEventListener('click', () => openOrganization('create'));
$('#manage-organization').addEventListener('click', () => openOrganization('edit'));
$('#add-category-entry').addEventListener('click', openCategory);
$('#add-category-expenses').addEventListener('click', openCategory);
$('#organization-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const name = $('#org-name').value.trim(), currency = $('#org-currency').value.trim();
    if (!name) { $('#org-name').focus(); throw new Error('Введите название организации.'); }
    const body = { name, currency };
    if (state.dialogMode === 'edit') body.organization_id = state.organizationId;
    const result = await api('/api/organizations', { method: state.dialogMode === 'edit' ? 'PATCH' : 'POST', body });
    state.organizationId = result.organization.id;
    state.dirty = false;
    $('#organization-dialog').close();
    await refreshOrganizations(); await refresh();
    toast(state.dialogMode === 'create' ? 'Организация добавлена.' : 'Организация обновлена.');
  } catch (error) { fail(error); }
});
$('#delete-organization').addEventListener('click', async () => {
  const org = state.organizations.find((item) => item.id === state.organizationId);
  if (!window.confirm(`Удалить организацию «${org?.name}» вместе со ВСЕМИ кварталами и затратами? Это действие нельзя отменить без резервной копии.`)) return;
  try {
    await api('/api/organizations', { method: 'DELETE', body: { organization_id: state.organizationId } });
    $('#organization-dialog').close(); state.organizationId = null; state.dirty = false;
    await refreshOrganizations(); await refresh(); toast('Организация удалена.');
  } catch (error) { fail(error); }
});
$('#category-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const name = $('#category-name').value.trim(), tag = $('#category-tag').value.trim();
    if (!name) { $('#category-name').focus(); throw new Error('Введите название статьи.'); }
    const draft = state.view === 'entry' ? collectForm() : null;
    await api('/api/categories', { method: 'POST', body: { organization_id: state.organizationId, name, tag } });
    $('#category-dialog').close();
    if (draft) {
      state.categories = (await api(`/api/categories?${query({ organization_id: state.organizationId })}`)).categories;
      renderExpenseInputs(draft.expenses);
    } else { await refresh(); }
    toast('Статья добавлена.');
  } catch (error) { fail(error); }
});
$('#period-form').addEventListener('input', () => { state.dirty = true; $('#savebar-title').textContent = 'Есть несохранённые изменения'; });
$('#fill-zero').addEventListener('click', () => {
  for (const [key] of [...fieldGroups.sales, ...fieldGroups.vat]) { const input = $(`#field-${key}`); if (!input.value.trim()) input.value = '0'; }
  state.dirty = true; $('#savebar-title').textContent = 'Есть несохранённые изменения';
});
$('#period-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const { inputs, expenses } = collectForm();
    const missing = [...fieldGroups.sales, ...fieldGroups.vat].find(([key]) => !inputs[key]);
    if (missing) { $(`#field-${missing[0]}`).focus(); throw new Error(`Заполните «${missing[1]}» или введите 0.`); }
    await api('/api/period', { method: 'POST', body: { organization_id: state.organizationId, year: state.year, quarter: state.quarter, inputs, expenses } });
    state.dirty = false; await refresh(); toast('Квартал сохранён. Расчёты обновлены.');
  } catch (error) { fail(error); }
});
$('#delete-period').addEventListener('click', async () => {
  if (!window.confirm(`Удалить данные за ${state.quarter} квартал ${state.year} года?`)) return;
  try { await api('/api/period', { method: 'DELETE', body: { organization_id: state.organizationId, year: state.year, quarter: state.quarter } }); state.dirty = false; await refresh(); toast('Квартал удалён.'); } catch (error) { fail(error); }
});
$('#organization-select').addEventListener('change', async (event) => {
  if (!confirmDiscard()) { event.target.value = String(state.organizationId); return; }
  state.organizationId = Number(event.target.value); state.dirty = false;
  try { await refresh(); } catch (error) { fail(error); }
});
async function setYear(value) {
  const next = Number(value);
  if (!Number.isInteger(next) || next < 1900 || next > 9999) { $('#year-input').value = state.year; toast('Укажите год от 1900 до 9999.', true); return; }
  if (next === state.year) { $('#year-input').value = state.year; return; }
  if (!confirmDiscard()) { $('#year-input').value = state.year; return; }
  state.year = next; state.dirty = false;
  try { await refresh(); } catch (error) { fail(error); }
}
$('#year-input').addEventListener('change', (event) => setYear(event.target.value));
$('#year-prev').addEventListener('click', () => setYear(state.year - 1));
$('#year-next').addEventListener('click', () => setYear(state.year + 1));
$('#export-csv').addEventListener('click', () => download(`/api/report.csv?${selectedQuery()}`, `analiz-${state.year}.csv`).catch(fail));
$('#overview-export').addEventListener('click', () => download(`/api/report.csv?${selectedQuery()}`, `analiz-${state.year}.csv`).catch(fail));
$('#backup').addEventListener('click', () => download('/api/backup', 'analiz-backup.sqlite3').then(() => toast('Резервная копия скачана.')).catch(fail));
$('#shutdown').addEventListener('click', async () => {
  if (!confirmDiscard() || !window.confirm('Завершить работу приложения?')) return;
  try {
    await api('/api/shutdown', { method: 'POST', body: {} });
    state.dirty = false;
    document.body.innerHTML = '<div class="onboarding"><div class="eyebrow centered">РАБОТА ЗАВЕРШЕНА</div><h1>Приложение закрыто</h1><p>Ваши данные сохранены на компьютере. Эту вкладку можно закрыть.</p></div>';
  } catch (error) { fail(error); }
});
window.addEventListener('beforeunload', (event) => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
initialize().catch((error) => { $('#fatal-error').textContent = `Не удалось открыть приложение: ${error.message}`; $('#fatal-error').classList.remove('hidden'); fail(error); });
