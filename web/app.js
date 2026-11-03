/* Все разделы на одной странице; финансовые расчёты выполняет Python/Decimal. */
'use strict';
const token = document.querySelector('meta[name="analiz-token"]').content;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {
  organizations: [], organizationId: null, year: new Date().getFullYear(),
  saved: null, view: null, dirty: false, saving: false, dialogMode: 'create',
  refreshId: 0, previewId: 0, previewTimer: null, importToken: null, importing: false, addingCategory: false,
  charts: {}, toastTimer: null,
};
const fields = ['retail_revenue', 'invoice_revenue', 'invoice_vat', 'non_vat_sales', 'non_vat_deduction', 'input_vat', 'cost_of_sales'];
const reportRows = [
  ['4', 'Налог НДС', 'vat_due', false], ['5', 'Налог на прибыль', 'profit_tax', false],
  ['6', 'Прибыль', 'profit', false], ['7', 'Чистая прибыль', 'net_profit', false],
  ['8', 'Выручка по отчётам ККМ с НДС', 'retail_revenue', true], ['9', 'Реализация по накладным с НДС', 'invoice_revenue', true],
  ['10', 'Итого выручка', 'revenue', false], ['11', 'НДС выручки по отчётам ККМ', 'retail_vat', false],
  ['12', 'НДС реализации по накладным', 'invoice_vat', true], ['13', 'Итого НДС', 'output_vat', false],
  ['14', 'Товары реализации без НДС', 'non_vat_sales', true], ['15', 'Вычет по товарам без НДС', 'non_vat_deduction', true],
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
function setDirty(value) {
  state.dirty = value;
  $('#save-status').textContent = value ? 'Есть несохранённые изменения' : 'Все изменения сохранены';
  $('#save-status').classList.toggle('dirty', value);
  if (!value) { $('#preview-status').textContent = 'Данные на вашем компьютере'; $('#preview-status').classList.remove('error'); }
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
function renderSheet(summary, draft = null) {
  let html = '';
  for (const [row, label, key, manual] of reportRows) {
    if (row === '4') html += '<tr class="group-row"><th colspan="8">ФИНАНСОВЫЙ РЕЗУЛЬТАТ</th></tr>';
    if (row === '8') html += '<tr class="group-row"><th colspan="8">ПРОДАЖИ, НДС И СЕБЕСТОИМОСТЬ</th></tr>';
    html += `<tr class="${['4','5','6','7','10','13','19'].includes(row) ? 'row-important' : ''}"><td><div class="label-cell"><span class="row-code">${row}</span><span class="label-name">${esc(label)}</span><span class="row-kind ${manual ? 'manual' : ''}">${manual ? 'ввод' : 'расчёт'}</span></div></td><td class="muted-cell">—</td><td class="muted-cell">—</td>`;
    for (let q = 1; q <= 4; q++) {
      if (manual) {
        const value = rawInputValue(summary, draft, q, key);
        html += `<td><input class="sheet-input" data-input="${key}" data-quarter="${q}" inputmode="decimal" autocomplete="off" maxlength="32" value="${esc(value)}" placeholder="—" aria-label="${esc(label)}, ${q} квартал"></td>`;
      } else html += `<td class="calculated" data-metric="${key}" data-quarter="${q}">—</td>`;
    }
    html += `<td class="calculated" data-annual="${key}">—</td></tr>`;
  }
  html += '<tr class="group-row"><th colspan="8">СТАТЬИ ЗАТРАТ БЕЗ НДС · УКАЖИТЕ ТИП ДЛЯ ТОЧКИ БЕЗУБЫТОЧНОСТИ</th></tr>';
  for (const category of summary.expenses) {
    const id = String(category.id), settings = draft?.settings?.[id] || { vat_rate: category.vat_rate ?? '', cost_type: category.cost_type };
    const label = category.archived ? 'Вернуть статью из архива' : 'Перенести статью в архив';
    const source = category.source_row ? String(category.source_row) : '•';
    html += `<tr class="${category.archived ? 'archived-row' : ''}"><td><div class="label-cell"><span class="row-code">${source}</span><span class="label-name">${esc(category.name)}</span>${category.archived ? '<span class="archived-label">архив</span>' : ''}<button class="category-action" type="button" data-archive="${id}" data-next="${category.archived ? 'false' : 'true'}" title="${label}" aria-label="${label}">${category.archived ? '↶' : '−'}</button></div></td>`;
    html += `<td><input class="sheet-input rate-input" data-rate="${id}" inputmode="decimal" autocomplete="off" maxlength="12" value="${esc(settings.vat_rate ?? '')}" placeholder="—" aria-label="Ставка НДС: ${esc(category.name)}"></td>`;
    html += `<td><select class="sheet-select" data-kind="${id}" aria-label="Тип затрат: ${esc(category.name)}"><option value="unclassified" ${settings.cost_type === 'unclassified' ? 'selected' : ''}>Не определён</option><option value="fixed" ${settings.cost_type === 'fixed' ? 'selected' : ''}>Постоянные</option><option value="variable" ${settings.cost_type === 'variable' ? 'selected' : ''}>Переменные</option></select></td>`;
    for (let q = 1; q <= 4; q++) html += `<td><input class="sheet-input" data-expense="${id}" data-quarter="${q}" inputmode="decimal" autocomplete="off" maxlength="32" value="${esc(rawExpenseValue(summary, draft, q, category))}" placeholder="—" aria-label="${esc(category.name)}, ${q} квартал"></td>`;
    html += `<td class="calculated" data-category-total="${id}">—</td></tr>`;
  }
  $('#sheet-body').innerHTML = html;
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
  $('#preview-status').textContent = 'Пересчёт…'; $('#preview-status').classList.remove('error');
  state.previewTimer = setTimeout(async () => {
    try {
      const view = await api('/api/year/preview', { method: 'POST', body: collect() });
      if (serial !== state.previewId) return;
      state.view = view; renderResults(view);
      $('#preview-status').textContent = view.quarters.some((q) => q.state === 'incomplete') ? 'Для нового квартала заполните все 7 основных показателей.' : state.dirty ? 'Расчёт обновлён. Сохраните изменения.' : 'Данные на вашем компьютере';
    } catch (error) {
      if (serial !== state.previewId) return;
      $('#preview-status').textContent = error.message; $('#preview-status').classList.add('error');
    }
  }, 350);
}
function updateSheetValues(s) {
  $$('[data-metric]').forEach((cell) => {
    const q = s.quarters[Number(cell.dataset.quarter) - 1];
    cell.textContent = q.exists ? money(q.metrics[cell.dataset.metric]) : '—';
    cell.classList.toggle('muted-cell', !q.exists);
  });
  $$('[data-annual]').forEach((cell) => {
    const key = cell.dataset.annual;
    cell.textContent = !s.quarter_count ? '—' : (key === 'non_vat_deduction' && s.annual[key] === null ? '#ДЕЛ/0!' : money(s.annual[key]));
  });
  const byId = Object.fromEntries(s.expenses.map((expense) => [String(expense.id), expense]));
  $$('[data-category-total]').forEach((cell) => { cell.textContent = s.quarter_count ? money(byId[cell.dataset.categoryTotal]?.total) : '—'; });
  for (let q = 1; q <= 4; q++) {
    const item = s.quarters[q - 1], label = $(`#q-status-${q}`), wasSaved = state.saved?.quarters[q - 1]?.exists;
    const status = item.state === 'incomplete' ? 'не заполнен' : item.state === 'empty' ? 'нет данных' : state.dirty ? 'черновик' : 'сохранён';
    label.textContent = status; label.classList.toggle('saved', status === 'сохранён'); label.classList.toggle('incomplete', status === 'не заполнен');
    $(`[data-delete-quarter="${q}"]`).disabled = !wasSaved;
  }
  const note = $('#deduction-note');
  if (!s.quarter_count) note.innerHTML = '<strong>Годовой вычет:</strong> H15 считается отдельно по формуле H14 / H10 × H16. Квартальные вычеты вводятся вручную.';
  else if (s.annual.non_vat_deduction === null) note.innerHTML = '<strong>Годовой вычет H15 не определён (#ДЕЛ/0!):</strong> выручка равна нулю. H17 остаётся суммой квартальных значений.';
  else note.innerHTML = `<strong>Формула исходной книги:</strong> H15 = H14 / H10 × H16: <strong>${esc(money(s.annual.non_vat_deduction))}</strong>; сумма квартальных вычетов: <strong>${esc(money(s.annual.quarterly_deduction_sum))}</strong>; разница: <strong>${esc(fixed(s.annual.deduction_difference, 8, true))}</strong>. H17 — сумма квартальных значений.`;
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
    ['Постоянные затраты', 'analysis', 'fixed_costs', false], ['Переменные затраты', 'analysis', 'variable_costs', false],
    ['Маржинальный доход', 'analysis', 'contribution', false], ['Маржинальность, %', 'analysis', 'contribution_margin', true],
    ['Точка безубыточности · без НДС', 'analysis', 'break_even_revenue', false], ['Запас прочности', 'analysis', 'safety_amount', false],
    ['Запас прочности, %', 'analysis', 'safety_percent', true], ['Чистая прибыль', 'metrics', 'net_profit', false],
    ['Чистая рентабельность, %', 'metrics', 'net_margin', true],
  ];
  $('#analysis-body').innerHTML = rows.map(([label, group, key, percent]) => {
    const format = (value) => value === null ? '—' : `${fixed(value)}${percent ? '%' : ''}`;
    const cells = s.quarters.map((q) => `<td>${esc(format(analysisValue(group === 'analysis' ? q.analysis : q.metrics, group, key)))}</td>`).join('');
    const total = analysisValue(group === 'analysis' ? s.analysis : (s.quarter_count ? s.annual : null), group, key);
    return `<tr class="${key === 'break_even_revenue' ? 'analysis-emphasis' : ''}"><td>${esc(label)}</td>${cells}<td>${esc(format(total))}</td></tr>`;
  }).join('') + `<tr><td>Состояние расчёта порога</td>${s.quarters.map((q) => `<td>${esc(q.analysis ? statusLabels[q.analysis.break_even_status] : '—')}</td>`).join('')}<td>${esc(s.analysis ? statusLabels[s.analysis.break_even_status] : '—')}</td></tr>`;
}
const COLORS = { green: '#1d8464', light: '#b9d9bb', yellow: '#d8bd72', grid: '#f0f3f0', red: '#cf8775', blue: '#83b8ad' };
function chartOptions() {
  return { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { position: 'bottom', align: 'start', labels: { boxWidth: 9, boxHeight: 9, padding: 17, color: '#83958a', font: { size: 10, family: 'Segoe UI, Arial' }, usePointStyle: true, pointStyle: 'circle' } },
      tooltip: { backgroundColor: '#284c3c', padding: 10, cornerRadius: 7, callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${money(ctx.dataset.original?.[ctx.dataIndex] ?? ctx.raw, true)}` } } },
    scales: { x: { grid: { display: false }, border: { display: false }, ticks: { color: '#a2b0a6', font: { size: 10 } } },
      y: { grid: { color: COLORS.grid }, border: { display: false }, ticks: { color: '#a2b0a6', font: { size: 10 }, maxTicksLimit: 5, callback: (value) => compact(value) } } } };
}
function dataset(label, original, color, extra = {}) { return { label, original, data: original.map(n), backgroundColor: color, borderColor: color, borderRadius: 4, maxBarThickness: 30, ...extra }; }
function plot(id, config, hasData) {
  const canvas = $(`#${id}`), empty = $(`#${id}-empty`);
  if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
  canvas.classList.toggle('hidden', !hasData); empty.classList.toggle('hidden', hasData);
  if (!hasData) return;
  if (typeof Chart === 'undefined') { empty.textContent = 'Не удалось загрузить график.'; empty.classList.remove('hidden'); return; }
  state.charts[id] = new Chart(canvas, config);
}
function renderCharts(s) {
  const qValues = (key, group = 'metrics') => s.quarters.map((q) => q[group]?.[key] ?? null);
  const labels = ['1 кв.', '2 кв.', '3 кв.', '4 кв.'];
  plot('quarter-chart', { type: 'bar', data: { labels, datasets: [
    dataset('Выручка с НДС', qValues('revenue'), COLORS.green), dataset('Себестоимость и затраты', qValues('total_costs'), COLORS.light),
    dataset('Чистая прибыль', qValues('net_profit'), COLORS.yellow, { type: 'line', borderWidth: 2.5, pointRadius: 4, tension: .2, fill: false, spanGaps: false }),
  ] }, options: chartOptions() }, s.quarter_count > 0);
  const breakValues = qValues('break_even_revenue', 'analysis');
  plot('break-even-chart', { type: 'bar', data: { labels, datasets: [
    dataset('Выручка без НДС', qValues('revenue_without_vat'), COLORS.green), dataset('Точка безубыточности', breakValues, COLORS.yellow),
  ] }, options: chartOptions() }, breakValues.some((value) => value !== null));
  const costs = s.expenses.filter((item) => n(item.total) !== 0).sort((a, b) => Math.abs(n(b.total)) - Math.abs(n(a.total))).slice(0, 10);
  const options = chartOptions(); options.indexAxis = 'y'; options.plugins.legend.display = false;
  options.interaction = { mode: 'nearest', intersect: true };
  options.scales = { x: { grid: { color: COLORS.grid }, border: { display: false }, ticks: { color: '#a2b0a6', font: { size: 10 }, maxTicksLimit: 4, callback: (value) => compact(value) } }, y: { grid: { display: false }, border: { display: false }, ticks: { color: '#7c9082', font: { size: 10 }, autoSkip: false } } };
  const originals = costs.map((item) => item.total);
  plot('expense-chart', { type: 'bar', data: { labels: costs.map((item) => item.name + (item.vat_rate !== null ? ` · ${item.vat_rate}%` : '')), datasets: [dataset('Затраты', originals, COLORS.green, { backgroundColor: originals.map((v) => n(v) < 0 ? COLORS.red : COLORS.green), maxBarThickness: 17 })] }, options }, costs.length > 0);
  const history = s.history, values = (key) => history.map((item) => item.annual[key]);
  const line = (label, key, color) => dataset(label, values(key), color, { borderWidth: 2, pointRadius: 4, tension: .2, fill: false });
  plot('history-chart', { type: 'line', data: { labels: history.map((item) => `${item.year}${item.count < 4 ? ` · ${item.count}/4` : ''}`), datasets: [line('Выручка с НДС', 'revenue', COLORS.green), line('Затраты', 'total_costs', COLORS.blue), line('Чистая прибыль', 'net_profit', COLORS.yellow)] }, options: chartOptions() }, history.length > 0);
  plot('tax-chart', { type: 'bar', data: { labels, datasets: [dataset('Итого НДС', qValues('output_vat'), COLORS.light), dataset('Налог НДС', qValues('vat_due'), COLORS.green), dataset('Налог на прибыль', qValues('profit_tax'), COLORS.yellow)] }, options: chartOptions() }, s.quarter_count > 0);
}
function renderResults(summary) {
  updateSheetValues(summary); renderStats(summary); renderAssessment(summary); renderAnalysisTable(summary);
  requestAnimationFrame(() => { if (state.view === summary) renderCharts(summary); });
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
  $('#import-summary').innerHTML = `<strong>${esc(file.name)}</strong><br>Назначение: <strong>${esc(plan.organization.name)} · ${plan.year}</strong>, валюта: ${esc(plan.organization.currency || 'не указана')}.<br>В файле заполнены кварталы: <strong>${esc(plan.quarters.join(', '))}</strong>.${metaText}${additions}<br>Конвертация валют не выполняется.${warning}`;
  $('#import-conflicts').classList.toggle('hidden', !plan.existing_quarters.length);
  $('#import-conflicts input[value="skip"]').checked = true;
  $('#import-settings').checked = plan.all_existing_quarters.length === 0;
  $('#import-confirm').checked = false; $('#import-apply').disabled = true;
  $('#import-confirm-label').textContent = `Подтверждаю загрузку в «${plan.organization.name}» за ${plan.year} год.`;
  $('#import-dialog').showModal();
}

document.addEventListener('click', (event) => {
  const close = event.target.closest('[data-close-dialog]'); if (close) { $(`#${close.dataset.closeDialog}`).close(); return; }
  const fill = event.target.closest('[data-fill-quarter]');
  if (fill) {
    const q = fill.dataset.fillQuarter;
    $$(`[data-input][data-quarter="${q}"]`).forEach((input) => { if (!input.value.trim()) input.value = '0'; });
    setDirty(true); schedulePreview(); return;
  }
  const remove = event.target.closest('[data-delete-quarter]');
  if (remove) {
    const q = Number(remove.dataset.deleteQuarter); if (!requireSaved()) return;
    if (!window.confirm(`Удалить все данные за ${q} квартал ${state.year} года?`)) return;
    api('/api/period', { method: 'DELETE', body: { organization_id: state.organizationId, year: state.year, quarter: q } }).then(() => refresh()).then(() => toast('Квартал удалён.')).catch(fail); return;
  }
  const archive = event.target.closest('[data-archive]');
  if (archive) {
    if (!requireSaved()) return;
    const archived = archive.dataset.next === 'true';
    if (!window.confirm(archived ? 'Перенести статью в архив? Прошлые суммы сохранятся.' : 'Вернуть статью из архива?')) return;
    api('/api/categories', { method: 'PATCH', body: { organization_id: state.organizationId, category_id: Number(archive.dataset.archive), archived } }).then(() => refresh()).then(() => toast(archived ? 'Статья перенесена в архив.' : 'Статья восстановлена.')).catch(fail);
  }
});
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
(async () => { restoreSelection(); await refreshOrganizations(); await refresh(); })().catch((error) => { $('#fatal-error').textContent = `Не удалось открыть приложение: ${error.message}`; $('#fatal-error').classList.remove('hidden'); fail(error); });
