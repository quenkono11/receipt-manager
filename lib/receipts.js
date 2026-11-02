'use strict';
// Pure receipt logic (no Electron) so it can be unit-tested with plain Node.
const crypto = require('crypto');

const ID_RE = /^REC-(\d{4})-(\d{5})$/;
const FILE_RE = /^REC-\d{4}-\d{5}\.json$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function receiptTotals(r) {
  const subtotal = (r.items || []).reduce(
    (sum, i) => sum + Math.round((Number(i.quantity) || 0) * (Number(i.unitPriceMinor) || 0)), 0);
  const tax = Math.round(Number(r.taxMinor) || 0);
  return { subtotal, tax, total: subtotal + (r.taxIncluded ? 0 : tax) };
}

// Returns an error message, or null when the object is a usable receipt.
function validateReceipt(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not a receipt object';
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'invalid or missing id';
  if (typeof r.purchasedAt !== 'string' || !DATE_RE.test(r.purchasedAt)) return 'invalid or missing purchasedAt';
  if (typeof r.currency !== 'string' || !r.currency) return 'invalid or missing currency';
  if (!Array.isArray(r.items)) return 'items must be a list';
  const badItem = r.items.some(i => !i || typeof i !== 'object' ||
    !Number.isFinite(Number(i.quantity)) || !Number.isFinite(Number(i.unitPriceMinor)));
  if (badItem) return 'an item has an invalid quantity or price';
  if (r.taxMinor !== undefined && !Number.isFinite(Number(r.taxMinor))) return 'invalid taxMinor';
  return null;
}

// Builds the object that is written to disk from untrusted renderer input.
function sanitizeReceipt(input, id, prev) {
  const now = new Date().toISOString();
  const items = (Array.isArray(input.items) ? input.items : [])
    .map(i => ({
      name: String(i.name || '').trim(),
      quantity: Number(i.quantity) > 0 ? Number(i.quantity) : 1,
      unitPriceMinor: Math.round(Number(i.unitPriceMinor) || 0),
    }))
    .filter(i => i.name || i.unitPriceMinor);
  const receipt = {
    schemaVersion: 1,
    id,
    store: {
      name: String((input.store && input.store.name) || '').trim(),
      location: String((input.store && input.store.location) || '').trim(),
    },
    purchasedAt: String(input.purchasedAt).slice(0, 16),
    currency: String(input.currency || 'EUR').trim().toUpperCase(),
    items,
    taxMinor: Math.round(Number(input.taxMinor) || 0),
    taxIncluded: !!input.taxIncluded,
    totalMinor: 0,
    notes: String(input.notes || ''),
    createdAt: (prev && prev.createdAt) || now,
    updatedAt: now,
  };
  receipt.totalMinor = receiptTotals(receipt).total;
  return receipt;
}

// REC-<year>-<5 digits>; `taken` is a Set of ids/filenames already in use.
function newId(year, taken) {
  for (let i = 0; i < 5000; i++) {
    const id = `REC-${year}-${crypto.randomInt(10000, 100000)}`;
    if (!taken.has(id)) return id;
  }
  throw new Error('No free receipt number left for ' + year);
}

module.exports = { ID_RE, FILE_RE, receiptTotals, validateReceipt, sanitizeReceipt, newId };
