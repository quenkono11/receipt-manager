import { t, tp, setLang, getLang, locale } from './i18n.js';
import { esc, fmtMoney, fmtDate, fmtDateTime, parseMoney, parseQty, parsePercent, pctToInput, fmtPct, minorToInput, nowLocal, todayISO, digits, receiptTotals, itemLine } from './format.js';
import { buildReport, receiptsToCsv, periodRange, shiftAnchor, periodKey, isoWeekStart } from './reports.js';

const api = window.api;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  folder: null, folderOk: true, version: '', theme: 'system', checkUpdates: true, updateRepo: false, update: null,
  receipts: [], problems: [], stores: [], categories: [],
  view: 'list', backView: 'list', selectedKey: null, editing: null, storeEdit: null, catEdit: null,
  filters: { q: '', from: '', to: '', store: '' },
  report: { period: 'month', anchor: todayISO(), currency: '' },
};

// ---------- state ----------
function applyState(st) {
  S.folder = st.folder; S.folderOk = st.folderOk; S.version = st.version || '';
  S.theme = st.theme || 'system'; S.checkUpdates = st.checkUpdates !== false; S.updateRepo = !!st.updateRepo; S.update = st.update || null;
  setLang(st.language);
  document.title = t('app.title');
}
async function reload() {
  if (!S.folder) { S.receipts = []; S.stores = []; S.categories = []; S.problems = []; return; }
  const r = await api.listReceipts();
  S.receipts = r.receipts || []; S.problems = r.problems || []; S.folderOk = !r.error;
  if (r.migrated) toast(tp('toast.migrated', r.migrated));
  S.stores = await api.listStores();
  S.categories = await api.listCategories();
}
async function init() {
  // Registered first, so an answer that arrives while the app is still loading is not missed.
  api.onUpdateInfo((info) => { S.update = info || null; refreshUpdateNote(); });
  applyState(await api.getState());
  await reload();
  render();
  // Files copied into the folder (or changed elsewhere) show up automatically.
  api.onDataChanged(async () => {
    await reload();
    if (S.view === 'detail' && !S.receipts.some((r) => r.key === S.selectedKey)) S.view = S.backView;
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

// "Version x.y.z is available" next to the version number (sidebar and settings); opens the release page.
const updateNoteHtml = () => (S.update
  ? `<button type="button" class="link-btn" data-action="openRelease">${esc(t('update.available', { version: S.update.version }))}</button>` : '');
const refreshUpdateNote = () => $$('[data-update-slot]').forEach((el) => { el.innerHTML = updateNoteHtml(); });
const langSelect = () => `<label class="field inline"><span>${t('settings.language')}</span>
  <select id="langSel"><option value="en"${getLang() === 'en' ? ' selected' : ''}>English</option>
  <option value="de"${getLang() === 'de' ? ' selected' : ''}>Deutsch</option></select></label>`;

// ---------- layout ----------
function render() {
  const app = $('#app');
  if (!S.folder) { app.innerHTML = setupHtml(); return; }
  const active = S.view === 'detail' ? S.backView : S.view === 'form' ? (S.editing ? 'list' : 'new') : S.view;
  const nav = [['list', 'nav.list'], ['new', 'nav.new'], ['report', 'nav.report'], ['stores', 'nav.stores'], ['categories', 'nav.categories'], ['settings', 'nav.settings']]
    .map(([v, k]) => `<button class="nav-item${active === v ? ' active' : ''}" data-action="nav" data-view="${v}">${t(k)}</button>`).join('');
  const banner = S.folderOk ? '' : `<div class="banner error">${t('banner.folderMissing')}
    <button class="btn" data-action="chooseFolder">${t('banner.chooseFolder')}</button></div>`;
  app.innerHTML = `<div class="shell"><aside class="side"><div class="brand">${t('app.title')}</div><nav>${nav}</nav>${S.version ? `<div class="side-foot muted"><div>${t('side.version', { version: S.version })}</div><div data-update-slot>${updateNoteHtml()}</div></div>` : ''}</aside>
    <main class="main">${banner}${viewHtml()}</main></div>`;
  if (S.view === 'form') initForm();
}
function viewHtml() {
  switch (S.view) {
    case 'detail': return detailHtml();
    case 'form': return formHtml();
    case 'report': return reportHtml();
    case 'stores': return storesHtml();
    case 'categories': return categoriesHtml();
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
    const hay = [r.id, r.store && r.store.name, r.store && r.store.location, r.notes, ...r.items.map((i) => i.name), ...r.items.map((i) => i.category)].join(' ').toLowerCase();
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
    ${rows.map((r) => `<tr data-action="open" data-key="${esc(r.key)}"><td>${fmtDate(r.purchasedAt)}</td><td class="mono">${esc(r.id)}</td>
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
function slipSummaryHtml(r, tot, cur) {
  const row = (label, value, cls = '') => `<tr class="${cls}"><td>${label}</td><td class="num">${value}</td></tr>`;
  const rows = [row(t('detail.subtotal'), fmtMoney(tot.subtotal, cur))];
  if (tot.itemDiscount) rows.push(row(t('form.itemDiscounts'), '−' + fmtMoney(tot.itemDiscount, cur)));
  if (tot.receiptDiscount) rows.push(row(t('form.receiptDiscountLine', { pct: fmtPct(r.discountPct) }), '−' + fmtMoney(tot.receiptDiscount, cur)));
  const taxRows = tot.taxByRate.filter((g) => g.rate > 0 || g.tax)
    .map((g) => row(t(r.taxIncluded ? 'form.taxInclLine' : 'form.taxLine', { rate: fmtPct(g.rate) }), fmtMoney(g.tax, cur), r.taxIncluded ? 'incl' : ''));
  if (tot.legacyTax) taxRows.push(row(t('form.taxFixedLine'), fmtMoney(tot.legacyTax, cur), r.taxIncluded ? 'incl' : ''));
  if (!r.taxIncluded) rows.push(...taxRows);
  rows.push(row(t('detail.total'), fmtMoney(tot.total, cur), 'grand'));
  if (r.taxIncluded) rows.push(...taxRows);
  return rows.join('');
}
function detailHtml() {
  const r = S.receipts.find((x) => x.key === S.selectedKey);
  if (!r) return listHtml();
  const tot = receiptTotals(r); const cur = r.currency;
  const items = r.items.length ? r.items.map((i) => {
    const { afterItem } = itemLine(i);
    const tags = [];
    if (i.category) tags.push(i.category);
    if (i.quantity !== 1) tags.push(`${i.quantity} × ${fmtMoney(i.unitPriceMinor, cur)}`);
    if (i.discountPct) tags.push(t('detail.discount', { pct: fmtPct(i.discountPct) }));
    if (i.taxRatePct !== null && i.taxRatePct !== undefined) tags.push(t('detail.rateTag', { rate: fmtPct(i.taxRatePct) }));
    return `<tr><td>${esc(i.name)}${tags.length ? `<div class="muted">${esc(tags.join(' · '))}</div>` : ''}</td>
    <td class="num">${fmtMoney(afterItem, cur)}</td></tr>`;
  }).join('') : `<tr><td class="muted">${t('detail.noItems')}</td><td></td></tr>`;
  return `<header class="head"><div class="row"><button class="btn" data-action="nav" data-view="${S.backView}">${t('common.back')}</button></div>
    <div class="row"><button class="btn" data-action="edit" data-key="${esc(r.key)}">${t('common.edit')}</button>
    <button class="btn danger" data-action="delete" data-key="${esc(r.key)}">${t('common.delete')}</button></div></header>
    <article class="slip"><div class="slip-head"><div class="slip-store">${esc(r.store.name)}</div>
    ${r.store.location ? `<div>${esc(r.store.location)}</div>` : ''}<div class="slip-meta">${fmtDateTime(r.purchasedAt)}</div>
    <div class="slip-meta mono">${esc(r.id)}</div></div>
    <table class="slip-items"><tbody>${items}</tbody></table>
    <table class="slip-sum"><tbody>${slipSummaryHtml(r, tot, cur)}</tbody></table>
    ${r.notes ? `<div class="slip-notes"><strong>${t('detail.notes')}</strong><br>${esc(r.notes).replace(/\n/g, '<br>')}</div>` : ''}</article>`;
}

// ---------- receipt form ----------
const TAX_RATES = [0, 7, 19];
const lastRate = () => { const v = localStorage.getItem('lastTaxRate'); return v === null ? 19 : Number(v); };
const emptyItem = (rate, category = '') => ({ name: '', category, quantity: 1, unitPriceMinor: 0, discountPct: 0, taxRatePct: rate });

function itemRowHtml(item, cur) {
  const dec = locale().startsWith('de') ? ',' : '.';
  const cat = item.category || '';
  const catOpts = S.categories.map((c) => `<option value="${esc(c.name)}"${c.name === cat ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  const newSelected = cat && !S.categories.some((c) => c.name === cat);
  return `<tr class="item-row"><td><input class="i-name" type="text" value="${esc(item.name)}" aria-label="${t('form.itemName')}"></td>
    <td class="i-cat-cell"><select class="i-cat" autocomplete="off" aria-label="${t('form.category')}">
      <option value="">${t('form.chooseCategory')}</option>${catOpts}
      <option value="__new__"${newSelected ? ' selected' : ''}>${t('form.newCategory')}</option></select>
    <div class="i-cat-newblk"${newSelected ? '' : ' hidden'}>
      <input class="i-cat-new" type="text" autocomplete="off" value="${esc(cat)}" aria-label="${t('form.category')}">
      <label class="check"><input type="checkbox" checked> ${t('form.saveCategory')}</label>
    </div></td>
    <td><input class="i-qty num" type="text" inputmode="decimal" value="${esc(String(item.quantity ?? 1).replace('.', dec))}" aria-label="${t('form.qty')}"></td>
    <td><input class="i-price num" type="text" inputmode="decimal" value="${item.unitPriceMinor ? esc(minorToInput(item.unitPriceMinor, cur)) : ''}" aria-label="${t('form.unitPrice')}"></td>
    <td><input class="i-disc num" type="text" inputmode="decimal" value="${item.discountPct ? esc(pctToInput(item.discountPct)) : ''}" placeholder="0" aria-label="${t('form.discount')}"></td>
    <td><input class="i-tax num" type="text" inputmode="decimal" autocomplete="off" value="${esc(pctToInput(item.taxRatePct))}" aria-label="${t('form.taxRate')}"></td>
    <td class="num i-line"></td>
    <td><button class="icon-btn" data-action="removeRow" title="${t('form.removeItem')}" aria-label="${t('form.removeItem')}">×</button></td></tr>`;
}
function formHtml() {
  const r = S.editing;
  const cur = r ? r.currency : (localStorage.getItem('lastCurrency') || 'EUR');
  const match = r && S.stores.find((s) => s.name === r.store.name && (s.location || '') === (r.store.location || ''));
  const selNew = (r && !match) || (!r && !S.stores.length);
  const storeOpts = S.stores.map((s) => `<option value="${esc(s.id)}"${match && match.id === s.id ? ' selected' : ''}>${esc(s.name)}${s.location ? ' — ' + esc(s.location) : ''}</option>`).join('');
  const items = r && r.items.length ? r.items : [emptyItem(lastRate())];
  const legacy = r && r.legacyTaxMinor ? `<div class="legacy"><label class="field narrow"><span>${t('form.legacyTax')}</span>
    <input id="legacyTax" type="text" inputmode="decimal" class="num" value="${esc(minorToInput(r.legacyTaxMinor, cur))}"></label>
    <p class="muted">${t('form.legacyTaxHelp')}</p></div>` : '';
  return `<header class="head"><h1>${r ? t('form.titleEdit', { id: r.id }) : t('form.titleNew')}</h1>
    <div class="row"><button class="btn" data-action="cancelForm">${t('common.cancel')}</button>
    <button class="btn primary" data-action="saveForm">${t('form.save')}</button></div></header>
    <p class="muted">${t('form.idNote')}</p>
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
      <div id="comboMenu" class="combo-menu" hidden></div>
      <h2>${t('form.items')}</h2>
      <table id="items" class="table items"><thead><tr><th>${t('form.itemName')}</th><th>${t('form.category')}</th><th class="num">${t('form.qty')}</th>
        <th class="num">${t('form.unitPrice')}</th><th class="num">${t('form.discount')}</th><th class="num">${t('form.taxRate')}</th>
        <th class="num">${t('form.lineTotal')}</th><th></th></tr></thead>
        <tbody>${items.map((i) => itemRowHtml(i, cur)).join('')}</tbody></table>
      <button class="btn" data-action="addRow">${t('form.addItem')}</button>
      <div class="grid2 tax-row"><label class="field narrow"><span>${t('form.receiptDiscount')}</span><input id="discPct" type="text" inputmode="decimal" class="num" placeholder="0" value="${r && r.discountPct ? esc(pctToInput(r.discountPct)) : ''}"></label>
        <label class="check"><input id="taxIncl" type="checkbox"${!r || r.taxIncluded ? ' checked' : ''}> ${t('form.taxIncluded')}</label></div>
      ${legacy}
      <dl class="sums" id="sums"></dl>
      <label class="field"><span>${t('form.notes')}</span><textarea id="notes" rows="3">${esc(r ? r.notes : '')}</textarea></label>
    </div>`;
}
function initForm() { updateTotals(); }

// Reads the form. `error` is the translation key of the first problem (used when saving);
// for the live preview invalid fields simply count as empty.
function readForm() {
  const cur = $('#cur').value.trim().toUpperCase();
  const parseCur = /^[A-Z]{3}$/.test(cur) ? cur : 'EUR';
  let error = null;
  const items = [];
  for (const row of $$('#items .item-row')) {
    const name = $('.i-name', row).value.trim();
    const priceStr = $('.i-price', row).value.trim();
    if (!name && !priceStr) continue;
    const price = priceStr ? parseMoney(priceStr, parseCur) : 0;
    const qty = parseQty($('.i-qty', row).value.trim() || '1');
    const disc = parsePercent($('.i-disc', row).value);
    const rate = parsePercent($('.i-tax', row).value);
    if (price === null) error = error || 'err.price';
    if (!(qty > 0)) error = error || 'err.qty';
    if (Number.isNaN(disc) || Number.isNaN(rate)) error = error || 'err.percent';
    const catSel = $('.i-cat', row);
    let category = catSel.value === '__new__' ? ($('.i-cat-new', row).value.trim()) : catSel.value;
    const catSave = catSel.value === '__new__' ? $('.i-cat-newblk .check input', row).checked : false;
    items.push({
      name, category: canonicalCategory(category), quantity: qty > 0 ? qty : 0, unitPriceMinor: price === null ? 0 : price,
      discountPct: Number.isNaN(disc) || disc === null ? 0 : disc,
      taxRatePct: Number.isNaN(rate) ? null : rate,
      _newCategory: catSave ? canonicalCategory(category) : null,
    });
  }
  const discPct = parsePercent($('#discPct').value);
  if (Number.isNaN(discPct)) error = error || 'err.percent';
  let legacy = 0;
  if ($('#legacyTax')) {
    const l = $('#legacyTax').value.trim() ? parseMoney($('#legacyTax').value, parseCur) : 0;
    if (l === null) error = error || 'err.price'; else legacy = l;
  }
  return {
    cur, parseCur, error,
    draft: { items, discountPct: Number.isNaN(discPct) || discPct === null ? 0 : discPct, taxIncluded: $('#taxIncl').checked, legacyTaxMinor: legacy },
  };
}
function updateTotals() {
  if (!$('#receiptForm')) return;
  const { cur, parseCur, draft } = readForm();
  const valid = /^[A-Z]{3}$/.test(cur);
  const money = (m) => (valid ? fmtMoney(m, cur) : (m / 10 ** digits(parseCur)).toFixed(digits(parseCur)));
  $$('#items .item-row').forEach((row) => {
    const priceStr = $('.i-price', row).value.trim();
    const q = parseQty($('.i-qty', row).value.trim() || '1');
    const p = priceStr ? parseMoney(priceStr, parseCur) : null;
    const d = parsePercent($('.i-disc', row).value);
    $('.i-line', row).textContent = priceStr && p !== null && q > 0
      ? money(itemLine({ quantity: q, unitPriceMinor: p, discountPct: Number.isNaN(d) ? 0 : d }).afterItem) : '';
  });
  const tot = receiptTotals(draft);
  const line = (label, value, cls = '') => `<dt class="${cls}">${label}</dt><dd class="${cls}">${value}</dd>`;
  const out = [line(t('form.subtotal'), money(tot.subtotal))];
  if (tot.itemDiscount) out.push(line(t('form.itemDiscounts'), '−' + money(tot.itemDiscount)));
  if (tot.receiptDiscount) out.push(line(t('form.receiptDiscountLine', { pct: fmtPct(draft.discountPct) }), '−' + money(tot.receiptDiscount)));
  const taxLines = tot.taxByRate.filter((g) => g.rate > 0 || g.tax)
    .map((g) => line(t(draft.taxIncluded ? 'form.taxInclLine' : 'form.taxLine', { rate: fmtPct(g.rate) }), money(g.tax)));
  if (tot.legacyTax) taxLines.push(line(t('form.taxFixedLine'), money(tot.legacyTax)));
  if (!draft.taxIncluded) out.push(...taxLines);
  out.push(line(t('form.total'), money(tot.total), 'grand'));
  if (draft.taxIncluded) out.push(...taxLines);
  $('#sums').innerHTML = out.join('');
}
async function saveForm() {
  const { cur, error, draft } = readForm();
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

  if (error) return toast(t(error), true);
  if (!draft.items.length) return toast(t('err.noItems'), true);

  // A new category typed in an item row must have a name before the receipt is saved.
  const newCats = [...new Set((draft.items.map((i) => i._newCategory).filter(Boolean)))];
  for (const c of newCats) if (!c) return toast(t('err.category'), true);

  const res = await api.saveReceipt({ store, purchasedAt: dt, currency: cur, notes: $('#notes').value, ...draft },
    S.editing ? S.editing.key : null);
  if (res.error) return toast(t('err.save', { message: res.error }), true);
  if (newStore) await api.upsertStore(newStore);
  for (const c of newCats) await api.upsertCategory({ name: c });
  localStorage.setItem('lastCurrency', cur);
  const lastTax = [...draft.items].reverse().find((i) => i.taxRatePct !== null);
  if (lastTax) localStorage.setItem('lastTaxRate', String(lastTax.taxRatePct));
  await reload();
  S.selectedKey = res.receipt.key; S.editing = null;
  go('detail');
  toast(t('toast.saved', { id: res.receipt.id }));
}

// ---------- overview ----------
// The overview shows ONE chosen period: pick Day / Week / Month / Quarter / Year, then the specific one.
const PERIODS = ['day', 'week', 'month', 'quarter', 'year'];
const DRILL = { week: 'day', month: 'day', quarter: 'month', year: 'month' };   // clicking a bar opens that day or month
const dateOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };

function periodTitle(period, range) {
  const [y, m] = range.from.split('-').map(Number);
  switch (period) {
    case 'day': return new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(dateOf(range.from));
    case 'week': { const [wy, w] = periodKey(range.from, 'week').split('-W'); return t('rep.weekLabel', { w: Number(w), y: wy }); }
    case 'month': return new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
    case 'quarter': return `Q${Math.ceil(m / 3)} ${y}`;
    default: return String(y);
  }
}
const bucketLabel = (period, b) => (period === 'week'
  ? new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(dateOf(b.key))
  : period === 'month' ? String(Number(b.key.slice(8)))
    : new Intl.DateTimeFormat(locale(), { month: 'short' }).format(dateOf(b.from)));
const bucketTitle = (period, b) => (period === 'week' || period === 'month'
  ? fmtDate(b.key) : new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' }).format(dateOf(b.from)));
const fmtChange = (x) => new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 0, signDisplay: 'exceptZero' }).format(x);

function yearSelect(field, y) {
  const now = new Date().getFullYear();
  const years = S.receipts.map((r) => Number(r.purchasedAt.slice(0, 4)));
  const lo = Math.min(y, now, ...years); const hi = Math.max(y, now, ...years);
  let opts = '';
  for (let v = lo; v <= hi; v++) opts += `<option${v === y ? ' selected' : ''}>${v}</option>`;
  return `<select data-rep="${field}" aria-label="${t('rep.year')}">${opts}</select>`;
}
function pickerHtml(period, range) {
  const [y, m] = range.from.split('-').map(Number);
  switch (period) {
    case 'day': return `<input type="date" data-rep="anchor" value="${range.from}">`;
    case 'week': return `<input type="week" data-rep="week" value="${periodKey(range.from, 'week')}">`;
    case 'month': return `<input type="month" data-rep="month" value="${range.from.slice(0, 7)}">`;
    case 'quarter': return `<select data-rep="quarter" aria-label="${t('rep.quarter')}">${[1, 2, 3, 4].map((q) =>
      `<option value="${q}"${q === Math.ceil(m / 3) ? ' selected' : ''}>Q${q}</option>`).join('')}</select>${yearSelect('qyear', y)}`;
    default: return yearSelect('year', y);
  }
}
// A control of the overview changed: turn its value into a date inside the chosen period.
function setReport(field, v) {
  const R = S.report;
  const [y, m] = periodRange(R.period, R.anchor).from.split('-').map(Number);
  const p2 = (n) => String(n).padStart(2, '0');
  if (field === 'currency') R.currency = v;
  else if (field === 'anchor') { if (v) R.anchor = v; }
  else if (field === 'week') { const mm = /^(\d{4})-W(\d{2})$/.exec(v); if (mm) R.anchor = isoWeekStart(Number(mm[1]), Number(mm[2])); }
  else if (field === 'month') { if (/^\d{4}-\d{2}$/.test(v)) R.anchor = `${v}-01`; }
  else if (field === 'quarter') R.anchor = `${y}-${p2((Number(v) - 1) * 3 + 1)}-01`;
  else if (field === 'qyear') R.anchor = `${v}-${p2(m)}-01`;
  else if (field === 'year') R.anchor = `${v}-01-01`;
  render();
}

function reportHtml() {
  const R = buildReport(S.receipts, S.report); const p = S.report.period; const cur = R.currency;
  const seg = PERIODS.map((x) => `<button type="button" class="seg-btn${x === p ? ' on' : ''}" data-action="repPeriod" data-period="${x}" aria-pressed="${x === p}">${t('rep.' + x)}</button>`).join('');
  const sub = p === 'week' || p === 'quarter' ? ` <span class="muted">${esc(fmtDate(R.range.from))} – ${esc(fmtDate(R.range.to))}</span>` : '';
  const controls = `<div class="period-bar"><div class="seg" role="group">${seg}</div>
    <div class="row"><button class="btn" data-action="repPrev" title="${t('rep.prev')}" aria-label="${t('rep.prev')}">◀</button>${pickerHtml(p, R.range)}
    <button class="btn" data-action="repNext" title="${t('rep.next')}" aria-label="${t('rep.next')}">▶</button>
    <button class="btn" data-action="repToday">${t('rep.today.' + p)}</button></div>
    ${R.currencies.length ? `<label class="field inline"><span>${t('rep.currency')}</span><select data-rep="currency">${R.currencies.map((c) => `<option${c.code === cur ? ' selected' : ''}>${esc(c.code)}</option>`).join('')}</select></label>` : ''}</div>
    <h2 class="period-title">${esc(periodTitle(p, R.range))}${sub}</h2>`;
  const head = `<header class="head"><h1>${t('rep.title')}</h1><div class="row">${R.receipts.length ? `<button class="btn" data-action="exportCsv">${t('rep.export')}</button>` : ''}</div></header>`;
  if (!R.receipts.length) return `${head}${controls}<p class="empty">${t('rep.noData')}</p>`;

  const stat = (label, value, extra = '') => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${extra}</div>`;
  const vsPrev = R.previous.totalMinor > 0
    ? `<div class="stat-sub muted">${esc(t('rep.vsPrev', { change: fmtChange((R.totals.totalMinor - R.previous.totalMinor) / R.previous.totalMinor), period: periodTitle(p, R.previous.range) }))}</div>` : '';
  const share = (v, whole) => (whole > 0 ? `${Math.round((v / whole) * 100)} %` : '');

  let chart = '';
  if (R.buckets.length) {
    const max = Math.max(...R.buckets.map((b) => b.totalMinor), 1);
    chart = `<h2>${t(p === 'quarter' || p === 'year' ? 'rep.byMonth' : 'rep.byDay')}</h2><div class="cols" style="--n:${R.buckets.length}">${R.buckets.map((b) => {
      const tip = `${bucketTitle(p, b)}: ${fmtMoney(b.totalMinor, cur)}${b.count ? ` · ${tp('list.count', b.count)}` : ''}`;
      return `<button type="button" class="col" data-action="repDrill" data-period="${DRILL[p]}" data-anchor="${b.from}" title="${esc(tip)}">
        <span class="col-area"><span class="col-bar${b.totalMinor > 0 ? '' : ' zero'}" style="height:${Math.max(0, (b.totalMinor / max) * 100).toFixed(1)}%"></span></span>
        <span class="col-label">${esc(bucketLabel(p, b))}</span></button>`;
    }).join('')}</div>`;
  }

  const catSum = R.byCategory.reduce((s, c) => s + c.totalMinor, 0);
  const byCategory = R.byCategory.length ? `<h2>${t('rep.byCategory')}</h2>
    <table class="table"><thead><tr><th>${t('form.category')}</th><th class="num">${t('rep.share')}</th><th class="num">${t('col.total')}</th></tr></thead><tbody>
    ${R.byCategory.map((c) => `<tr><td>${c.name ? esc(c.name) : `<span class="muted">${t('rep.uncategorized')}</span>`}</td><td class="num">${share(c.totalMinor, catSum)}</td><td class="num">${fmtMoney(c.totalMinor, cur)}</td></tr>`).join('')}</tbody></table>
    <p class="muted foot">${t('rep.categoryNote')}</p>` : '';

  return `${head}${controls}
    <div class="stats">${stat(t('rep.spent'), fmtMoney(R.totals.totalMinor, cur), vsPrev)}${stat(t('rep.tax'), fmtMoney(R.totals.taxMinor, cur))}
    ${stat(t('rep.receipts'), R.totals.count)}${stat(t('rep.average'), fmtMoney(R.average, cur))}</div>
    ${R.currencies.length > 1 ? `<p class="muted">${t('rep.otherCurrencies')}</p>` : ''}
    ${chart}
    <h2>${t('rep.byStore')}</h2>
    <table class="table"><thead><tr><th>${t('col.store')}</th><th class="num">${t('rep.receipts')}</th><th class="num">${t('rep.share')}</th><th class="num">${t('col.total')}</th></tr></thead><tbody>
    ${R.byStore.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${s.count}</td><td class="num">${share(s.totalMinor, R.totals.totalMinor)}</td><td class="num">${fmtMoney(s.totalMinor, cur)}</td></tr>`).join('')}</tbody></table>
    ${byCategory}
    <h2>${t('rep.list')}</h2>
    <table class="table clickable"><thead><tr><th>${t('col.date')}</th><th>${t('col.id')}</th><th>${t('col.store')}</th><th class="num">${t('col.total')}</th></tr></thead><tbody>
    ${R.receipts.map((r) => `<tr data-action="open" data-key="${esc(r.key)}"><td>${fmtDateTime(r.purchasedAt)}</td><td class="mono">${esc(r.id)}</td><td>${storeLabel(r)}</td><td class="num">${fmtMoney(receiptTotals(r).total, cur)}</td></tr>`).join('')}</tbody></table>`;
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

// ---------- categories ----------
function categoriesHtml() {
  const e = S.catEdit;
  const rows = S.categories.length ? `<table class="table"><thead><tr><th>${t('categories.name')}</th><th></th></tr></thead><tbody>
    ${S.categories.map((c) => `<tr><td>${esc(c.name)}</td><td class="num"><button class="btn small" data-action="catEdit" data-id="${esc(c.id)}">${t('common.edit')}</button>
    <button class="btn small danger" data-action="catDelete" data-id="${esc(c.id)}">${t('common.delete')}</button></td></tr>`).join('')}</tbody></table>`
    : `<p class="empty">${t('categories.empty')}</p>`;
  return `<header class="head"><h1>${t('categories.title')}</h1></header><p class="muted">${t('categories.intro')}</p>
    <div class="form card"><h2>${e ? t('categories.editTitle') : t('categories.add')}</h2>
    <label class="field"><span>${t('categories.name')}</span><input id="catName" type="text" value="${esc(e ? e.name : '')}"></label>
    <div class="row"><button class="btn primary" data-action="catSave">${t('common.save')}</button>
    ${e ? `<button class="btn" data-action="catCancel">${t('common.cancel')}</button>` : ''}</div></div>${rows}`;
}

// ---------- settings ----------
function settingsHtml() {
  return `<header class="head"><h1>${t('settings.title')}</h1></header>
    <section class="card"><h2>${t('settings.folder')}</h2><p class="path mono">${esc(S.folder)}</p><p class="muted">${t('settings.folderHelp')}</p>
    <div class="row"><button class="btn primary" data-action="chooseFolder">${t('settings.change')}</button>
    <button class="btn" data-action="openFolder">${t('settings.open')}</button>
    <button class="btn" data-action="import">${t('list.import')}</button></div></section>
    <section class="card"><h2>${t('settings.language')}</h2>${langSelect()}</section>
    <section class="card"><h2>${t('settings.appearance')}</h2><label class="field inline"><span>${t('settings.theme')}</span>
      <select id="themeSel">${['system', 'light', 'dark'].map((v) => `<option value="${v}"${S.theme === v ? ' selected' : ''}>${t('theme.' + v)}</option>`).join('')}</select></label></section>
    ${S.updateRepo ? `<section class="card"><h2>${t('settings.updates')}</h2>
      <label class="check"><input id="updSwitch" type="checkbox"${S.checkUpdates ? ' checked' : ''}> ${t('settings.checkUpdates')}</label>
      <p class="muted">${t('settings.updatesHelp')}</p></section>` : ''}
    <section class="card"><h2>${t('settings.version')}</h2><p><span class="mono">${esc(S.version)}</span> <span data-update-slot>${updateNoteHtml()}</span></p></section>`;
}

// ---------- events ----------
// ---------- categories ----------
// Categories are saved by the user in the Categories menu. The list is the source of truth; the combo
// menu in the receipt form shows these names. Items may still carry a category that was typed before
// it was saved (or on another computer): it is kept as-is and shown in the field.
const categoryOptions = () => S.categories.map((c) => c.name);
// "groceries" typed by hand becomes "Groceries" when that spelling already exists, so categories do not split by case.
const canonicalCategory = (typed) => {
  const c = String(typed || '').trim();
  return categoryOptions().find((x) => x.toLowerCase() === c.toLowerCase()) || c;
};

// ---------- tax-rate and category menus ----------
// The browser's own <datalist> hides every entry that does not match what is already typed (with "19" in the
// field, 0 and 7 disappeared). This small menu shows all entries when a field is focused or clicked, and
// filters the category list only while the user is typing.
const combo = {
  target: null, picking: false,
  entries(input) {
    return TAX_RATES.map((r) => ({ value: pctToInput(r), label: `${fmtPct(r)} %` }));
  },
  open(input, filter = '') {
    const m = $('#comboMenu');
    if (!m) return;
    const all = this.entries(input);
    const typed = filter.trim(); const f = typed.toLowerCase();
    const list = all.filter((e) => !f || e.label.toLowerCase().includes(f));
    const html = list.map((e) => `<button type="button" data-action="pickOption" data-value="${esc(e.value)}">${esc(e.label)}</button>`).join('');
    if (!html) { this.close(); return; }
    this.target = input;
    m.innerHTML = html;
    const b = input.getBoundingClientRect();
    m.style.left = `${b.left}px`; m.style.top = `${b.bottom + 2}px`; m.style.minWidth = `${b.width}px`;
    m.hidden = false;
  },
  close() { const m = $('#comboMenu'); if (m) m.hidden = true; this.target = null; },
};
const isCombo = (el) => !!(el && el.classList && el.classList.contains('i-tax'));

const actions = {
  // 'new' is not a view of its own: the sidebar entry opens an empty form (this was broken in 1.0).
  nav: (d) => { S.editing = null; S.storeEdit = null; S.catEdit = null; go(d.view === 'new' ? 'form' : d.view); },
  new: () => { S.editing = null; go('form'); },
  open: (d) => { S.backView = S.view === 'report' ? 'report' : 'list'; S.selectedKey = d.key; go('detail'); },
  edit: (d) => { S.editing = S.receipts.find((r) => r.key === d.key) || null; go('form'); },
  cancelForm: () => { const back = S.editing ? 'detail' : 'list'; if (S.editing) S.selectedKey = S.editing.key; S.editing = null; go(back); },
  saveForm,
  addRow: () => {
    // A new row starts with the tax rate and category of the row above.
    const prev = $$('#items .i-tax').pop();
    const prevCat = $$('#items .i-cat').pop();
    const rate = prev ? parsePercent(prev.value) : lastRate();
    $('#items tbody').insertAdjacentHTML('beforeend', itemRowHtml(emptyItem(Number.isNaN(rate) ? null : rate, prevCat ? prevCat.value : ''), $('#cur').value.trim().toUpperCase() || 'EUR'));
    $$('#items .i-name').pop().focus(); updateTotals();
  },
  pickOption: (d) => {
    const input = combo.target;
    if (!input) return;
    input.value = d.value;
    combo.close();
    combo.picking = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));   // updates the totals
    combo.picking = false;
  },
  removeRow: (_d, el) => { if ($$('#items .item-row').length > 1) el.closest('tr').remove(); else el.closest('tr').querySelectorAll('input').forEach((i) => { i.value = ''; }); updateTotals(); },
  delete: async (d) => {
    const r = S.receipts.find((x) => x.key === d.key);
    if (!r || !confirm(t('detail.confirmDelete', { id: r.id }))) return;
    const res = await api.deleteReceipt(d.key);
    if (res.error) return toast(res.error, true);
    await reload(); go(S.backView); toast(t('toast.deleted', { id: r.id }));
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
    const R = buildReport(S.receipts, S.report);
    const text = receiptsToCsv(R.receipts, R.currency, digits(R.currency), getLang(),
      [t('csv.id'), t('csv.date'), t('csv.store'), t('csv.location'), t('csv.tax'), t('csv.total'), t('csv.currency')]);
    const res = await api.exportCsv(text, t('rep.csvName', { key: R.key }));
    if (res.ok) toast(t('toast.csv'));
  },
  repPeriod: (d) => { S.report.period = d.period; render(); },
  repPrev: () => { S.report.anchor = shiftAnchor(S.report.period, S.report.anchor, -1); render(); },
  repNext: () => { S.report.anchor = shiftAnchor(S.report.period, S.report.anchor, 1); render(); },
  repToday: () => { S.report.anchor = todayISO(); render(); },
  repDrill: (d) => { S.report.period = d.period; S.report.anchor = d.anchor; render(); },
  openRelease: () => api.openRelease(),
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
  catSave: async () => {
    const name = $('#catName').value.trim();
    if (!name) return toast(t('err.category'), true);
    S.categories = await api.upsertCategory({ id: S.catEdit ? S.catEdit.id : undefined, name });
    S.catEdit = null; render();
  },
  catEdit: (d) => { S.catEdit = S.categories.find((c) => c.id === d.id) || null; render(); },
  catCancel: () => { S.catEdit = null; render(); },
  catDelete: async (d) => {
    const c = S.categories.find((x) => x.id === d.id);
    if (!c || !confirm(t('categories.confirmDelete', { name: c.name }))) return;
    S.categories = await api.deleteCategory(d.id); S.catEdit = null; render();
  },
};

document.addEventListener('click', async (e) => {
  if (isCombo(e.target)) combo.open(e.target);
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
  // Typing in a tax rate hides the menu (a click shows it again).
  if (isCombo(el) && !combo.picking) combo.close();
  // Choosing "+ New category…" shows the free-text field next to the select.
  if (el.classList && el.classList.contains('i-cat')) {
    const row = el.closest('.item-row');
    const blk = row && row.querySelector('.i-cat-newblk');
    if (blk) blk.hidden = el.value !== '__new__';
  }
  if (el.closest && el.closest('#receiptForm')) updateTotals();
});
document.addEventListener('focusin', (e) => {
  if (e.target.classList && e.target.classList.contains('i-disc')) e.target.select();
  if (isCombo(e.target)) { e.target.select(); combo.open(e.target); }
});
document.addEventListener('focusout', (e) => { if (isCombo(e.target)) combo.close(); });
// Pressing a menu entry must not take the focus away from the field, or the menu would close before the click.
document.addEventListener('mousedown', (e) => { if (e.target.closest && e.target.closest('#comboMenu')) e.preventDefault(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') combo.close(); });
// The page scrolling moves the field away from the menu, so the menu closes. Scrolling inside the menu itself must not.
window.addEventListener('scroll', (e) => { if (e.target && e.target.closest && e.target.closest('#comboMenu')) return; combo.close(); }, true);
window.addEventListener('resize', () => combo.close());
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.id === 'langSel') { applyState(await api.setLanguage(el.value)); render(); }
  else if (el.id === 'themeSel') applyState(await api.setTheme(el.value));
  else if (el.id === 'updSwitch') { applyState(await api.setCheckUpdates(el.checked)); refreshUpdateNote(); }
  else if (el.id === 'storeSel') { $('#newStore').hidden = el.value !== '__new__'; }
  else if (el.classList && el.classList.contains('i-cat')) {
    const row = el.closest('.item-row'); const blk = row && row.querySelector('.i-cat-newblk');
    if (blk) blk.hidden = el.value !== '__new__';
  }
  else if (el.dataset && el.dataset.rep) setReport(el.dataset.rep, el.value);
});

init();
