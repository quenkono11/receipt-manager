// Run with: npm test   (plain Node, no Electron needed)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const lib = require('../lib/receipts.js');

// The renderer uses ES modules in .js files; copy them to a temp dir marked as ESM to import them.
const tmp = mkdtempSync(path.join(tmpdir(), 'rm-'));
mkdirSync(path.join(tmp, 'locales'));
writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
for (const f of ['i18n.js', 'format.js', 'reports.js', 'locales/en.js', 'locales/de.js'])
  copyFileSync(path.join(here, '..', 'renderer', f), path.join(tmp, f));
const imp = (f) => import(pathToFileURL(path.join(tmp, f)).href);
const i18n = await imp('i18n.js'), fmt = await imp('format.js'), rep = await imp('reports.js');
const en = (await imp('locales/en.js')).default, de = (await imp('locales/de.js')).default;

// IDs
const id = lib.newId('2026', new Set());
assert.match(id, /^REC-2026-\d{5}$/);
assert.notEqual(lib.newId('2026', new Set([id])), id);

// Validation + sanitising
const r = lib.sanitizeReceipt({ store: { name: ' Rewe ' }, purchasedAt: '2026-03-04T12:30', currency: 'eur',
  items: [{ name: 'Milk', quantity: 2, unitPriceMinor: 129 }, { name: '', quantity: 1, unitPriceMinor: 0 }],
  taxMinor: 17, taxIncluded: false }, id, null);
assert.equal(r.items.length, 1); assert.equal(r.currency, 'EUR'); assert.equal(r.totalMinor, 2 * 129 + 17);
assert.equal(lib.validateReceipt(r), null);
assert.ok(lib.validateReceipt({ ...r, id: 'bad' }));
assert.ok(lib.validateReceipt({ ...r, items: [{ quantity: 'x', unitPriceMinor: 1 }] }));

// Money parsing
i18n.setLang('en');
for (const [s, want] of [['12,50', 1250], ['12.50', 1250], ['1.234,56', 123456], ['1,234.56', 123456], ['1.234', 123400], ['0,5', 50], ['7', 700], ['-3,2', -320]])
  assert.equal(fmt.parseMoney(s, 'EUR'), want, s);
assert.equal(fmt.parseMoney('abc', 'EUR'), null);
assert.equal(fmt.parseMoney('1500', 'JPY'), 1500);

// Weeks / periods (ISO): 2026-01-01 is Thursday -> W01; 2024-12-30 belongs to 2025-W01; 2021-01-03 -> 2020-W53
assert.equal(rep.periodKey('2026-01-01', 'week'), '2026-W01');
assert.equal(rep.periodKey('2024-12-30', 'week'), '2025-W01');
assert.equal(rep.periodKey('2021-01-03', 'week'), '2020-W53');
assert.equal(rep.periodKey('2026-05-17T10:00', 'quarter'), '2026-Q2');

// Report
const mk = (date, store, cents, cur = 'EUR') => ({ purchasedAt: date, currency: cur, store: { name: store },
  items: [{ name: 'x', quantity: 1, unitPriceMinor: cents }], taxMinor: 0 });
const list = [mk('2026-01-05T10:00', 'A', 1000), mk('2026-01-20T10:00', 'B', 500), mk('2026-02-02T10:00', 'A', 250), mk('2026-02-03T10:00', 'A', 99, 'USD')];
const out = rep.buildReport(list, { period: 'month', from: '2026-01-01', to: '2026-12-31', currency: 'EUR' });
assert.deepEqual(out.rows.map((x) => [x.key, x.totalMinor]), [['2026-01', 1500], ['2026-02', 250]]);
assert.equal(out.byStore[0].name, 'A'); assert.equal(out.currencies.length, 2); assert.equal(out.totals.count, 3);

// Both languages define exactly the same keys
assert.deepEqual(Object.keys(en).sort(), Object.keys(de).sort());
console.log('all tests passed');
