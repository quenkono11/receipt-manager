import { t, tp, setLang, getLang, locale } from './i18n.js';
import { esc, fmtMoney, fmtDate, fmtDateTime, parseMoney, parseQty, minorToInput, nowLocal, todayISO, digits, receiptTotals } from './format.js';
import { buildReport, reportToCsv } from './reports.js';

const api = window.api;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  folder: null, folderOk: true,
  receipts: [], problems: [], stores: [],
  view: 'list', selectedId: null, editing: null, storeEdit: null,
  filters: { q: '', from: '', to: '', store: '' },
  report: { period: 'month', from: `${new Date().getFullYear()}-01-01`, to: todayISO(), currency: '' },
};

// ---------- state ----------
function applyState(st) {
  S.folder = st.folder; S.folderOk = st.folderOk;
  setLang(st.language);
  document.title = t('app.title');
}
async function reload() {
  if (!S.folder) { S.receipts = []; S.stores = []; S.problems = []; return; }
  const r = await api.listReceipts();
  S.receipts = r.receipts || []; S.problems = r.problems || []; S.folderOk = !r.error;
  S.stores = await api.listStores();
}
async function init() {
  applyState(await api.getState());
  await reload();
  render();
  // Files copied into the folder (or changed elsewhere) show up automatically.
  api.onDataChanged(async () => {
    await reload();
    if (S.view === 'detail' && !S.receipts.some((r) => r.id === S.selectedId)) S.view = 'list';
    if (S.view !== 'form' && S.view !== 'settings') render();
  });
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}
const go = (view) => { S.view = view; render(); window.scrollTo(0, 0); };
const langSelect = () => `<label class="field inline"><span>${t('settings.language')}</span>
  <select id="langSel"><option value="en"${getLang() === 'en' ? ' selected' : ''}>English</option>
  <option value="de"${getLang() === 'de' ? ' selected' : ''}>Deutsch</option></select></label>`;

// ---------- layout ----------
function render() {
  const app = $('#app');
  if (!S.folder) { app.innerHTML = setupHtml(); return; }
  const active = S.view === 'detail' ? 'list' : S.view === 'form' ? (S.editing ? 'list' : 'new') : S.view;
  const nav = [['list', 'nav.list'], ['new', 'nav.new'], ['report', 'nav.report'], ['stores', 'nav.stores'], ['settings', 'nav.settings']]
    .map(([v, k]) => `<button class="nav-item${active === v ? ' active' : ''}" data-action="nav" data-view="${v}">${t(k)}</button>`).join('');
  const banner = S.folderOk ? '' : `<div class="banner error">${t('banner.folderMissing')}
    <button class="btn" data-action="chooseFolder">${t('banner.chooseFolder')}</button></div>`;
  app.innerHTML = `<div class="shell"><aside class="side"><div class="brand">${t('app.title')}</div><nav>${nav}</nav></aside>
    <main class="main">${banner}${viewHtml()}</main></div>`;
  if (S.view === 'form') initForm();
}
function viewHtml() {
  switch (S.view) {
    case 'detail': return detailHtml();
    case 'form': return formHtml();
    case 'report': return reportHtml();
    case 'stores': return storesHtml();
    case 'settings': return settingsHtml();
    default: return listHtml();
  }
}
function setupHtml() {
  return `<div class="setup"><div class="setup-card"><h1>${t('setup.title')}</h1><p>${t('setup.text')}</p>
    <div class="row"><button class="btn primary" data-action="chooseFolder">${t('setup.choose')}</button>${langSelect()}</div></div></div>`;
}

// ---------- receipts list ----------
const storeLabel = (r) => esc(r.store && r.store.name) + (r.store && r.store.location ? ` <span class="muted">${esc(r.store.location)}</span>` : '');

function filteredReceipts() {
  const f = S.filters; const q = f.q.trim().toLowerCase();
  return S.receipts.filter((r) => {
    const d = r.purchasedAt.slice(0, 10);
    if (f.from && d < f.from) return false;
    if (f.to && d > f.to) return false;
    if (f.store && (r.store && r.store.name) !== f.store) return false;
    if (!q) return true;
    const hay = [r.id, r.store && r.store.name, r.store && r.store.location, r.notes, ...r.items.map((i) => i.name)].join(' ').toLowerCase();
    return hay.includes(q);
  }).sort((a, b) => (a.purchasedAt === b.purchasedAt ? (a.id < b.id ? 1 : -1) : a.purchasedAt < b.purchasedAt ? 1 : -1));
}
function listBodyHtml() {
  if (!S.receipts.length) return `<p class="empty">${t('list.empty')}</p>`;
  const rows = filteredReceipts();
  if (!rows.length) return `<p class="empty">${t('list.noMatch')}</p>`;
  const sums = {};
  rows.forEach((r) => { sums[r.currency] = (sums[r.currency] || 0) + receiptTotals(r).total; });
  const sumText = Object.entries(sums).map(([c, m]) => fmtMoney(m, c)).join(' · ');
  return `<table class="table clickable"><thead><tr><th>${t('col.date')}</th><th>${t('col.id')}</th><th>${t('col.store')}</th>
    <th class="num">${t('col.items')}</th><th class="num">${t('col.total')}</th></tr></thead><tbody>
    ${rows.map((r) => `<tr data-action="open" data-id="${esc(r.id)}"><td>${fmtDate(r.purchasedAt)}</td><td class="mono">${esc(r.id)}</td>
      <td>${storeLabel(r)}</td><td class="num">${r.items.length}</td><td class="num">${fmtMoney(receiptTotals(r).total, r.currency)}</td></tr>`).join('')}
    </tbody></table><p class="muted foot">${tp('list.count', rows.length)} · ${sumText}</p>`;
}
function listHtml() {
  const stores = [...new Set(S.receipts.map((r) => r.store && r.store.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const problems = S.problems.length ? `<details class="banner warn"><summary>${tp('problems.title', S.problems.length)}</summary>
    <ul>${S.problems.map((p) => `<li><span class="mono">${esc(p.file)}</span>: ${esc(p.message)}</li>`).join('')}</ul></details>` : '';
  return `<header class="head"><h1>${t('list.title')}</h1><div class="row">
    <button class="btn" data-action="import">${t('list.import')}</button>
    <button class="btn primary" data-action="new">${t('nav.new')}</button></div></header>${problems}
    <div class="filters"><input type="search" data-filter="q" placeholder="${esc(t('list.search'))}" value="${esc(S.filters.q)}">
    <label class="field inline"><span>${t('filter.from')}</span><input type="date" data-filter="from" value="${esc(S.filters.from)}"></label>
    <label class="field inline"><span>${t('filter.to')}</span><input type="date" data-filter="to" value="${esc(S.filters.to)}"></label>
    <select data-filter="store"><option value="">${t('filter.allStores')}</option>
    ${stores.map((s) => `<option${S.filters.store === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
    <div id="listBody">${listBodyHtml()}</div>`;
}

// ---------- receipt detail ----------
function detailHtml() {
  const r = S.receipts.find((x) => x.id === S.selectedId);
  if (!r) return listHtml();
  const tot = receiptTotals(r); const cur = r.currency;
  const items = r.items.length ? r.items.map((i) => `<tr><td>${esc(i.name)}${i.quantity !== 1 ? `<div class="muted">${i.quantity} × ${fmtMoney(i.unitPriceMinor, cur)}</div>` : ''}</td>
    <td class="num">${fmtMoney(Math.round(i.quantity * i.unitPriceMinor), cur)}</td></tr>`).join('')
    : `<tr><td class="muted">${t('detail.noItems')}</td><td></td></tr>`;
  return `<header class="head"><div class="row"><button class="btn" data-action="nav" data-view="list">${t('common.back')}</button></div>
    <div class="row"><button class="btn" data-action="edit" data-id="${esc(r.id)}">${t('common.edit')}</button>
    <button class="btn danger" data-action="delete" data-id="${esc(r.id)}">${t('common.delete')}</button></div></header>
    <article class="slip"><div class="slip-head"><div class="slip-store">${esc(r.store.name)}</div>
    ${r.store.location ? `<div>${esc(r.store.location)}</div>` : ''}<div class="slip-meta">${fmtDateTime(r.purchasedAt)}</div>
    <div class="slip-meta mono">${esc(r.id)}</div></div>
    <table class="slip-items"><tbody>${items}</tbody></table>
    <table class="slip-sum"><tbody><tr><td>${t('detail.subtotal')}</td><td class="num">${fmtMoney(tot.subtotal, cur)}</td></tr>
    <tr><td>${r.taxIncluded ? t('detail.taxIncluded') : t('detail.taxAdded')}</td><td class="num">${fmtMoney(tot.tax, cur)}</td></tr>
    <tr class="grand"><td>${t('detail.total')}</td><td class="num">${fmtMoney(tot.total, cur)}</td></tr></tbody></table>
    ${r.notes ? `<div class="slip-notes"><strong>${t('detail.notes')}</strong><br>${esc(r.notes).replace(/\n/g, '<br>')}</div>` : ''}</article>`;
}

// ---------- receipt form ----------
function itemRowHtml(item) {
  const cur = (S.editing && S.editing.currency) || 'EUR';
  return `<tr class="item-row"><td><input class="i-name" type="text" value="${esc(item.name)}" aria-label="${t('form.itemName')}"></td>
    <td><input class="i-qty num" type="text" inputmode="decimal" value="${esc(String(item.quantity ?? 1).replace('.', locale().startsWith('de') ? ',' : '.'))}" aria-label="${t('form.qty')}"></td>
    <td><input class="i-price num" type="text" inputmode="decimal" value="${item.unitPriceMinor ? esc(minorToInput(item.unitPriceMinor, cur)) : ''}" aria-label="${t('form.unitPrice')}"></td>
    <td class="num i-line"></td>
    <td><button class="icon-btn" data-action="removeRow" title="${t('form.removeItem')}" aria-label="${t('form.removeItem')}">×</button></td></tr>`;
}
function formHtml() {
  const r = S.editing;
  const cur = r ? r.currency : (localStorage.getItem('lastCurrency') || 'EUR');
  const match = r && S.stores.find((s) => s.name === r.store.name && (s.location || '') === (r.store.location || ''));
  const selNew = (r && !match) || (!r && !S.stores.length);
  const storeOpts = S.stores.map((s) => `<option value="${esc(s.id)}"${match && match.id === s.id ? ' selected' : ''}>${esc(s.name)}${s.location ? ' — ' + esc(s.location) : ''}</option>`).join('');
  const items = r && r.items.length ? r.items : [{ name: '', quantity: 1, unitPriceMinor: 0 }];
  return `<header class="head"><h1>${r ? t('form.titleEdit', { id: r.id }) : t('form.titleNew')}</h1>
    <div class="row"><button class="btn" data-action="cancelForm">${t('common.cancel')}</button>
    <button class="btn primary" data-action="saveForm">${t('form.save')}</button></div></header>
    ${r ? '' : `<p class="muted">${t('form.idNote')}</p>`}
    <div id="receiptForm" class="form">
      <div class="grid2"><label class="field"><span>${t('form.store')}</span><select id="storeSel">
        ${selNew ? '' : `<option value="">${t('form.chooseStore')}</option>`}${storeOpts}
        <option value="__new__"${selNew ? ' selected' : ''}>${t('form.newStore')}</option></select></label>
      <label class="field"><span>${t('form.datetime')}</span><input id="dt" type="datetime-local" value="${esc(r ? r.purchasedAt.slice(0, 16) : nowLocal())}"></label></div>
      <div id="newStore" class="grid2"${selNew ? '' : ' hidden'}>
        <label class="field"><span>${t('form.storeName')}</span><input id="newStoreName" type="text" value="${esc(selNew && r ? r.store.name : '')}"></label>
        <label class="field"><span>${t('form.storeLocation')}</span><input id="newStoreLoc" type="text" value="${esc(selNew && r ? r.store.location : '')}"></label>
        <label class="check"><input id="saveStore" type="checkbox" checked> ${t('form.saveStore')}</label></div>
      <label class="field narrow"><span>${t('form.currency')}</span><input id="cur" type="text" maxlength="3" list="curList" value="${esc(cur)}">
        <datalist id="curList">${['EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK'].map((c) => `<option value="${c}">`).join('')}</datalist></label>
      <h2>${t('form.items')}</h2>
      <table id="items" class="table items"><thead><tr><th>${t('form.itemName')}</th><th class="num">${t('form.qty')}</th>
        <th class="num">${t('form.unitPrice')}</th><th class="num">${t('form.lineTotal')}</th><th></th></tr></thead>
        <tbody>${items.map(itemRowHtml).join('')}</tbody></table>
      <button class="btn" data-action="addRow">${t('form.addItem')}</button>
      <div class="grid2 tax-row"><label class="field"><span>${t('form.tax')}</span><input id="tax" type="text" inputmode="decimal" class="num" value="${r && r.taxMinor ? esc(minorToInput(r.taxMinor, cur)) : ''}"></label>
        <label class="check"><input id="taxIncl" type="checkbox"${r && r.taxIncluded ? ' checked' : ''}> ${t('form.taxIncluded')}</label></div>
      <dl class="sums"><dt>${t('form.subtotal')}</dt><dd id="sumSub"></dd><dt>${t('form.taxLine')}</dt><dd id="sumTax"></dd>
        <dt class="grand">${t('form.total')}</dt><dd id="sumTotal" class="grand"></dd></dl>
      <label class="field"><span>${t('form.notes')}</span><textarea id="notes" rows="3">${esc(r ? r.notes : '')}</textarea></label>
    </div>`;
}
function initForm() { updateTotals(); }
function updateTotals() {
  if (!$('#receiptForm')) return;
  const cur = $('#cur').value.trim().toUpperCase();
  const dig = digits(cur || 'EUR');
  const money = (m) => (/^[A-Z]{3}$/.test(cur) ? fmtMoney(m, cur) : (m / 10 ** dig).toFixed(dig));
  let subtotal = 0;
  $$('#items .item-row').forEach((row) => {
    const q = parseQty($('.i-qty', row).value.trim() || '1');
    const p = parseMoney($('.i-price', row).value, cur || 'EUR');
    const ok = Number.isFinite(q) && p !== null;
    const line = ok ? Math.round(q * p) : 0;
    subtotal += line;
    $('.i-line', row).textContent = ok && $('.i-price', row).value.trim() ? money(line) : '';
  });
  const taxStr = $('#tax').value.trim();
  const tax = taxStr ? (parseMoney(taxStr, cur || 'EUR') || 0) : 0;
  $('#sumSub').textContent = money(subtotal);
  $('#sumTax').textContent = money(tax);
  $('#sumTotal').textContent = money(subtotal + ($('#taxIncl').checked ? 0 : tax));
}
async function saveForm() {
  const cur = $('#cur').value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) return toast(t('err.currency'), true);
  const dt = $('#dt').value;
  if (!dt) return toast(t('err.date'), true);

  let store; let newStore = null;
  const sel = $('#storeSel').value;
  if (sel === '__new__') {
    const name = $('#newStoreName').value.trim();
    if (!name) return toast(t('err.store'), true);
    store = { name, location: $('#newStoreLoc').value.trim() };
    if ($('#saveStore').checked) newStore = store;
  } else if (sel) {
    const s = S.stores.find((x) => x.id === sel);
    store = { name: s.name, location: s.location || '' };
  } else return toast(t('err.store'), true);

  const items = [];
  for (const row of $$('#items .item-row')) {
    const name = $('.i-name', row).value.trim();
    const priceStr = $('.i-price', row).value.trim();
    if (!name && !priceStr) continue;
    const price = priceStr ? parseMoney(priceStr, cur) : 0;
    const qty = parseQty($('.i-qty', row).value.trim() || '1');
    if (price === null) return toast(t('err.price'), true);
    if (!(qty > 0)) return toast(t('err.qty'), true);
    items.push({ name, quantity: qty, unitPriceMinor: price });
  }
  if (!items.length) return toast(t('err.noItems'), true);
  const taxStr = $('#tax').value.trim();
  const tax = taxStr ? parseMoney(taxStr, cur) : 0;
  if (tax === null) return toast(t('err.price'), true);

  const res = await api.saveReceipt({
    store, purchasedAt: dt, currency: cur, items, taxMinor: tax,
    taxIncluded: $('#taxIncl').checked, notes: $('#notes').value,
  }, S.editing ? S.editing.id : null);
  if (res.error) return toast(t('err.save', { message: res.error }), true);
  if (newStore) await api.upsertStore(newStore);
  localStorage.setItem('lastCurrency', cur);
  await reload();
  S.selectedId = res.receipt.id; S.editing = null;
  go('detail');
  toast(t('toast.saved', { id: res.receipt.id }));
}

// ---------- overview ----------
function periodLabel(key, period) {
  if (period === 'day') return fmtDate(key);
  if (period === 'week') { const [y, w] = key.split('-W'); return t('rep.weekLabel', { w: +w, y }); }
  if (period === 'month') { const [y, m] = key.split('-').map(Number); return new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1)); }
  if (period === 'quarter') { const [y, q] = key.split('-'); return `${q} ${y}`; }
  return key;
}
function currentReport() { return buildReport(S.receipts, S.report); }
function reportHtml() {
  const R = currentReport(); const p = S.report.period; const cur = R.currency;
  const periods = ['day', 'week', 'month', 'quarter', 'year'];
  const controls = `<div class="filters">
    <label class="field inline"><span>${t('rep.groupBy')}</span><select data-rep="period">${periods.map((x) => `<option value="${x}"${x === p ? ' selected' : ''}>${t('rep.' + x)}</option>`).join('')}</select></label>
    <label class="field inline"><span>${t('rep.from')}</span><input type="date" data-rep="from" value="${esc(S.report.from)}"></label>
    <label class="field inline"><span>${t('rep.to')}</span><input type="date" data-rep="to" value="${esc(S.report.to)}"></label>
    ${R.currencies.length ? `<label class="field inline"><span>${t('rep.currency')}</span><select data-rep="currency">${R.currencies.map((c) => `<option${c.code === cur ? ' selected' : ''}>${esc(c.code)}</option>`).join('')}</select></label>` : ''}</div>`;
  const head = `<header class="head"><h1>${t('rep.title')}</h1><div class="row">${R.rows.length ? `<button class="btn" data-action="exportCsv">${t('rep.export')}</button>` : ''}</div></header>`;
  if (!R.rows.length) return `${head}${controls}<p class="empty">${t('rep.noData')}</p>`;
  const max = Math.max(...R.rows.map((r) => r.totalMinor), 1);
  const stat = (label, value) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`;
  return `${head}${controls}
    <div class="stats">${stat(t('rep.spent'), fmtMoney(R.totals.totalMinor, cur))}${stat(t('rep.tax'), fmtMoney(R.totals.taxMinor, cur))}
    ${stat(t('rep.receipts'), R.totals.count)}${stat(t('rep.average'), fmtMoney(R.average, cur))}</div>
    ${R.currencies.length > 1 ? `<p class="muted">${t('rep.otherCurrencies')}</p>` : ''}
    <h2>${t('rep.byPeriod')}</h2>
    <div class="chart">${R.rows.map((r) => `<div class="bar-row"><span class="bar-label">${esc(periodLabel(r.key, p))}</span>
      <span class="bar-track"><span class="bar" style="width:${Math.max(0, (r.totalMinor / max) * 100).toFixed(1)}%"></span></span>
      <span class="bar-val">${fmtMoney(r.totalMinor, cur)}</span></div>`).join('')}</div>
    <table class="table"><thead><tr><th>${t('rep.period')}</th><th class="num">${t('rep.receipts')}</th><th class="num">${t('rep.tax')}</th><th class="num">${t('col.total')}</th></tr></thead><tbody>
    ${R.rows.map((r) => `<tr><td>${esc(periodLabel(r.key, p))}</td><td class="num">${r.count}</td><td class="num">${fmtMoney(r.taxMinor, cur)}</td><td class="num">${fmtMoney(r.totalMinor, cur)}</td></tr>`).join('')}</tbody></table>
    <h2>${t('rep.byStore')}</h2>
    <table class="table"><thead><tr><th>${t('col.store')}</th><th class="num">${t('rep.receipts')}</th><th class="num">${t('col.total')}</th></tr></thead><tbody>
    ${R.byStore.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${s.count}</td><td class="num">${fmtMoney(s.totalMinor, cur)}</td></tr>`).join('')}</tbody></table>`;
}

// ---------- stores ----------
function storesHtml() {
  const e = S.storeEdit;
  const rows = S.stores.length ? `<table class="table"><thead><tr><th>${t('stores.name')}</th><th>${t('stores.location')}</th><th></th></tr></thead><tbody>
    ${S.stores.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.location || '')}</td><td class="num"><button class="btn small" data-action="storeEdit" data-id="${esc(s.id)}">${t('common.edit')}</button>
    <button class="btn small danger" data-action="storeDelete" data-id="${esc(s.id)}">${t('common.delete')}</button></td></tr>`).join('')}</tbody></table>`
    : `<p class="empty">${t('stores.empty')}</p>`;
  return `<header class="head"><h1>${t('stores.title')}</h1></header><p class="muted">${t('stores.intro')}</p>
    <div class="form card"><h2>${e ? t('stores.editTitle') : t('stores.add')}</h2><div class="grid2">
    <label class="field"><span>${t('stores.name')}</span><input id="stName" type="text" value="${esc(e ? e.name : '')}"></label>
    <label class="field"><span>${t('stores.location')}</span><input id="stLoc" type="text" value="${esc(e ? e.location : '')}"></label></div>
    <div class="row"><button class="btn primary" data-action="storeSave">${t('common.save')}</button>
    ${e ? `<button class="btn" data-action="storeCancel">${t('common.cancel')}</button>` : ''}</div></div>${rows}`;
}

// ---------- settings ----------
function settingsHtml() {
  return `<header class="head"><h1>${t('settings.title')}</h1></header>
    <section class="card"><h2>${t('settings.folder')}</h2><p class="path mono">${esc(S.folder)}</p><p class="muted">${t('settings.folderHelp')}</p>
    <div class="row"><button class="btn primary" data-action="chooseFolder">${t('settings.change')}</button>
    <button class="btn" data-action="openFolder">${t('settings.open')}</button>
    <button class="btn" data-action="import">${t('list.import')}</button></div></section>
    <section class="card"><h2>${t('settings.language')}</h2>${langSelect()}</section>`;
}

// ---------- events ----------
const actions = {
  nav: (d) => { S.editing = null; S.storeEdit = null; go(d.view); },
  new: () => { S.editing = null; go('form'); },
  open: (d) => { S.selectedId = d.id; go('detail'); },
  edit: (d) => { S.editing = S.receipts.find((r) => r.id === d.id) || null; go('form'); },
  cancelForm: () => { const back = S.editing ? 'detail' : 'list'; if (S.editing) S.selectedId = S.editing.id; S.editing = null; go(back); },
  saveForm,
  addRow: () => { $('#items tbody').insertAdjacentHTML('beforeend', itemRowHtml({ name: '', quantity: 1, unitPriceMinor: 0 })); $$('#items .i-name').pop().focus(); updateTotals(); },
  removeRow: (_d, el) => { if ($$('#items .item-row').length > 1) el.closest('tr').remove(); else el.closest('tr').querySelectorAll('input').forEach((i) => { i.value = ''; }); updateTotals(); },
  delete: async (d) => {
    if (!confirm(t('detail.confirmDelete', { id: d.id }))) return;
    const res = await api.deleteReceipt(d.id);
    if (res.error) return toast(res.error, true);
    await reload(); go('list'); toast(t('toast.deleted', { id: d.id }));
  },
  import: async () => {
    const res = await api.importReceipts();
    if (res.canceled) return;
    await reload(); render(); toast(t('toast.import', res));
  },
  chooseFolder: async () => {
    const res = await api.chooseFolder();
    if (res.canceled) return;
    if (res.error) return toast(t('err.folder'), true);
    applyState(res.state); await reload();
    if (S.view === 'form') S.view = 'list';
    render();
  },
  openFolder: () => api.openFolder(),
  exportCsv: async () => {
    const R = currentReport(); const p = S.report.period;
    const text = reportToCsv(R.rows, (k) => periodLabel(k, p), R.currency, digits(R.currency), getLang(),
      [t('csv.period'), t('csv.receipts'), t('csv.tax'), t('csv.total'), t('csv.currency')]);
    const res = await api.exportCsv(text, t('rep.csvName', { period: p }));
    if (res.ok) toast(t('toast.csv'));
  },
  storeSave: async () => {
    const name = $('#stName').value.trim();
    if (!name) return toast(t('err.store'), true);
    S.stores = await api.upsertStore({ id: S.storeEdit ? S.storeEdit.id : undefined, name, location: $('#stLoc').value.trim() });
    S.storeEdit = null; render();
  },
  storeEdit: (d) => { S.storeEdit = S.stores.find((s) => s.id === d.id) || null; render(); },
  storeCancel: () => { S.storeEdit = null; render(); },
  storeDelete: async (d) => {
    const s = S.stores.find((x) => x.id === d.id);
    if (!s || !confirm(t('stores.confirmDelete', { name: s.name }))) return;
    S.stores = await api.deleteStore(d.id); S.storeEdit = null; render();
  },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) await fn(el.dataset, el);
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset && el.dataset.filter) {
    S.filters[el.dataset.filter] = el.value;
    $('#listBody').innerHTML = listBodyHtml();
  }
  if (el.closest && el.closest('#receiptForm')) updateTotals();
});
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.id === 'langSel') { applyState(await api.setLanguage(el.value)); render(); }
  else if (el.id === 'storeSel') { $('#newStore').hidden = el.value !== '__new__'; }
  else if (el.dataset && el.dataset.rep) { S.report[el.dataset.rep] = el.value; render(); }
});

init();
