import { receiptTotals, itemAmounts } from './format.js';

// The overview shows ONE period (a day, an ISO week, a month, a quarter or a year) chosen by the user.
// Dates are 'YYYY-MM-DD' strings and all date maths is done in UTC, so daylight saving never shifts a day.
const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fromISO = (s) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const addDays = (s, n) => { const d = fromISO(s); d.setUTCDate(d.getUTCDate() + n); return toISO(d); };
// Month arithmetic: Date.UTC normalises overflowing months (month 12 -> January of the next year, -1 -> December).
const monthStart = (y, m0) => toISO(new Date(Date.UTC(y, m0, 1)));
const monthEnd = (y, m0) => toISO(new Date(Date.UTC(y, m0 + 1, 0)));

// ISO 8601 week: weeks start on Monday, week 1 contains the first Thursday.
export function isoWeek(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return [date.getUTCFullYear(), Math.ceil(((date - yearStart) / 86400000 + 1) / 7)];
}
// Monday of the given ISO week (January 4th is always in week 1).
export function isoWeekStart(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = (jan4.getUTCDay() + 6) % 7;
  jan4.setUTCDate(4 - dow + 7 * (week - 1));
  return toISO(jan4);
}

export function periodKey(dateStr, period) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  switch (period) {
    case 'day': return dateStr.slice(0, 10);
    case 'week': { const [wy, w] = isoWeek(y, m, d); return `${wy}-W${pad(w)}`; }
    case 'month': return dateStr.slice(0, 7);
    case 'quarter': return `${y}-Q${Math.ceil(m / 3)}`;
    default: return String(y);
  }
}

// First and last day (inclusive) of the period that contains `anchor`.
export function periodRange(period, anchor) {
  const [y, m] = anchor.slice(0, 10).split('-').map(Number);
  switch (period) {
    case 'day': return { from: anchor.slice(0, 10), to: anchor.slice(0, 10) };
    case 'week': {
      const from = addDays(anchor.slice(0, 10), -((fromISO(anchor).getUTCDay() + 6) % 7));
      return { from, to: addDays(from, 6) };
    }
    case 'month': return { from: monthStart(y, m - 1), to: monthEnd(y, m - 1) };
    case 'quarter': { const q0 = Math.floor((m - 1) / 3) * 3; return { from: monthStart(y, q0), to: monthEnd(y, q0 + 2) }; }
    default: return { from: monthStart(y, 0), to: monthEnd(y, 11) };
  }
}

// A date inside the previous (delta -1) or next (delta +1) period.
export function shiftAnchor(period, anchor, delta) {
  const { from } = periodRange(period, anchor);
  const [y, m] = from.split('-').map(Number);
  switch (period) {
    case 'day': return addDays(from, delta);
    case 'week': return addDays(from, 7 * delta);
    case 'month': return monthStart(y, m - 1 + delta);
    case 'quarter': return monthStart(y, m - 1 + 3 * delta);
    default: return monthStart(y + delta, 0);
  }
}

// The columns of the chart: weeks and months by day, quarters and years by month, a single day has none.
export function periodBuckets(period, range) {
  if (period === 'week' || period === 'month') {
    const out = [];
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) out.push({ key: d, from: d, to: d });
    return out;
  }
  if (period === 'quarter' || period === 'year') {
    const [y, m] = range.from.split('-').map(Number);
    return Array.from({ length: period === 'quarter' ? 3 : 12 }, (_, i) => {
      const from = monthStart(y, m - 1 + i);
      return { key: from.slice(0, 7), from, to: monthEnd(y, m - 1 + i) };
    });
  }
  return [];
}
const bucketKeyOf = (period, dateStr) => (period === 'quarter' || period === 'year' ? dateStr.slice(0, 7) : dateStr.slice(0, 10));

export function filterByDate(list, from, to) {
  return list.filter((r) => {
    const d = r.purchasedAt.slice(0, 10);
    return (!from || d >= from) && (!to || d <= to);
  });
}

const byDate = (a, b) => (a.purchasedAt === b.purchasedAt ? (a.id < b.id ? -1 : 1) : a.purchasedAt < b.purchasedAt ? -1 : 1);

// Totals are never mixed across currencies: the overview covers one currency (the most used one unless chosen).
export function buildReport(receipts, { period, anchor, currency }) {
  const range = periodRange(period, anchor);
  const inRange = filterByDate(receipts, range.from, range.to);
  const counts = {};
  inRange.forEach((r) => { counts[r.currency] = (counts[r.currency] || 0) + 1; });
  const currencies = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count }));
  const cur = currencies.some((c) => c.code === currency) ? currency : (currencies[0] ? currencies[0].code : '');

  const mine = inRange.filter((r) => r.currency === cur).sort(byDate);
  const buckets = periodBuckets(period, range).map((b) => ({ ...b, count: 0, totalMinor: 0 }));
  const bucketByKey = new Map(buckets.map((b) => [b.key, b]));
  const stores = new Map(); const categories = new Map();
  const totals = { count: 0, taxMinor: 0, totalMinor: 0 };
  for (const r of mine) {
    const { tax, total } = receiptTotals(r);
    const b = bucketByKey.get(bucketKeyOf(period, r.purchasedAt));
    if (b) { b.count++; b.totalMinor += total; }
    const name = (r.store && r.store.name) || '—';
    const s = stores.get(name) || { name, count: 0, totalMinor: 0 };
    s.count++; s.totalMinor += total; stores.set(name, s);
    for (const it of itemAmounts(r)) {
      const c = categories.get(it.category) || { name: it.category, count: 0, totalMinor: 0 };
      c.count++; c.totalMinor += it.amount; categories.set(it.category, c);
    }
    totals.count++; totals.taxMinor += tax; totals.totalMinor += total;
  }

  // The period before this one, for the comparison under "total spent".
  const prevRange = periodRange(period, shiftAnchor(period, anchor, -1));
  const prevList = filterByDate(receipts, prevRange.from, prevRange.to).filter((r) => r.currency === cur);
  const previous = { range: prevRange, count: prevList.length, totalMinor: prevList.reduce((s, r) => s + receiptTotals(r).total, 0) };

  const hasNamedCategory = [...categories.values()].some((c) => c.name);
  return {
    range, key: periodKey(range.from, period), currencies, currency: cur, totals,
    average: totals.count ? Math.round(totals.totalMinor / totals.count) : 0,
    buckets, receipts: mine, previous,
    byStore: [...stores.values()].sort((a, b) => b.totalMinor - a.totalMinor),
    // Only shown when at least one item has a category (categories are optional).
    byCategory: hasNamedCategory ? [...categories.values()].sort((a, b) => b.totalMinor - a.totalMinor) : [],
  };
}

// One row per receipt. lang 'de' -> ';' separated with decimal comma (Excel in Germany); otherwise ',' and '.'.
export function receiptsToCsv(receipts, cur, digitCount, lang, headers) {
  const sep = lang === 'de' ? ';' : ',';
  const num = (minor) => {
    const s = (minor / 10 ** digitCount).toFixed(digitCount);
    return lang === 'de' ? s.replace('.', ',') : s;
  };
  // Quote only when needed: the separator in use, a quote or a line break (a decimal comma is fine in German files).
  const cell = (v) => { const x = String(v); return x.includes(sep) || /["\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const lines = [headers.map(cell).join(sep)];
  for (const r of receipts) {
    const { tax, total } = receiptTotals(r);
    lines.push([r.id, r.purchasedAt.replace('T', ' '), (r.store && r.store.name) || '', (r.store && r.store.location) || '',
      num(tax), num(total), cur].map(cell).join(sep));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
