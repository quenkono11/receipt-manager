import { locale } from './i18n.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pad = (n) => String(n).padStart(2, '0');

export function nowLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const todayISO = () => nowLocal().slice(0, 10);

function parts(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s || '');
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0) };
}
export function fmtDate(s) {
  const p = parts(s);
  if (!p) return String(s || '');
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium' }).format(new Date(p.y, p.mo - 1, p.d));
}
export function fmtDateTime(s) {
  const p = parts(s);
  if (!p) return String(s || '');
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(p.y, p.mo - 1, p.d, p.h, p.mi));
}

// Number of minor units per major unit (cents per euro; JPY has none).
export function digits(cur) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits;
  } catch { return 2; }
}
export function fmtMoney(minor, cur) {
  const value = (minor || 0) / 10 ** digits(cur);
  try {
    return new Intl.NumberFormat(locale(), { style: 'currency', currency: cur }).format(value);
  } catch { return `${value.toFixed(2)} ${cur}`; }
}
// Plain number for input fields, in the user's decimal style (12,50 / 12.50).
export function minorToInput(minor, cur) {
  const d = digits(cur);
  return new Intl.NumberFormat(locale(), { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false })
    .format((minor || 0) / 10 ** d);
}

// "12,50", "12.50", "1.234,56", "1,234.56" -> minor units. Returns null if not a number.
export function parseMoney(str, cur) {
  let s = String(str ?? '').replace(/[^\d.,-]/g, '');
  const neg = s.startsWith('-');
  s = s.replace(/-/g, '');
  if (!/\d/.test(s)) return null;
  const d = digits(cur);
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  const last = Math.max(lastComma, lastDot);
  let intPart = s;
  let frac = '';
  if (last >= 0) {
    const sep = s[last];
    const after = s.slice(last + 1);
    const count = s.split(sep).length - 1;
    const bothKinds = lastComma >= 0 && lastDot >= 0;
    const isDecimal = bothKinds || (count === 1 && (after.length !== 3 || d === 3));
    if (isDecimal) { intPart = s.slice(0, last).replace(/[.,]/g, ''); frac = after; }
    else intPart = s.replace(/[.,]/g, '');
  }
  const value = Number(`${intPart || '0'}.${frac || '0'}`);
  if (!Number.isFinite(value)) return null;
  const minor = Math.round(value * 10 ** d);
  return neg ? -minor : minor;
}
// Quantity like "2", "0,75" or "1.5"
export function parseQty(str) {
  const n = Number(String(str ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

// "19", "7,5", "10 %" -> number between 0 and 100. Empty -> null, invalid -> NaN.
export function parsePercent(str) {
  const s = String(str ?? '').replace('%', '').trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : NaN;
}
export function pctToInput(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '';
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: 2, useGrouping: false }).format(n);
}
export const fmtPct = (n) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(n);

// ---- Calculation. Same maths as lib/receipts.js (test/logic.test.mjs checks that both agree). ----
const rnd = (x) => { const v = Number(x.toFixed(6)); return v < 0 ? -Math.round(-v) : Math.round(v); };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pctOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const clampPct = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0; };

export function itemLine(i) {
  const gross = rnd(num(i.quantity) * num(i.unitPriceMinor));
  return { gross, afterItem: rnd(gross * (100 - clampPct(i.discountPct)) / 100) };
}
export function receiptTotals(r) {
  const included = !!r.taxIncluded;
  const recDisc = clampPct(r.discountPct);
  let subtotal = 0; let itemDiscount = 0; let receiptDiscount = 0;
  const groups = new Map();
  for (const i of r.items || []) {
    const { gross, afterItem } = itemLine(i);
    const net = rnd(afterItem * (100 - recDisc) / 100);
    subtotal += gross; itemDiscount += gross - afterItem; receiptDiscount += afterItem - net;
    const rate = pctOrNull(i.taxRatePct) ?? 0;
    groups.set(rate, (groups.get(rate) || 0) + net);
  }
  const taxByRate = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([rate, base]) => ({
    rate, base, tax: included ? rnd(base * rate / (100 + rate)) : rnd(base * rate / 100),
  }));
  const legacyTax = Math.max(0, rnd(num(r.legacyTaxMinor)));
  const base = taxByRate.reduce((s, g) => s + g.base, 0);
  const tax = taxByRate.reduce((s, g) => s + g.tax, 0) + legacyTax;
  return { subtotal, itemDiscount, receiptDiscount, taxByRate, legacyTax, tax, total: base + (included ? 0 : tax) };
}
