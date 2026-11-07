'use strict';
// Pure receipt logic (no Electron, no file access) so it can be unit-tested with plain Node.
// renderer/format.js contains the same calculation for the UI; test/logic.test.mjs checks they agree.
const crypto = require('crypto');

const SCHEMA_VERSION = 2;
const ID_RE = /^REC-(\d{4})-(\d{5})$/;
const KEY_RE = /^[0-9a-f]{8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const FILE_RE = /^REC-\d{4}-\d{5}(?:_[0-9a-f]{8})?\.json$/;

// ---------- money maths ----------
// Round half away from zero; toFixed(6) removes float noise such as 2.4999999999.
const rnd = (x) => { const v = Number(x.toFixed(6)); return v < 0 ? -Math.round(-v) : Math.round(v); };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pctOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const clampPct = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0; };

// One item: gross = quantity x unit price, afterItem = gross minus the item's own discount.
function itemLine(i) {
  const gross = rnd(num(i.quantity) * num(i.unitPriceMinor));
  return { gross, afterItem: rnd(gross * (100 - clampPct(i.discountPct)) / 100) };
}

// Order of calculation: item discount, then receipt discount, then tax per rate.
// With taxIncluded the prices already contain the tax (German style); otherwise tax is added on top.
function receiptTotals(r) {
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
  // Receipts from version 1.0 carry one fixed tax amount instead of rates.
  const legacyTax = Math.max(0, rnd(num(r.legacyTaxMinor)));
  const base = taxByRate.reduce((s, g) => s + g.base, 0);
  const tax = taxByRate.reduce((s, g) => s + g.tax, 0) + legacyTax;
  return { subtotal, itemDiscount, receiptDiscount, taxByRate, legacyTax, tax, total: base + (included ? 0 : tax) };
}

// ---------- validation ----------
// Returns an error message, or null when the object is a usable receipt.
function validateReceipt(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not a receipt object';
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'invalid or missing id';
  if (typeof r.purchasedAt !== 'string' || !DATE_RE.test(r.purchasedAt)) return 'invalid or missing purchasedAt';
  if (typeof r.currency !== 'string' || !r.currency) return 'invalid or missing currency';
  if (!Array.isArray(r.items)) return 'items must be a list';
  const badItem = r.items.some((i) => !i || typeof i !== 'object' ||
    !Number.isFinite(Number(i.quantity)) || !Number.isFinite(Number(i.unitPriceMinor)));
  if (badItem) return 'an item has an invalid quantity or price';
  if (r.taxMinor !== undefined && !Number.isFinite(Number(r.taxMinor))) return 'invalid taxMinor';
  if (r.key !== undefined && !KEY_RE.test(String(r.key))) return 'invalid key';
  return null;
}

// ---------- building what is written to disk ----------
// Builds the stored object from untrusted input. Keeps createdAt (and, with touch:false, updatedAt) from `prev`.
function sanitizeReceipt(input, id, key, prev, opts = {}) {
  const now = new Date().toISOString();
  const items = (Array.isArray(input.items) ? input.items : [])
    .map((i) => ({
      name: String(i.name || '').trim(),
      quantity: Number(i.quantity) > 0 ? Number(i.quantity) : 1,
      unitPriceMinor: rnd(num(i.unitPriceMinor)),
      discountPct: clampPct(i.discountPct),
      taxRatePct: pctOrNull(i.taxRatePct) === null ? null : clampPct(i.taxRatePct),
    }))
    .filter((i) => i.name || i.unitPriceMinor);
  const receipt = {
    schemaVersion: SCHEMA_VERSION,
    id,
    key,
    store: {
      name: String((input.store && input.store.name) || '').trim(),
      location: String((input.store && input.store.location) || '').trim(),
    },
    purchasedAt: String(input.purchasedAt).slice(0, 16),
    currency: String(input.currency || 'EUR').trim().toUpperCase(),
    items,
    discountPct: clampPct(input.discountPct),
    taxIncluded: !!input.taxIncluded,
  };
  const legacy = Math.max(0, rnd(num(input.legacyTaxMinor)));
  if (legacy > 0) receipt.legacyTaxMinor = legacy;
  const t = receiptTotals(receipt);
  receipt.taxMinor = t.tax;
  receipt.totalMinor = t.total;
  receipt.notes = String(input.notes || '');
  receipt.createdAt = (prev && prev.createdAt) || now;
  receipt.updatedAt = opts.touch === false && prev && prev.updatedAt ? prev.updatedAt : now;
  return receipt;
}

// ---------- keys, ids, file names ----------
// The key is the receipt's permanent identity (it never changes); the visible ID is derived from the order.
const newKey = (taken) => {
  for (let i = 0; i < 1000; i++) {
    const k = crypto.randomBytes(4).toString('hex');
    if (!taken.has(k)) return k;
  }
  throw new Error('No free receipt key');
};
// Deterministic, so two computers migrating the same 1.0 file end up with the same key.
const deriveKey = (r) => crypto.createHash('sha256')
  .update(`${r.createdAt || ''}|${r.id}|${r.purchasedAt}`).digest('hex').slice(0, 8);
const formatId = (year, n) => `REC-${year}-${String(n).padStart(5, '0')}`;
const fileNameFor = (id, key) => `${id}_${key}.json`;

// Converts a 1.0 receipt (fixed tax amount, no key) to the current format without counting as an edit.
function migrate(data) {
  if (data.schemaVersion >= 2 && KEY_RE.test(String(data.key || ''))) return { receipt: data, migrated: false };
  const key = KEY_RE.test(String(data.key || '')) ? data.key : deriveKey(data);
  const legacy = data.schemaVersion >= 2 ? data.legacyTaxMinor : data.taxMinor;
  const receipt = sanitizeReceipt({ ...data, legacyTaxMinor: legacy }, data.id, key, data, { touch: false });
  return { receipt, migrated: true };
}

// Numbers follow purchase date and time, per year: the oldest receipt of a year is REC-<year>-00001.
// Receipts with the same date and time are ordered by creation time, then by key.
// Returns Map(key -> { id, file }).
function planNumbers(receipts) {
  const byYear = new Map();
  for (const r of receipts) {
    const y = r.purchasedAt.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(r);
  }
  const plan = new Map();
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  for (const [year, list] of byYear) {
    if (list.length > 99999) throw new Error(`More than 99999 receipts in ${year}`);
    list.sort((a, b) => cmp(a.purchasedAt, b.purchasedAt) || cmp(a.createdAt || '', b.createdAt || '') || cmp(a.key, b.key));
    list.forEach((r, idx) => {
      const id = formatId(year, idx + 1);
      plan.set(r.key, { id, file: fileNameFor(id, r.key) });
    });
  }
  return plan;
}

module.exports = {
  SCHEMA_VERSION, ID_RE, KEY_RE, FILE_RE,
  receiptTotals, itemLine, validateReceipt, sanitizeReceipt,
  newKey, deriveKey, formatId, fileNameFor, migrate, planNumbers,
};
