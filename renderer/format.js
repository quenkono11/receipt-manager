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

export function receiptTotals(r) {
  const subtotal = (r.items || []).reduce(
    (sum, i) => sum + Math.round((Number(i.quantity) || 0) * (Number(i.unitPriceMinor) || 0)), 0);
  const tax = Math.round(Number(r.taxMinor) || 0);
  return { subtotal, tax, total: subtotal + (r.taxIncluded ? 0 : tax) };
}
