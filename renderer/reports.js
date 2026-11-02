import { receiptTotals } from './format.js';

// ISO 8601 week: weeks start on Monday, week 1 contains the first Thursday.
export function isoWeek(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return [date.getUTCFullYear(), Math.ceil(((date - yearStart) / 86400000 + 1) / 7)];
}

export function periodKey(dateStr, period) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  switch (period) {
    case 'day': return dateStr.slice(0, 10);
    case 'week': { const [wy, w] = isoWeek(y, m, d); return `${wy}-W${String(w).padStart(2, '0')}`; }
    case 'month': return dateStr.slice(0, 7);
    case 'quarter': return `${y}-Q${Math.ceil(m / 3)}`;
    default: return String(y);
  }
}

export function filterByDate(list, from, to) {
  return list.filter((r) => {
    const d = r.purchasedAt.slice(0, 10);
    return (!from || d >= from) && (!to || d <= to);
  });
}

// Totals are never mixed across currencies: the report covers one currency.
export function buildReport(receipts, { period, from, to, currency }) {
  const inRange = filterByDate(receipts, from, to);
  const counts = {};
  inRange.forEach((r) => { counts[r.currency] = (counts[r.currency] || 0) + 1; });
  const currencies = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count }));
  const cur = currencies.some((c) => c.code === currency) ? currency : (currencies[0] ? currencies[0].code : '');

  const periods = new Map();
  const stores = new Map();
  const totals = { count: 0, taxMinor: 0, totalMinor: 0 };
  for (const r of inRange.filter((x) => x.currency === cur)) {
    const { tax, total } = receiptTotals(r);
    const key = periodKey(r.purchasedAt, period);
    const p = periods.get(key) || { key, count: 0, taxMinor: 0, totalMinor: 0 };
    p.count++; p.taxMinor += tax; p.totalMinor += total;
    periods.set(key, p);
    const name = (r.store && r.store.name) || '—';
    const s = stores.get(name) || { name, count: 0, totalMinor: 0 };
    s.count++; s.totalMinor += total;
    stores.set(name, s);
    totals.count++; totals.taxMinor += tax; totals.totalMinor += total;
  }
  return {
    currencies, currency: cur, totals,
    average: totals.count ? Math.round(totals.totalMinor / totals.count) : 0,
    rows: [...periods.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    byStore: [...stores.values()].sort((a, b) => b.totalMinor - a.totalMinor),
  };
}

// lang 'de' -> ';' separated with decimal comma (Excel in Germany); otherwise ',' and '.'.
export function reportToCsv(rows, labelFn, cur, digitCount, lang, headers) {
  const sep = lang === 'de' ? ';' : ',';
  const num = (minor) => {
    const s = (minor / 10 ** digitCount).toFixed(digitCount);
    return lang === 'de' ? s.replace('.', ',') : s;
  };
  const cell = (v) => (/[";,\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [headers.map(cell).join(sep)];
  for (const r of rows) {
    lines.push([labelFn(r.key), r.count, num(r.taxMinor), num(r.totalMinor), cur].map(cell).join(sep));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
