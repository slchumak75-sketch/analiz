/* Все разделы на одной странице; финансовые расчёты выполняет Python/Decimal. */
'use strict';
const token = document.querySelector('meta[name="analiz-token"]').content;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {
  organizations: [], organizationId: null, year: new Date().getFullYear(),
  saved: null, view: null, dirty: false, saving: false, dialogMode: 'create',
  refreshId: 0, previewId: 0, previewTimer: null, importToken: null, importing: false, addingCategory: false,
  charts: {}, toastTimer: null, showArchive: false, deleteImpact: null, deletingCategory: false, categoryChanging: false,
  expenseSelection: new Set(), expenseTouched: false, expenseContext: null,
  expenseColors: new Map(), expenseColoredSelection: new Set(), collapsedPanels: new Set(),
};
const reportRows = [
  ['4', 'Налог НДС', 'vat_due', false], ['5', 'Налог на прибыль', 'profit_tax', false],
  ['6', 'Прибыль', 'profit', false], ['7', 'Чистая прибыль', 'net_profit', false],
  ['8', 'Выручка по отчётам ККМ с НДС', 'retail_revenue', true], ['9', 'Реализация по накладным с НДС', 'invoice_revenue', true],
  ['10', 'Итого выручка', 'revenue', false], ['11', 'НДС выручки по отчётам ККМ', 'retail_vat', false],
  ['12', 'НДС реализации по накладным', 'invoice_vat', true], ['13', 'Итого НДС', 'output_vat', false],
  ['14', 'Товары реализации без НДС', 'non_vat_sales', true], ['15', 'Вычет по товарам без НДС', 'non_vat_deduction', false],
  ['16', 'Входящий НДС', 'input_vat', true], ['17', 'Входящий НДС с вычетом', 'adjusted_input_vat', false],
  ['18', 'Себестоимость реализации без НДС', 'cost_of_sales', true], ['19', 'Себестоимость затрат без НДС', 'expense_total', false],
];
const statusLabels = {
  ready: 'Рассчитано', unclassified: 'Укажите тип затрат', no_positive_revenue: 'Нет положительной выручки',
  negative_fixed_costs: 'Отрицательные постоянные затраты', nonpositive_contribution: 'Маржинальный доход неположителен',
};
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function svg(name) { return `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`; }
function fixed(value, decimals = 2, trim = false) {
  if (value === null || value === undefined || value === '') return '—';
  let text = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(value); if (!Number.isFinite(number)) return '—';
    text = new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: Math.min(decimals + 2, 10) }).format(number);
  }
  const negative = text.startsWith('-'); if (negative) text = text.slice(1);
  let [whole, fraction = ''] = text.split('.'); fraction = fraction.padEnd(decimals + 1, '0');
  const factor = 10n ** BigInt(decimals);
  let scaled = BigInt(whole || '0') * factor + BigInt(fraction.slice(0, decimals) || '0');
  if (Number(fraction[decimals] || '0') >= 5) scaled += 1n;
  const intPart = (scaled / factor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  let decimalPart = decimals ? (scaled % factor).toString().padStart(decimals, '0') : '';
  if (trim) decimalPart = decimalPart.replace(/0+$/, '');
  return `${negative && scaled !== 0n ? '−' : ''}${intPart}${decimalPart ? ',' + decimalPart : ''}`;
}
function money(value, unit = false) {
  const result = fixed(value, 2), currency = state.view?.organization?.currency || state.saved?.organization?.currency || '';
  return result === '—' || !unit || !currency ? result : `${result} ${currency}`;
}
function n(value) { return value === null || value === undefined ? null : Number(value); }
function compact(value) { return new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value); }
function toast(message, error = false) {
  const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.classList.remove('hidden');
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}
function fail(error) { console.error(error); toast(error?.message || 'Не удалось выполнить действие.', true); }
async function api(path, options = {}) {
  const headers = { 'X-Analiz-Token': token, ...(options.headers || {}) };
  const request = { method: options.method || 'GET', headers };
  if (options.body !== undefined) { headers['Content-Type'] = 'application/json'; request.body = JSON.stringify(options.body); }
  const response = await fetch(path, request);
  if (!response.ok) {
    let message = `Ошибка ${response.status}`;
    try { message = (await response.json()).error || message; } catch (_) { /* не JSON */ }
    throw new Error(message);
  }
  return response.json();
}
function selectedQuery(extra = {}) { return new URLSearchParams({ organization_id: state.organizationId, year: state.year, ...extra }).toString(); }
function confirmDiscard() { return !state.dirty || window.confirm('Есть несохранённые изменения в таблице. Отбросить их?'); }
function remember() {
  try { localStorage.setItem('analiz-selection', JSON.stringify({ organizationId: state.organizationId, year: state.year })); } catch (_) { /* отключено */ }
}
function restoreSelection() {
  try {
    const saved = JSON.parse(localStorage.getItem('analiz-selection') || '{}');
    if (Number.isInteger(saved.organizationId)) state.organizationId = saved.organizationId;
    if (Number.isInteger(saved.year) && saved.year >= 1900 && saved.year <= 9999) state.year = saved.year;
  } catch (_) { /* повреждённые настройки интерфейса */ }
}
const PANEL_KEYS = new Set(['financial', 'sales', 'expenses', 'analysis', 'chart']);
function restorePanels() {
  try {
    const stored = JSON.parse(localStorage.getItem('analiz-collapsed-panels') || '[]');
    if (Array.isArray(stored)) state.collapsedPanels = new Set(stored.filter((key) => PANEL_KEYS.has(key)));
  } catch (_) { /* повреждённые настройки интерфейса */ }
}
function applyPanel(toggle) {
  const closed = state.collapsedPanels.has(toggle.dataset.panelToggle);
  toggle.setAttribute('aria-expanded', String(!closed));
  for (const id of toggle.getAttribute('aria-controls').split(/\s+/)) document.getElementById(id)?.classList.toggle('hidden', closed);
}
function togglePanel(toggle) {
  const key = toggle.dataset.panelToggle;
  if (!PANEL_KEYS.has(key)) return;
  closeCategoryMenu(); closeQuarterMenu();
  if (state.collapsedPanels.has(key)) state.collapsedPanels.delete(key); else state.collapsedPanels.add(key);
  applyPanel(toggle);
  try { localStorage.setItem('analiz-collapsed-panels', JSON.stringify([...state.collapsedPanels])); } catch (_) { /* отключено */ }
  if (key === 'chart' && !state.collapsedPanels.has(key)) requestAnimationFrame(() => {
    state.charts['expense-chart']?.resize();
    if (state.view) updateExpensePlot(state.view);
  });
}
function setPreviewStatus(message = '', error = false) {
  const status = $('#preview-status');
  status.textContent = message; status.classList.toggle('hidden', !message); status.classList.toggle('error', error);
}
function setDirty(value) {
  state.dirty = value;
  const status = $('#save-status');
  status.textContent = value ? 'Есть несохранённые изменения' : '';
  status.classList.toggle('dirty', value); status.classList.toggle('hidden', !value);
  if (!value) setPreviewStatus();
}
function renderTopbar() {
  const select = $('#organization-select');
  select.innerHTML = state.organizations.length ? state.organizations.map((org) => `<option value="${org.id}">${esc(org.name)}</option>`).join('') : '<option value="">Нет организации</option>';
  select.value = state.organizationId === null ? '' : String(state.organizationId);
  select.disabled = !state.organizations.length;
  ['manage-organization', 'import-xlsx', 'export-xlsx'].forEach((id) => { $(`#${id}`).disabled = !state.organizationId; });
  $('#year-input').value = state.year;
}
async function refreshOrganizations() {
  state.organizations = (await api('/api/organizations')).organizations;
  if (!state.organizations.some((org) => org.id === state.organizationId)) state.organizationId = state.organizations[0]?.id ?? null;
  renderTopbar();
}
async function refresh(draft = null, keepDirty = false, expectedRevision = null) {
  const serial = ++state.refreshId; state.previewId++; clearTimeout(state.previewTimer); renderTopbar();
  if (!state.organizationId) {
    state.saved = null; state.view = null; state.dirty = false;
    $('#empty-onboarding').classList.remove('hidden'); $('#main-content').classList.add('hidden'); return;
  }
  const summary = await api(`/api/summary?${selectedQuery()}`);
  if (serial !== state.refreshId) return;
  if (expectedRevision && summary.revision !== expectedRevision) throw new Error('Статья добавлена, но данные изменились в другом окне. Скопируйте черновик, затем обновите страницу.');
  state.saved = summary; state.view = summary;
  $('#empty-onboarding').classList.add('hidden'); $('#main-content').classList.remove('hidden');
  renderTopbar(); renderSheet(summary, draft); setDirty(keepDirty); renderResults(summary); remember();
  if (draft) schedulePreview();
}
function rawInputValue(summary, draft, quarter, key) {
  if (draft && Object.hasOwn(draft.quarters[String(quarter)].inputs, key)) return draft.quarters[String(quarter)].inputs[key];
  const q = summary.quarters[quarter - 1]; return q.exists ? q.metrics[key] : '';
}
function rawExpenseValue(summary, draft, quarter, category) {
  const key = String(category.id);
  if (draft && Object.hasOwn(draft.quarters[String(quarter)].expenses, key)) return draft.quarters[String(quarter)].expenses[key];
  const value = category.quarters[quarter - 1]; return value === null || n(value) === 0 ? '' : value;
}
function cellCaption(label) { return `<span class="cell-label">${esc(label)} </span>`; }
function categoryTrigger(item, archived) {
  return `<button class="category-name-trigger" type="button" data-open-category-menu="${item.id}" data-archived="${archived}" data-category-name="${esc(item.name)}" aria-haspopup="menu" aria-expanded="false" aria-controls="category-actions-menu" aria-label="${esc(item.name)} — действия со статьёй">${esc(item.name)}</button>`;
}
function sheetColumns(group) {
  const prefix = `sheet-${group}`;
  const quarters = [1, 2, 3, 4].map((q) => `<th scope="col" id="${prefix}-q${q}"><button type="button" class="quarter-heading" data-open-quarter-menu="${q}" aria-haspopup="menu" aria-controls="quarter-actions-menu" aria-expanded="false" aria-label="${q} квартал — действия" title="Действия с ${q} кварталом">${q} квартал</button></th>`).join('');
  return `<tr class="sheet-columns" data-sheet-header="${group}"><th scope="col" id="${prefix}-label">Показатель / статья затрат</th><th scope="col" id="${prefix}-vat">НДС, %</th><th scope="col" id="${prefix}-type">Тип затрат</th>${quarters}<th scope="col" id="${prefix}-total">Итого за год</th></tr>`;
}
function renderSheet(summary, draft = null) {
  closeCategoryMenu(); closeQuarterMenu();
  const groups = { financial: sheetColumns('financial'), sales: sheetColumns('sales'), expenses: sheetColumns('expenses') };
  for (const [row, label, key, manual] of reportRows) {
    const group = Number(row) < 8 ? 'financial' : 'sales', prefix = `sheet-${group}`;
    let html = `<tr class="${['4','5','6','7','10','13','19'].includes(row) ? 'row-important' : ''}"><td headers="${prefix}-label"><div class="label-cell"><span class="row-code">${row}</span><span class="label-name">${esc(label)}</span><span class="row-kind ${manual ? 'manual' : ''}">${manual ? 'ввод' : 'расчёт'}</span></div></td><td class="muted-cell na-cell" headers="${prefix}-vat">—</td><td class="muted-cell na-cell" headers="${prefix}-type">—</td>`;
    for (let q = 1; q <= 4; q++) {
      if (manual) {
        const value = rawInputValue(summary, draft, q, key);
        html += `<td headers="${prefix}-q${q}">${cellCaption(`${q} кв.`)}<input class="sheet-input" data-input="${key}" data-quarter="${q}" inputmode="decimal" autocomplete="off" maxlength="32" value="${esc(value)}" placeholder="—" aria-label="${esc(label)}, ${q} квартал"></td>`;
      } else html += `<td class="calculated" headers="${prefix}-q${q}">${cellCaption(`${q} кв.`)}<span class="cell-value" data-metric="${key}" data-quarter="${q}">—</span></td>`;
    }
    html += `<td class="calculated" headers="${prefix}-total">${cellCaption('Итого за год')}<span class="cell-value" data-annual="${key}">—</span></td></tr>`;
    groups[group] += html;
  }
  for (const category of summary.expenses.filter((item) => !item.archived)) {
    const id = String(category.id), settings = draft?.settings?.[id] || { vat_rate: category.vat_rate ?? '', cost_type: category.cost_type };
    const source = category.source_row ? String(category.source_row) : '•';
    let html = `<tr class="category-row"><td headers="sheet-expenses-label"><div class="label-cell"><span class="row-code">${source}</span>${categoryTrigger(category, false)}</div></td>`;
    html += `<td headers="sheet-expenses-vat">${cellCaption('НДС, %')}<input class="sheet-input rate-input" data-rate="${id}" inputmode="decimal" autocomplete="off" maxlength="12" value="${esc(settings.vat_rate ?? '')}" placeholder="—" aria-label="Ставка НДС: ${esc(category.name)}"></td>`;
    html += `<td headers="sheet-expenses-type">${cellCaption('Тип затрат')}<select class="sheet-select" data-kind="${id}" aria-label="Тип затрат: ${esc(category.name)}"><option value="unclassified" ${settings.cost_type === 'unclassified' ? 'selected' : ''}>Не определён</option><option value="fixed" ${settings.cost_type === 'fixed' ? 'selected' : ''}>Постоянные</option><option value="variable" ${settings.cost_type === 'variable' ? 'selected' : ''}>Переменные</option></select></td>`;
    for (let q = 1; q <= 4; q++) html += `<td headers="sheet-expenses-q${q}">${cellCaption(`${q} кв.`)}<input class="sheet-input" data-expense="${id}" data-quarter="${q}" inputmode="decimal" autocomplete="off" maxlength="32" value="${esc(rawExpenseValue(summary, draft, q, category))}" placeholder="—" aria-label="${esc(category.name)}, ${q} квартал"></td>`;
    html += `<td class="calculated" headers="sheet-expenses-total">${cellCaption('Итого за год')}<span class="cell-value" data-category-total="${id}">—</span></td></tr>`;
    groups.expenses += html;
  }
  $('#sheet-financial-rows').innerHTML = groups.financial;
  $('#sheet-sales-rows').innerHTML = groups.sales;
  $('#sheet-expense-rows').innerHTML = groups.expenses;
  renderArchive(summary);
}
function renderArchive(summary) {
  const archived = summary.expenses.filter((item) => item.archived);
  $('#archive-count').textContent = archived.length;
  $('#toggle-archive').setAttribute('aria-expanded', String(state.showArchive));
  $('#archive-panel').classList.toggle('hidden', !state.showArchive);
  $('#archive-list').innerHTML = archived.length ? archived.map((item) => `<div class="archive-item"><div>${categoryTrigger(item, true)}<span>За ${summary.year} год: ${summary.quarter_count ? esc(money(item.total, true)) : 'нет данных'}</span></div></div>`).join('') : '<p>Скрытых статей пока нет.</p>';
}

function collect() {
  const quarters = {}, settings = {};
  for (let q = 1; q <= 4; q++) quarters[String(q)] = { inputs: {}, expenses: {} };
  $$('[data-input]').forEach((input) => { quarters[input.dataset.quarter].inputs[input.dataset.input] = input.value.trim(); });
  $$('[data-expense]').forEach((input) => { quarters[input.dataset.quarter].expenses[input.dataset.expense] = input.value.trim(); });
  $$('[data-kind]').forEach((select) => {
    const id = select.dataset.kind, input = $(`[data-rate="${id}"]`);
    settings[id] = { cost_type: select.value, vat_rate: input.value.trim() || null };
  });
  return { organization_id: state.organizationId, year: state.year, revision: state.saved?.revision, quarters, settings };
}
function schedulePreview() {
  state.previewId++; const serial = state.previewId; clearTimeout(state.previewTimer);
  setPreviewStatus();
  state.previewTimer = setTimeout(async () => {
    try {
      const view = await api('/api/year/preview', { method: 'POST', body: collect() });
      if (serial !== state.previewId) return;
      state.view = view; renderResults(view);
      setPreviewStatus(view.quarters.some((q) => q.state === 'incomplete') ? 'Для нового квартала заполните все 6 основных показателей.' : '');
    } catch (error) {
      if (serial !== state.previewId) return;
      setPreviewStatus(error.message, true);
    }
  }, 350);
}
function updateSheetValues(s) {
  $$('[data-metric]').forEach((cell) => {
    const q = s.quarters[Number(cell.dataset.quarter) - 1];
    const key = cell.dataset.metric, value = q.metrics?.[key];
    cell.textContent = !q.exists ? '—' : (value === null && ['vat_due', 'non_vat_deduction', 'adjusted_input_vat'].includes(key) ? '#ДЕЛ/0!' : money(value));
    const hasLegacy = key === 'non_vat_deduction' && q.legacy_manual_deduction != null;
    cell.classList.toggle('legacy-value', hasLegacy);
    if (hasLegacy) {
      const oldValue = money(q.legacy_manual_deduction);
      cell.dataset.legacyDeduction = oldValue;
      cell.title = `Ранее вручную введено: ${oldValue}. Нажмите, чтобы посмотреть историю.`;
      cell.setAttribute('role', 'button'); cell.tabIndex = 0;
      cell.setAttribute('aria-label', `Вычет за ${q.quarter} квартал: ${cell.textContent}. Показать прежний ручной вычет ${oldValue}, не используемый в расчётах.`);
    } else {
      delete cell.dataset.legacyDeduction; cell.removeAttribute('title');
      cell.removeAttribute('role'); cell.removeAttribute('tabindex'); cell.removeAttribute('aria-label');
    }
    cell.classList.toggle('muted-cell', !q.exists);
  });
  $$('[data-annual]').forEach((cell) => {
    const key = cell.dataset.annual;
    cell.textContent = !s.quarter_count ? '—' : (['vat_due', 'non_vat_deduction', 'adjusted_input_vat'].includes(key) && s.annual[key] === null ? '#ДЕЛ/0!' : money(s.annual[key]));
  });
  const byId = Object.fromEntries(s.expenses.map((expense) => [String(expense.id), expense]));
  $$('[data-category-total]').forEach((cell) => { cell.textContent = s.quarter_count ? money(byId[cell.dataset.categoryTotal]?.total) : '—'; });
}
function changeBadge(key, current, comparable) {
  if (!comparable) return '<span>Нет сравнимых кварталов прошлого года</span>';
  const before = n(comparable.annual[key]), now = n(current);
  if (before === null || now === null || before <= 0) return '<span>Сравнение недоступно</span>';
  const delta = (now - before) / before * 100;
  if (!Number.isFinite(delta)) return '<span>Сравнение недоступно</span>';
  const favorable = key === 'total_costs' ? delta <= 0 : delta >= 0;
  return `<span class="change-badge ${favorable ? '' : 'down'}">${delta > 0 ? '+' : delta < 0 ? '−' : ''}${esc(fixed(Math.abs(delta), 1))}%</span><span>к тем же кв. ${comparable.year}</span>`;
}
function renderStats(s) {
  $('#context-org').textContent = s.organization.name; $('#context-year').textContent = `${s.year} год`;
  $('#context-status').textContent = `${s.quarter_count} из 4 кварталов`;
  $('#currency-label').textContent = s.organization.currency ? `Валюта: ${s.organization.currency}` : 'Валюта не указана';
  const cards = [
    ['Выручка с НДС', 'revenue', 'wallet', ''], ['Себестоимость и затраты', 'total_costs', 'stack', 'sand'],
    ['Чистая прибыль', 'net_profit', 'trend', 'blue'], ['Точка безубыточности', 'break_even_revenue', 'pie', 'lime'],
  ];
  $('#stats-grid').innerHTML = cards.map(([label, key, icon, tone]) => {
    const value = key === 'break_even_revenue' ? s.analysis?.break_even_revenue : s.annual[key];
    const hasValue = s.quarter_count && value !== null && value !== undefined;
    const unit = hasValue && s.organization.currency ? `<small>${esc(s.organization.currency)}</small>` : '';
    let caption;
    if (key === 'break_even_revenue') caption = `<span>${s.analysis ? esc(statusLabels[s.analysis.break_even_status]) : 'Нет данных'} · без НДС</span>`;
    else caption = s.quarter_count ? changeBadge(key, value, s.comparison) : '<span>Данные ещё не внесены</span>';
    return `<article class="stat-card"><div class="stat-top"><span class="stat-label">${esc(label)}</span><span class="stat-icon ${tone}">${svg(icon)}</span></div><div class="stat-value">${hasValue ? esc(money(value)) : '—'}${unit}</div><div class="stat-caption">${caption}</div></article>`;
  }).join('');
}
function renderAssessment(s) {
  const a = s.annual, analysis = s.analysis;
  let result = 'Пока нет сохранённых или заполненных кварталов.';
  let trend = 'Для сравнения нужны те же кварталы предыдущего года.';
  let safety = 'Укажите типы статей затрат и заполните квартал.';
  if (s.quarter_count) {
    const value = n(a.net_profit);
    result = value > 0 ? `Чистая прибыль: <strong>${esc(money(a.net_profit, true))}</strong>.` : value < 0 ? `Чистый убыток: <strong>${esc(money(a.net_profit, true))}</strong>.` : 'Чистый результат равен нулю.';
    if (a.net_margin !== null) result += ` Рентабельность к выручке без НДС: <strong>${esc(fixed(a.net_margin))}%</strong>.`;
    if (s.quarters.some((q) => q.metrics && n(q.metrics.profit_tax) < 0)) result += ' В отдельных кварталах налог на прибыль отрицательный по формуле исходной книги; это не налоговая рекомендация.';
    if (s.quarters.some((q) => q.metrics && n(q.metrics.vat_due) < 0)) result += ' В отдельных кварталах расчётный НДС отрицательный.';
    if (s.comparison && n(s.comparison.annual.revenue) > 0) {
      const delta = (n(a.revenue) - n(s.comparison.annual.revenue)) / n(s.comparison.annual.revenue) * 100;
      const verb = delta > 0 ? 'выросла' : delta < 0 ? 'снизилась' : 'не изменилась';
      trend = `Выручка ${verb}${delta ? ` на <strong>${esc(fixed(Math.abs(delta), 1))}%</strong>` : ''} относительно тех же кварталов ${s.comparison.year} года.`;
    }
    if (analysis?.break_even_status === 'unclassified') safety = `Не распределено <strong>${analysis.unclassified_ids.length}</strong> статей с ненулевыми затратами. Укажите тип каждой из них в таблице.`;
    else if (analysis?.break_even_status === 'ready') {
      const amount = n(analysis.safety_amount);
      safety = amount >= 0 ? `Выручка без НДС выше порога на <strong>${esc(money(analysis.safety_amount, true))}</strong> (запас прочности ${esc(fixed(analysis.safety_percent))}%).` : `До порога безубыточности не хватает <strong>${esc(money(String(analysis.safety_amount).replace(/^-/, ''), true))}</strong> выручки без НДС.`;
    } else if (analysis) safety = `${esc(statusLabels[analysis.break_even_status])}; расчёт порога недоступен.`;
  }
  const items = [['trend','Финансовый результат',result],['chart','Динамика продаж',trend],['pie','Запас прочности',safety]];
  $('#assessment-grid').innerHTML = items.map(([icon, label, body]) => `<article class="assessment-card"><span class="assessment-icon">${svg(icon)}</span><div><h3>${label}</h3><p>${body}</p></div></article>`).join('');
}
function analysisValue(obj, group, key) {
  if (!obj) return null;
  if (group === 'analysis' && obj.break_even_status === 'unclassified' && ['fixed_costs', 'variable_costs'].includes(key)) return null;
  return obj[key] ?? null;
}
function renderAnalysisTable(s) {
  $('#analysis-year').textContent = String(s.year);
  const rows = [
    ['Выручка без НДС', 'metrics', 'revenue_without_vat', false], ['Себестоимость и затраты', 'metrics', 'total_costs', false],
    ['Статьи затрат + НДС + налог на прибыль · без себестоимости', 'metrics', 'expense_tax_total', false],
    ['Постоянные затраты', 'analysis', 'fixed_costs', false], ['Переменные затраты', 'analysis', 'variable_costs', false],
    ['Маржинальный доход', 'analysis', 'contribution', false], ['Маржинальность, %', 'analysis', 'contribution_margin', true],
    ['Точка безубыточности · без НДС', 'analysis', 'break_even_revenue', false], ['Запас прочности', 'analysis', 'safety_amount', false],
    ['Запас прочности, %', 'analysis', 'safety_percent', true], ['Чистая прибыль', 'metrics', 'net_profit', false],
    ['Чистая рентабельность, %', 'metrics', 'net_margin', true],
  ];
  const cell = (label, value) => `<td>${cellCaption(label)}<span class="cell-value">${esc(value)}</span></td>`;
  $('#analysis-body').innerHTML = rows.map(([label, group, key, percent]) => {
    const format = (value, exists) => value === null ? (key === 'expense_tax_total' && exists ? '#ДЕЛ/0!' : '—') : `${fixed(value)}${percent ? '%' : ''}`;
    const cells = s.quarters.map((q) => cell(`${q.quarter} кв.`, format(analysisValue(group === 'analysis' ? q.analysis : q.metrics, group, key), q.exists))).join('');
    const total = analysisValue(group === 'analysis' ? s.analysis : (s.quarter_count ? s.annual : null), group, key);
    return `<tr class="${key === 'break_even_revenue' ? 'analysis-emphasis' : ''}"><td>${esc(label)}</td>${cells}${cell('Итого за год', format(total, s.quarter_count > 0))}</tr>`;
  }).join('') + `<tr><td>Состояние расчёта порога</td>${s.quarters.map((q) => cell(`${q.quarter} кв.`, q.analysis ? statusLabels[q.analysis.break_even_status] : '—')).join('')}${cell('Итого за год', s.analysis ? statusLabels[s.analysis.break_even_status] : '—')}</tr>`;
}
const COLORS = { green: '#176e50', light: '#70a58b', yellow: '#a87808', grid: '#dce7df', red: '#b0443d', blue: '#367c76' };
function chartOptions() {
  return { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { position: 'bottom', align: 'start', labels: { boxWidth: 9, boxHeight: 9, padding: 17, color: '#345246', font: { size: 15, family: 'Segoe UI, Arial' }, usePointStyle: true, pointStyle: 'circle' } },
      tooltip: { backgroundColor: '#284c3c', padding: 14, cornerRadius: 7, titleFont: { size: 18 }, bodyFont: { size: 18 }, callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${money(ctx.dataset.original?.[ctx.dataIndex] ?? ctx.raw, true)}` } } },
    scales: { x: { grid: { display: false }, border: { display: false }, ticks: { color: '#435f51', font: { size: 15 } } },
      y: { grid: { color: COLORS.grid }, border: { display: false }, ticks: { color: '#435f51', font: { size: 15 }, maxTicksLimit: 5, callback: (value) => compact(value) } } } };
}
function dataset(label, original, color, extra = {}) { return { label, original, data: original.map(n), backgroundColor: color, borderColor: color, borderRadius: 4, maxBarThickness: 30, ...extra }; }
function expenseKey(item) { return item.kind === 'category' ? `category:${item.category_id}` : item.kind; }
const EXPENSE_COLORS = ['#a87808', '#176e50', '#3763a8', '#bc3e32', '#7950a0', '#087e7c', '#d06812', '#607a1a', '#aa3685', '#48647c', '#76512c', '#2080a5'];
function expenseColor(item) {
  const key = expenseKey(item);
  if (state.expenseColors.has(key)) return state.expenseColors.get(key);
  let hash = 0; for (const char of key) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return EXPENSE_COLORS[hash % EXPENSE_COLORS.length];
}
function assignExpenseColors(items) {
  // Сначала сохраняем цвета уже выбранных рядов; новым отдаём свободные цвета.
  const selected = items.filter((item) => state.expenseSelection.has(expenseKey(item)));
  const ordered = [...selected.filter((item) => state.expenseColoredSelection.has(expenseKey(item))),
    ...selected.filter((item) => !state.expenseColoredSelection.has(expenseKey(item)))];
  const used = new Set();
  for (const item of ordered) {
    let index = EXPENSE_COLORS.indexOf(expenseColor(item));
    while (used.has(EXPENSE_COLORS[index]) && used.size < EXPENSE_COLORS.length) index = (index + 1) % EXPENSE_COLORS.length;
    const color = EXPENSE_COLORS[index]; used.add(color); state.expenseColors.set(expenseKey(item), color);
  }
  state.expenseColoredSelection = new Set(selected.map(expenseKey));
}
function expenseSorted(s) {
  return [...s.expense_structure.items].sort((a, b) => Math.abs(n(b.amount) || 0) - Math.abs(n(a.amount) || 0));
}
function renderExpenseChart(s) {
  const context = `${s.organization.id}:${s.year}`;
  if (state.expenseContext !== context) {
    state.expenseContext = context; state.expenseTouched = false; state.expenseSelection.clear();
    state.expenseColors.clear(); state.expenseColoredSelection.clear();
  }
  const items = expenseSorted(s);
  if (!state.expenseTouched) {
    // Прежний выбор по умолчанию: крупнейшие статьи и оба налога; всё можно переключить слева.
    const nonzero = (item) => item.quarter_amounts.some((value) => value !== null && n(value) !== 0);
    const defaults = items.filter((item) => item.kind === 'category' && nonzero(item)).slice(0, 10);
    defaults.push(...items.filter((item) => item.kind !== 'category' && item.quarter_amounts.some((value) => value !== null)));
    state.expenseSelection = new Set(defaults.map(expenseKey));
  }
  assignExpenseColors(items);
  $('#expense-choices').innerHTML = items.map((item) => {
    const key = expenseKey(item), checked = state.expenseSelection.has(key) ? 'checked' : '';
    return `<label class="expense-choice"><input type="checkbox" data-expense-choice="${esc(key)}" ${checked}><span class="expense-series-dot" aria-hidden="true" style="--series-color:${expenseColor(item)}"></span><span class="expense-choice-name">${esc(item.name)}</span></label>`;
  }).join('');
  updateExpensePlot(s);
}
function updateExpensePlot(s) {
  const structure = s.expense_structure, items = expenseSorted(s);
  const chosen = items.filter((item) => state.expenseSelection.has(expenseKey(item)));
  assignExpenseColors(items);
  $$('[data-expense-choice]').forEach((input) => {
    const color = state.expenseColors.get(input.dataset.expenseChoice);
    if (color) input.parentElement.querySelector('.expense-series-dot').style.setProperty('--series-color', color);
  });
  const vatError = state.expenseSelection.has('vat') && structure.quarters.some((q) => q.status === 'vat_undefined');
  const warning = $('#expense-chart-warning');
  warning.textContent = vatError ? 'НДС за отдельные кварталы не отображается из-за #ДЕЛ/0!; остальные доступные суммы сохранены.' : '';
  warning.classList.toggle('hidden', !vatError);
  const datasets = chosen.map((item) => dataset(item.name, item.quarter_amounts, expenseColor(item), {
    expenseKey: expenseKey(item), skipNull: true,
    // Нулевые ряды остаются нулями, но не сжимают видимые столбцы при выборе «Все».
    grouped: item.quarter_amounts.some((value) => value !== null && n(value) !== 0),
  }));
  const canPlot = datasets.some((series) => series.data.some((value) => value !== null && Number.isFinite(value)));
  const canvas = $('#expense-chart'), empty = $('#expense-chart-empty');
  if (!canPlot) {
    if (state.charts['expense-chart']) { state.charts['expense-chart'].destroy(); delete state.charts['expense-chart']; }
    canvas.classList.add('hidden'); empty.classList.remove('hidden');
    const hasPeriods = structure.quarters.some((quarter) => quarter.status !== 'no_data');
    empty.textContent = !hasPeriods ? 'Введите данные, чтобы увидеть график.' : !chosen.length ? 'Выберите статью или налог слева.' : 'Для выбранных статей нет доступных сумм.';
    return;
  }
  if (typeof Chart === 'undefined') { canvas.classList.add('hidden'); empty.classList.remove('hidden'); empty.textContent = 'Не удалось загрузить график.'; return; }
  canvas.classList.remove('hidden'); empty.classList.add('hidden');
  const labels = ['1 кв.', '2 кв.', '3 кв.', '4 кв.'];
  if (state.charts['expense-chart']) {
    const chart = state.charts['expense-chart']; chart.data.labels = labels; chart.data.datasets = datasets; chart.update(); return;
  }
  const options = chartOptions(); options.plugins.legend.display = false;
  // Учитываем системную настройку уменьшения анимации.
  options.animation = { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1000, easing: 'easeOutQuart' };
  options.interaction = { mode: 'nearest', intersect: true };
  options.plugins.tooltip.callbacks.label = (ctx) => ` ${ctx.dataset.label}: ${money(ctx.dataset.original[ctx.dataIndex])} руб.`;
  options.scales.y.beginAtZero = true;
  options.scales.y.title = { display: true, text: 'Сумма, руб.', color: '#435f51', font: { size: 15 } };
  state.charts['expense-chart'] = new Chart(canvas, { type: 'bar', data: { labels, datasets }, options });
}
function renderResults(summary) {
  updateSheetValues(summary); renderStats(summary); renderAssessment(summary); renderAnalysisTable(summary);
  requestAnimationFrame(() => { if (state.view === summary) renderExpenseChart(summary); });
}
function openOrganization(mode) {
  if (!confirmDiscard()) return;
  state.dialogMode = mode;
  const org = state.organizations.find((item) => item.id === state.organizationId);
  $('#organization-dialog-title').textContent = mode === 'create' ? 'Добавить организацию' : 'Настроить организацию';
  $('#org-name').value = mode === 'edit' ? org?.name || '' : ''; $('#org-currency').value = mode === 'edit' ? org?.currency || '' : '';
  $('#org-save').textContent = mode === 'create' ? 'Добавить' : 'Сохранить'; $('#delete-organization').classList.toggle('hidden', mode !== 'edit');
  $('#organization-dialog').showModal(); $('#org-name').focus();
}
async function download(path, filename) {
  const response = await fetch(path, { headers: { 'X-Analiz-Token': token } });
  if (!response.ok) { let message = 'Не удалось скачать файл.'; try { message = (await response.json()).error || message; } catch (_) {} throw new Error(message); }
  const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function requireSaved() { if (!state.dirty) return true; toast('Сначала сохраните изменения в таблице.', true); return false; }
async function previewFile(file) {
  if (!file.name.toLowerCase().endsWith('.xlsx') || file.size > 10 * 1024 * 1024) throw new Error('Выберите файл .xlsx размером не более 10 МиБ.');
  const response = await fetch(`/api/excel/preview?${selectedQuery()}`, { method: 'POST', headers: { 'X-Analiz-Token': token, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: file });
  if (!response.ok) { let message = 'Не удалось прочитать Excel.'; try { message = (await response.json()).error || message; } catch (_) {} throw new Error(message); }
  const { preview_token: previewToken, plan } = await response.json(); state.importToken = previewToken;
  const metadata = plan.metadata || {}, mismatchYear = metadata.year && String(metadata.year) !== String(plan.year);
  const mismatchOrg = metadata.organization && metadata.organization !== plan.organization.name;
  const mismatchCurrency = metadata.currency && metadata.currency !== (plan.organization.currency || '');
  const metaText = metadata.year || metadata.organization || metadata.currency ? `<br>В файле: <strong>${esc(metadata.organization || 'организация не указана')}</strong>, ${esc(metadata.year || 'год не указан')}, валюта: ${esc(metadata.currency || 'не указана')}.` : '<br>В исходном файле организация, год и валюта не указаны.';
  const additions = plan.new_categories.length ? `<br>Новых статей: <strong>${plan.new_categories.length}</strong> (${esc(plan.new_categories.slice(0, 4).join(', '))}${plan.new_categories.length > 4 ? '…' : ''}).` : '<br>Новых статей не требуется.';
  const warning = mismatchYear || mismatchOrg || mismatchCurrency ? '<span class="warning">Организация, год или валюта файла отличаются от выбранных. Проверьте назначение перед загрузкой.</span>' : '';
  const legacy = plan.legacy_deductions ? `<br>В файле прежние ручные вычеты: ${plan.legacy_deductions} квартал(а). Для загружаемых кварталов они сохраняются справочно, если прежний вычет ещё не был сохранён; в расчёте действует новая формула.` : '';
  $('#import-summary').innerHTML = `<strong>${esc(file.name)}</strong><br>Назначение: <strong>${esc(plan.organization.name)} · ${plan.year}</strong>, валюта: ${esc(plan.organization.currency || 'не указана')}.<br>В файле заполнены кварталы: <strong>${esc(plan.quarters.join(', '))}</strong>.${metaText}${additions}${legacy}<br>Конвертация валют не выполняется.${warning}`;
  $('#import-conflicts').classList.toggle('hidden', !plan.existing_quarters.length);
  $('#import-conflicts input[value="skip"]').checked = true;
  $('#import-settings').checked = plan.all_existing_quarters.length === 0;
  $('#import-confirm').checked = false; $('#import-apply').disabled = true;
  $('#import-confirm-label').textContent = `Подтверждаю загрузку в «${plan.organization.name}» за ${plan.year} год.`;
  $('#import-dialog').showModal();
}

async function openCategoryDeletion(id) {
  if (!requireSaved()) return;
  const organizationId = state.organizationId, year = state.year, revision = state.saved?.revision;
  const query = new URLSearchParams({ organization_id: organizationId, category_id: id });
  const impact = await api(`/api/category-impact?${query}`);
  if (state.organizationId !== organizationId || state.year !== year || state.dirty || state.saved?.revision !== revision) throw new Error('Данные изменились. Проверьте удаление ещё раз.');
  state.deleteImpact = { ...impact, organizationId, year };
  const years = impact.years.length ? impact.years.join(', ') : 'нет сохранённых сумм или настроек';
  $('#delete-category-impact').innerHTML = `<strong>${esc(impact.category.name)}</strong><p>Затронутые годы: <strong>${esc(years)}</strong>.</p><p>Будут удалены суммы в ${impact.period_count} квартал(ах) и настройки за ${impact.settings_count} год(а). Итоги и налоги этих лет могут измениться. Действие необратимо без резервной копии.</p>`;
  $('#delete-category-confirm').checked = false; $('#delete-category-apply').disabled = true;
  $('#delete-category-dialog').showModal();
}
async function changeCategoryArchive(id, archived) {
  if (!requireSaved() || state.categoryChanging) return;
  if (!window.confirm(archived ? 'Перенести статью в архив? Прошлые суммы сохранятся.' : 'Вернуть статью из архива?')) return;
  state.categoryChanging = true; $('#application').inert = true;
  try {
    await api('/api/categories', { method: 'PATCH', body: { organization_id: state.organizationId, category_id: id, archived } });
    await refresh(); toast(archived ? 'Статья скрыта в архиве; история сохранена.' : 'Статья восстановлена.');
  } finally { state.categoryChanging = false; $('#application').inert = false; }
}
let activeQuarterMenuTrigger = null;
function closeQuarterMenu(restoreFocus = false) {
  const trigger = activeQuarterMenuTrigger;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  activeQuarterMenuTrigger = null;
  $('#quarter-actions-menu').classList.add('hidden');
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
}
function positionQuarterMenu() {
  const trigger = activeQuarterMenuTrigger, menu = $('#quarter-actions-menu');
  if (!trigger?.isConnected) { closeQuarterMenu(); return; }
  const target = trigger.getBoundingClientRect();
  if (target.bottom < 0 || target.top > innerHeight || target.right < 0 || target.left > innerWidth || !target.width) { closeQuarterMenu(); return; }
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(target.left, innerWidth - rect.width - 8));
  const below = target.bottom + 4;
  const top = below + rect.height <= innerHeight - 8 ? below : Math.max(8, target.top - rect.height - 4);
  menu.style.left = `${left}px`; menu.style.top = `${top}px`;
}
function openQuarterMenu(trigger) {
  if (trigger === activeQuarterMenuTrigger) { closeQuarterMenu(true); return; }
  closeCategoryMenu(); closeQuarterMenu();
  const q = Number(trigger.dataset.openQuarterMenu);
  if (!Number.isInteger(q) || q < 1 || q > 4) return;
  const menu = $('#quarter-actions-menu'), wasSaved = state.saved?.quarters[q - 1]?.exists;
  menu.setAttribute('aria-label', `Действия: ${q} квартал`);
  menu.innerHTML = `<button type="button" role="menuitem" data-fill-quarter="${q}">Заполнить пустые поля нулями</button><button type="button" role="menuitem" class="danger-link" data-delete-quarter="${q}" ${wasSaved ? '' : 'disabled'}>Удалить квартал</button>`;
  menu.style.visibility = 'hidden'; menu.classList.remove('hidden');
  activeQuarterMenuTrigger = trigger; trigger.setAttribute('aria-expanded', 'true');
  positionQuarterMenu(); menu.style.visibility = '';
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}
let activeCategoryMenuTrigger = null, categoryMenuCloseTimer = null;
function closeCategoryMenu(restoreFocus = false) {
  clearTimeout(categoryMenuCloseTimer);
  const trigger = activeCategoryMenuTrigger;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  activeCategoryMenuTrigger = null;
  $('#category-actions-menu').classList.add('hidden');
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
}
function positionCategoryMenu() {
  const trigger = activeCategoryMenuTrigger, menu = $('#category-actions-menu');
  if (!trigger?.isConnected) { closeCategoryMenu(); return; }
  const target = trigger.getBoundingClientRect();
  if (target.bottom < 0 || target.top > innerHeight || target.right < 0 || target.left > innerWidth || !target.width) { closeCategoryMenu(); return; }
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(target.right - rect.width, innerWidth - rect.width - 8));
  const below = target.bottom + 4;
  const top = below + rect.height <= innerHeight - 8 ? below : Math.max(8, target.top - rect.height - 4);
  menu.style.left = `${left}px`; menu.style.top = `${top}px`;
}
function openCategoryMenu(trigger, focusMenu = false) {
  // Наведение на статью не должно забирать фокус у открытого с клавиатуры меню квартала.
  if (!focusMenu && activeQuarterMenuTrigger && $('#quarter-actions-menu').contains(document.activeElement)) return;
  closeQuarterMenu();
  clearTimeout(categoryMenuCloseTimer);
  const menu = $('#category-actions-menu');
  if (trigger !== activeCategoryMenuTrigger) {
    // Наведение не должно отнимать фокус у управления, открытого с клавиатуры.
    if (!focusMenu && menu.contains(document.activeElement)) return;
    closeCategoryMenu();
    const id = Number(trigger.dataset.openCategoryMenu), archived = trigger.dataset.archived === 'true';
    menu.setAttribute('aria-label', `Действия со статьёй ${trigger.dataset.categoryName}`);
    menu.innerHTML = `<button type="button" role="menuitem" data-archive="${id}" data-next="${archived ? 'false' : 'true'}">${archived ? 'Восстановить' : 'Скрыть в архив'}</button><button type="button" role="menuitem" class="danger-link" data-delete-category="${id}">Удалить навсегда</button>`;
    menu.style.visibility = 'hidden'; menu.classList.remove('hidden');
    activeCategoryMenuTrigger = trigger; trigger.setAttribute('aria-expanded', 'true');
    positionCategoryMenu(); menu.style.visibility = '';
  }
  if (focusMenu) menu.querySelector('button')?.focus({ preventScroll: true });
}
function scheduleCategoryMenuClose() {
  clearTimeout(categoryMenuCloseTimer);
  categoryMenuCloseTimer = setTimeout(() => {
    const trigger = activeCategoryMenuTrigger, menu = $('#category-actions-menu');
    if (!trigger || trigger.matches(':hover') || menu.matches(':hover') || trigger === document.activeElement || menu.contains(document.activeElement)) return;
    closeCategoryMenu();
  }, 450);
}
document.addEventListener('pointerover', (event) => {
  if (event.pointerType === 'touch') return;
  const trigger = event.target.closest('[data-open-category-menu]');
  if (trigger) openCategoryMenu(trigger);
  else if (event.target.closest('#category-actions-menu')) clearTimeout(categoryMenuCloseTimer);
});
document.addEventListener('pointerout', (event) => {
  if (event.pointerType === 'touch' || !activeCategoryMenuTrigger) return;
  const menu = $('#category-actions-menu'), target = event.target;
  if (!target.closest('[data-open-category-menu]') && !target.closest('#category-actions-menu')) return;
  const next = event.relatedTarget;
  if (next instanceof Node && (activeCategoryMenuTrigger.contains(next) || menu.contains(next))) return;
  scheduleCategoryMenuClose();
});
window.addEventListener('scroll', () => {
  if (activeCategoryMenuTrigger) positionCategoryMenu();
  if (activeQuarterMenuTrigger) positionQuarterMenu();
}, true);
window.addEventListener('resize', () => {
  if (activeCategoryMenuTrigger) positionCategoryMenu();
  if (activeQuarterMenuTrigger) positionQuarterMenu();
});
document.addEventListener('keydown', (event) => {
  if (!activeCategoryMenuTrigger) return;
  const menu = $('#category-actions-menu'), focusInMenu = menu.contains(document.activeElement);
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCategoryMenu(focusInMenu || activeCategoryMenuTrigger === document.activeElement); return; }
  if (event.key === 'Tab') { closeCategoryMenu(focusInMenu); return; }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && (focusInMenu || activeCategoryMenuTrigger === document.activeElement)) {
    event.preventDefault();
    const buttons = [...menu.querySelectorAll('button')], current = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : current < 0 ? (event.key === 'ArrowUp' ? buttons.length - 1 : 0) : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true });
  }
});
document.addEventListener('keydown', (event) => {
  if (!activeQuarterMenuTrigger) return;
  const menu = $('#quarter-actions-menu'), focusInMenu = menu.contains(document.activeElement);
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeQuarterMenu(focusInMenu || activeQuarterMenuTrigger === document.activeElement); return; }
  if (event.key === 'Tab') { closeQuarterMenu(focusInMenu); return; }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && (focusInMenu || activeQuarterMenuTrigger === document.activeElement)) {
    event.preventDefault();
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')], current = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : current < 0 ? (event.key === 'ArrowUp' ? buttons.length - 1 : 0) : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true });
  }
});
function showLegacyDeduction(cell) {
  toast(`Прежний ручной вычет: ${cell.dataset.legacyDeduction}. В расчётах не используется.`);
}
document.addEventListener('keydown', (event) => {
  const cell = event.target.closest('[data-legacy-deduction]');
  if (cell && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); showLegacyDeduction(cell); }
});
document.addEventListener('click', (event) => {
  const legacy = event.target.closest('[data-legacy-deduction]');
  if (legacy) { closeCategoryMenu(); closeQuarterMenu(); showLegacyDeduction(legacy); return; }
  const panel = event.target.closest('[data-panel-toggle]');
  if (panel) { togglePanel(panel); return; }
  const menuTrigger = event.target.closest('[data-open-category-menu]');
  if (menuTrigger) { openCategoryMenu(menuTrigger, true); return; }
  const quarterTrigger = event.target.closest('[data-open-quarter-menu]');
  if (quarterTrigger) { openQuarterMenu(quarterTrigger); return; }
  if (!event.target.closest('#category-actions-menu')) closeCategoryMenu();
  if (!event.target.closest('#quarter-actions-menu')) closeQuarterMenu();
  const close = event.target.closest('[data-close-dialog]'); if (close) { $(`#${close.dataset.closeDialog}`).close(); return; }
  const fill = event.target.closest('[data-fill-quarter]');
  if (fill) {
    const q = fill.dataset.fillQuarter; closeQuarterMenu(true);
    $$(`[data-input][data-quarter="${q}"]`).forEach((input) => { if (!input.value.trim()) input.value = '0'; });
    setDirty(true); schedulePreview(); return;
  }
  const remove = event.target.closest('[data-delete-quarter]');
  if (remove) {
    const q = Number(remove.dataset.deleteQuarter); closeQuarterMenu(true); if (!requireSaved()) return;
    if (!window.confirm(`Удалить все данные за ${q} квартал ${state.year} года?`)) return;
    api('/api/period', { method: 'DELETE', body: { organization_id: state.organizationId, year: state.year, quarter: q } }).then(() => refresh()).then(() => toast('Квартал удалён.')).catch(fail); return;
  }
  const archive = event.target.closest('[data-archive]');
  if (archive) {
    const id = Number(archive.dataset.archive), archived = archive.dataset.next === 'true';
    closeCategoryMenu(); changeCategoryArchive(id, archived).catch(fail); return;
  }
  const deleteCategory = event.target.closest('[data-delete-category]');
  if (deleteCategory) { const id = Number(deleteCategory.dataset.deleteCategory); closeCategoryMenu(); openCategoryDeletion(id).catch(fail); }
});
$('#toggle-archive').addEventListener('click', () => { state.showArchive = !state.showArchive; if (state.saved) renderArchive(state.saved); });
$('#delete-category-confirm').addEventListener('change', () => { $('#delete-category-apply').disabled = !$('#delete-category-confirm').checked; });
$('#delete-category-dialog').addEventListener('cancel', (event) => { if (state.deletingCategory) event.preventDefault(); });
$('#delete-category-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (!state.deleteImpact || !$('#delete-category-confirm').checked || state.deletingCategory) return;
  const impact = state.deleteImpact;
  if (state.organizationId !== impact.organizationId || state.year !== impact.year || !requireSaved()) { toast('Данные изменились. Проверьте удаление ещё раз.', true); return; }
  state.deletingCategory = true; $('#application').inert = true; $('#delete-category-form').inert = true;
  try {
    await api('/api/categories', { method: 'DELETE', body: { organization_id: impact.organizationId, category_id: impact.category.id, confirmed: true, revision: impact.revision } });
    $('#delete-category-dialog').close(); state.deleteImpact = null; await refresh(); toast('Статья и её история удалены.');
  } catch (error) { fail(error); }
  finally { state.deletingCategory = false; $('#application').inert = false; $('#delete-category-form').inert = false; }
});
$('#expense-choices').addEventListener('change', (event) => {
  const input = event.target.closest('[data-expense-choice]'); if (!input || !state.view) return;
  state.expenseTouched = true;
  if (input.checked) state.expenseSelection.add(input.dataset.expenseChoice); else state.expenseSelection.delete(input.dataset.expenseChoice);
  updateExpensePlot(state.view);
});
function selectExpenseChoices(selectAll) {
  if (!state.view) return;
  state.expenseTouched = true; state.expenseSelection.clear();
  if (selectAll) state.view.expense_structure.items.forEach((item) => state.expenseSelection.add(expenseKey(item)));
  $$('[data-expense-choice]').forEach((input) => { input.checked = selectAll; });
  updateExpensePlot(state.view);
}
$('#expense-select-all').addEventListener('click', () => selectExpenseChoices(true));
$('#expense-select-none').addEventListener('click', () => selectExpenseChoices(false));
window.addEventListener('resize', () => { if (state.view && state.charts['expense-chart']) updateExpensePlot(state.view); });
$('#onboarding-create').addEventListener('click', () => openOrganization('create'));
$('#add-organization').addEventListener('click', () => openOrganization('create'));
$('#manage-organization').addEventListener('click', () => openOrganization('edit'));
$('#organization-form').addEventListener('submit', async (event) => {
  event.preventDefault(); try {
    const name = $('#org-name').value.trim(), currency = $('#org-currency').value.trim();
    if (!name) { $('#org-name').focus(); throw new Error('Введите название организации.'); }
    const body = { name, currency }; if (state.dialogMode === 'edit') body.organization_id = state.organizationId;
    const result = await api('/api/organizations', { method: state.dialogMode === 'edit' ? 'PATCH' : 'POST', body });
    state.organizationId = result.organization.id; state.dirty = false; $('#organization-dialog').close();
    await refreshOrganizations(); await refresh(); toast(state.dialogMode === 'create' ? 'Организация добавлена.' : 'Организация обновлена.');
  } catch (error) { fail(error); }
});
$('#delete-organization').addEventListener('click', async () => {
  const org = state.organizations.find((item) => item.id === state.organizationId);
  if (!window.confirm(`Удалить организацию «${org?.name}» вместе со ВСЕМИ кварталами и затратами? Без резервной копии действие нельзя отменить.`)) return;
  try { await api('/api/organizations', { method: 'DELETE', body: { organization_id: state.organizationId } }); $('#organization-dialog').close(); state.organizationId = null; state.dirty = false; await refreshOrganizations(); await refresh(); toast('Организация удалена.'); } catch (error) { fail(error); }
});
$('#add-category').addEventListener('click', () => { $('#category-form').reset(); $('#category-dialog').showModal(); $('#category-name').focus(); });
$('#category-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (state.addingCategory) return;
  try {
    const name = $('#category-name').value.trim(), rate = $('#category-rate').value.trim(), kind = $('#category-kind').value;
    if (!name) { $('#category-name').focus(); throw new Error('Введите название статьи.'); }
    if (rate && (!/^\d{1,3}([.,]\d{1,8})?$/.test(rate) || Number(rate.replace(',', '.')) > 100)) throw new Error('Ставка НДС должна быть от 0 до 100%.');
    const draft = collect(), wasDirty = state.dirty;
    state.addingCategory = true; $('#application').inert = true; $('#category-form').inert = true;
    const result = await api('/api/categories', { method: 'POST', body: { organization_id: state.organizationId, year: state.year, revision: state.saved.revision, name, tag: rate.replace(',', '.') } });
    draft.settings[String(result.category.id)] = { vat_rate: rate || null, cost_type: kind };
    $('#category-dialog').close(); await refresh(draft, wasDirty || kind !== 'unclassified', result.category.year_revision);
    toast(kind === 'unclassified' ? 'Статья добавлена.' : 'Статья добавлена. Сохраните выбранный тип затрат.');
  } catch (error) { fail(error); }
  finally { state.addingCategory = false; $('#application').inert = false; $('#category-form').inert = false; }
});
$('#category-dialog').addEventListener('cancel', (event) => { if (state.addingCategory) event.preventDefault(); });
$('#year-form').addEventListener('input', (event) => { if (event.target.matches('input, select')) { setDirty(true); schedulePreview(); } });
$('#year-form').addEventListener('change', (event) => { if (event.target.matches('select')) { setDirty(true); schedulePreview(); } });
$('#year-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (state.saving) return;
  state.saving = true; state.previewId++; clearTimeout(state.previewTimer);
  const payload = collect(); $('#application').inert = true;
  try { await api('/api/year', { method: 'POST', body: payload }); state.dirty = false; await refresh(); toast('Изменения сохранены.'); }
  catch (error) { fail(error); }
  finally { state.saving = false; $('#application').inert = false; }
});
$('#organization-select').addEventListener('change', async (event) => {
  if (!confirmDiscard()) { event.target.value = String(state.organizationId); return; }
  state.organizationId = Number(event.target.value); state.dirty = false; try { await refresh(); } catch (error) { fail(error); }
});
async function setYear(value) {
  const next = Number(value);
  if (!Number.isInteger(next) || next < 1900 || next > 9999) { $('#year-input').value = state.year; toast('Укажите год от 1900 до 9999.', true); return; }
  if (next === state.year) { $('#year-input').value = state.year; return; }
  if (!confirmDiscard()) { $('#year-input').value = state.year; return; }
  state.year = next; state.dirty = false; try { await refresh(); } catch (error) { fail(error); }
}
$('#year-input').addEventListener('change', (event) => setYear(event.target.value));
$('#year-prev').addEventListener('click', () => setYear(state.year - 1)); $('#year-next').addEventListener('click', () => setYear(state.year + 1));
$('#export-xlsx').addEventListener('click', () => { if (requireSaved()) download(`/api/report.xlsx?${selectedQuery()}`, `analiz-${state.year}.xlsx`).catch(fail); });
$('#export-csv').addEventListener('click', () => { if (requireSaved()) download(`/api/report.csv?${selectedQuery()}`, `analiz-${state.year}.csv`).catch(fail); });
function backup() { if (state.dirty && !window.confirm('Резервная копия включает только сохранённые данные. Продолжить?')) return; download('/api/backup', 'analiz-backup.sqlite3').then(() => toast('Резервная копия скачана.')).catch(fail); }
$('#backup').addEventListener('click', backup); $('#backup-footer').addEventListener('click', backup);
$('#import-xlsx').addEventListener('click', () => { if (requireSaved()) $('#xlsx-file').click(); });
$('#xlsx-file').addEventListener('change', async (event) => {
  const file = event.target.files[0]; if (!file) return;
  $('#application').inert = true;
  try { await previewFile(file); } catch (error) { fail(error); }
  finally { event.target.value = ''; $('#application').inert = false; }
});
$('#import-dialog').addEventListener('cancel', (event) => { if (state.importing) event.preventDefault(); });
$('#import-confirm').addEventListener('change', () => { $('#import-apply').disabled = !$('#import-confirm').checked; });
$('#import-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (!$('#import-confirm').checked || state.importing) return;
  const replace = document.querySelector('input[name="import-mode"]:checked').value === 'replace';
  const applySettings = $('#import-settings').checked;
  state.importing = true; $('#application').inert = true; $('#import-form').inert = true;
  try {
    const result = await api('/api/excel/import', { method: 'POST', body: { preview_token: state.importToken, replace_existing: replace, apply_settings: applySettings } });
    $('#import-dialog').close(); state.importToken = null; state.dirty = false; await refresh();
    toast(`Загружены кварталы: ${result.imported_quarters.join(', ') || 'нет'}.${result.skipped_quarters.length ? ` Пропущены: ${result.skipped_quarters.join(', ')}.` : ''}`);
  } catch (error) { fail(error); }
  finally { state.importing = false; $('#application').inert = false; $('#import-form').inert = false; }
});
$('#shutdown').addEventListener('click', async () => {
  if (!confirmDiscard() || !window.confirm('Завершить работу приложения?')) return;
  try { await api('/api/shutdown', { method: 'POST', body: {} }); state.dirty = false; document.body.innerHTML = '<div class="onboarding"><div class="eyebrow centered">РАБОТА ЗАВЕРШЕНА</div><h1>Приложение закрыто</h1><p>Ваши данные сохранены на компьютере. Эту вкладку можно закрыть.</p></div>'; } catch (error) { fail(error); }
});
window.addEventListener('beforeunload', (event) => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
(async () => { restoreSelection(); restorePanels(); $$('[data-panel-toggle]').forEach(applyPanel); await refreshOrganizations(); await refresh(); })().catch((error) => { $('#fatal-error').textContent = `Не удалось открыть приложение: ${error.message}`; $('#fatal-error').classList.remove('hidden'); fail(error); });
