// Run with: npm test   (plain Node, no Electron needed)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const lib = require('../lib/receipts.js');
const F = require('../lib/folder.js');

// The renderer uses ES modules in .js files; copy them to a temp dir marked as ESM to import them.
const tmp = mkdtempSync(path.join(tmpdir(), 'rm-'));
mkdirSync(path.join(tmp, 'locales'));
writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
for (const f of ['i18n.js', 'format.js', 'reports.js', 'locales/en.js', 'locales/de.js'])
  copyFileSync(path.join(here, '..', 'renderer', f), path.join(tmp, f));
const imp = (f) => import(pathToFileURL(path.join(tmp, f)).href);
const i18n = await imp('i18n.js'), fmt = await imp('format.js'), rep = await imp('reports.js');
const en = (await imp('locales/en.js')).default, de = (await imp('locales/de.js')).default;

const item = (name, qty, cents, disc = 0, rate = null) => ({ name, quantity: qty, unitPriceMinor: cents, discountPct: disc, taxRatePct: rate });

// ---------- tax and discount maths ----------
// Included tax: 11.90 at 19 % contains 1.90 tax; total stays 11.90.
let t = lib.receiptTotals({ taxIncluded: true, items: [item('a', 1, 1190, 0, 19)] });
assert.equal(t.tax, 190); assert.equal(t.total, 1190); assert.equal(t.subtotal, 1190);
// Added tax: 10.00 at 19 % -> 1.90 tax, total 11.90.
t = lib.receiptTotals({ taxIncluded: false, items: [item('a', 1, 1000, 0, 19)] });
assert.equal(t.tax, 190); assert.equal(t.total, 1190);
// Two rates are taxed per rate.
t = lib.receiptTotals({ taxIncluded: true, items: [item('milk', 2, 129, 0, 7), item('bag', 1, 100, 0, 19), item('bread', 1, 250, 0, 7)] });
assert.deepEqual(t.taxByRate.map((g) => [g.rate, g.base, g.tax]), [[7, 508, 33], [19, 100, 16]]);
assert.equal(t.total, 608);
// Item discount (10 % of 20.00), then receipt discount (50 % of the rest).
t = lib.receiptTotals({ taxIncluded: true, discountPct: 50, items: [item('a', 1, 2000, 10, 0)] });
assert.equal(t.itemDiscount, 200); assert.equal(t.receiptDiscount, 900); assert.equal(t.total, 900);
// A missing rate counts as 0 %, legacy fixed tax is added when prices exclude tax.
t = lib.receiptTotals({ taxIncluded: false, legacyTaxMinor: 17, items: [item('a', 2, 129)] });
assert.equal(t.tax, 17); assert.equal(t.total, 258 + 17);
t = lib.receiptTotals({ taxIncluded: true, legacyTaxMinor: 17, items: [item('a', 2, 129)] });
assert.equal(t.tax, 17); assert.equal(t.total, 258);
// Half-cent rounds away from zero, also for negative amounts (refunds).
assert.equal(lib.receiptTotals({ items: [item('a', 1, 5, 50)] }).total, 3);
assert.equal(lib.receiptTotals({ items: [item('a', 1, -5, 50)] }).total, -3);

// The UI copy of the maths must agree with lib/receipts.js on many random receipts.
let seed = 12345; const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
for (let n = 0; n < 500; n++) {
  const r = { taxIncluded: rand() < 0.5, discountPct: [0, 0, 5, 12.5, 100][Math.floor(rand() * 5)],
    legacyTaxMinor: rand() < 0.1 ? Math.floor(rand() * 300) : 0,
    items: Array.from({ length: 1 + Math.floor(rand() * 5) }, () => item('x', [1, 2, 0.5, 3.25][Math.floor(rand() * 4)],
      Math.floor(rand() * 20000) - 500, [0, 0, 10, 33.3][Math.floor(rand() * 4)], [null, 0, 7, 19, 5.5][Math.floor(rand() * 5)])) };
  assert.deepEqual(fmt.receiptTotals(r), lib.receiptTotals(r));
}

// ---------- validation and sanitising ----------
const id = 'REC-2026-00001'; const key = 'a1b2c3d4';
const r = lib.sanitizeReceipt({ store: { name: ' Rewe ' }, purchasedAt: '2026-03-04T12:30:55', currency: 'eur', taxIncluded: true,
  items: [item('Milk', 2, 129, 0, 7), item('', 1, 0), { name: 'Bad%', quantity: 1, unitPriceMinor: 100, discountPct: 500, taxRatePct: 'x' }] }, id, key, null);
assert.equal(r.items.length, 2); assert.equal(r.currency, 'EUR'); assert.equal(r.purchasedAt, '2026-03-04T12:30');
assert.equal(r.items[1].discountPct, 100); assert.equal(r.items[1].taxRatePct, null);
assert.equal(r.schemaVersion, 2); assert.equal(r.key, key); assert.equal(r.totalMinor, 258);
assert.equal(lib.validateReceipt(r), null);
assert.ok(lib.validateReceipt({ ...r, id: 'bad' }));
assert.ok(lib.validateReceipt({ ...r, key: 'XYZ' }));
assert.ok(lib.validateReceipt({ ...r, items: [{ quantity: 'x', unitPriceMinor: 1 }] }));

// ---------- percent and money parsing ----------
i18n.setLang('en');
assert.equal(fmt.parsePercent('19'), 19); assert.equal(fmt.parsePercent('7,5 %'), 7.5); assert.equal(fmt.parsePercent(''), null);
assert.ok(Number.isNaN(fmt.parsePercent('abc'))); assert.ok(Number.isNaN(fmt.parsePercent('101'))); assert.ok(Number.isNaN(fmt.parsePercent('-1')));
for (const [s, want] of [['12,50', 1250], ['12.50', 1250], ['1.234,56', 123456], ['1,234.56', 123456], ['1.234', 123400], ['0,5', 50], ['7', 700], ['-3,2', -320]])
  assert.equal(fmt.parseMoney(s, 'EUR'), want, s);
assert.equal(fmt.parseMoney('abc', 'EUR'), null);
assert.equal(fmt.parseMoney('1500', 'JPY'), 1500);

// ---------- weeks, periods, reports ----------
assert.equal(rep.periodKey('2026-01-01', 'week'), '2026-W01');
assert.equal(rep.periodKey('2024-12-30', 'week'), '2025-W01');
assert.equal(rep.periodKey('2021-01-03', 'week'), '2020-W53');
assert.equal(rep.periodKey('2026-05-17T10:00', 'quarter'), '2026-Q2');
const mk = (date, store, cents, cur = 'EUR') => ({ purchasedAt: date, currency: cur, store: { name: store }, items: [item('x', 1, cents)] });
const list = [mk('2026-01-05T10:00', 'A', 1000), mk('2026-01-20T10:00', 'B', 500), mk('2026-02-02T10:00', 'A', 250), mk('2026-02-03T10:00', 'A', 99, 'USD')];
const out = rep.buildReport(list, { period: 'month', from: '2026-01-01', to: '2026-12-31', currency: 'EUR' });
assert.deepEqual(out.rows.map((x) => [x.key, x.totalMinor]), [['2026-01', 1500], ['2026-02', 250]]);
assert.equal(out.byStore[0].name, 'A'); assert.equal(out.currencies.length, 2); assert.equal(out.totals.count, 3);

// ---------- both languages define exactly the same keys ----------
assert.deepEqual(Object.keys(en).sort(), Object.keys(de).sort());

// ---------- numbering plan ----------
const rc = (purchasedAt, k, createdAt = '2026-01-01T00:00:00.000Z') => ({ purchasedAt, key: k, createdAt });
const plan = lib.planNumbers([rc('2026-05-01T10:00', 'bbbbbbbb'), rc('2026-03-01T10:00', 'aaaaaaaa'), rc('2025-12-31T23:59', 'cccccccc'),
  rc('2026-05-01T10:00', 'dddddddd', '2026-01-02T00:00:00.000Z')]);
assert.equal(plan.get('aaaaaaaa').id, 'REC-2026-00001'); assert.equal(plan.get('bbbbbbbb').id, 'REC-2026-00002');
assert.equal(plan.get('dddddddd').id, 'REC-2026-00003'); assert.equal(plan.get('cccccccc').id, 'REC-2025-00001');
assert.equal(plan.get('aaaaaaaa').file, 'REC-2026-00001_aaaaaaaa.json');

// ---------- folder: save, renumber, delete ----------
const mkdir = () => mkdtempSync(path.join(tmpdir(), 'rm-folder-'));
const input = (when, name = 'Rewe') => ({ store: { name }, purchasedAt: when, currency: 'EUR', taxIncluded: true, items: [item('x', 1, 100, 0, 19)] });
const ids = async (dir) => (await F.refresh(dir)).receipts.sort((a, b) => (a.id < b.id ? -1 : 1)).map((x) => `${x.id}:${x.store.name}`);
let dir = mkdir();
const m = await F.saveReceipt(dir, input('2026-03-10T10:00', 'March'), null);
assert.equal(m.id, 'REC-2026-00001');
await F.saveReceipt(dir, input('2026-05-10T10:00', 'May'), null);
assert.deepEqual(await ids(dir), ['REC-2026-00001:March', 'REC-2026-00002:May']);
// An older receipt takes number 1 and the others move up.
const jan = await F.saveReceipt(dir, input('2026-01-05T09:00', 'Jan'), null);
assert.equal(jan.id, 'REC-2026-00001');
assert.deepEqual(await ids(dir), ['REC-2026-00001:Jan', 'REC-2026-00002:March', 'REC-2026-00003:May']);
// The key survives renumbering; files are renamed.
assert.equal((await F.refresh(dir)).receipts.find((x) => x.store.name === 'March').key, m.key);
assert.ok(existsSync(path.join(dir, `REC-2026-00002_${m.key}.json`)));
assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 3);
// Moving a receipt into another year renumbers both years.
await F.saveReceipt(dir, input('2025-12-31T20:00', 'Moved'), m.key);
assert.deepEqual(await ids(dir), ['REC-2025-00001:Moved', 'REC-2026-00001:Jan', 'REC-2026-00002:May']);
// Delete closes the gap.
await F.deleteReceipt(dir, jan.key);
assert.deepEqual(await ids(dir), ['REC-2025-00001:Moved', 'REC-2026-00001:May']);
// Refreshing again changes nothing.
assert.equal((await F.refresh(dir)).writes, 0);

// ---------- folder: 1.0 files are migrated ----------
dir = mkdir();
const v1 = (idv, when, tax) => ({ schemaVersion: 1, id: idv, store: { name: 'Old', location: '' }, purchasedAt: when, currency: 'EUR',
  items: [{ name: 'Milk', quantity: 2, unitPriceMinor: 129 }], taxMinor: tax, taxIncluded: false, totalMinor: 258 + tax, notes: 'n',
  createdAt: '2026-02-01T10:00:00.000Z', updatedAt: '2026-02-01T10:00:00.000Z' });
writeFileSync(path.join(dir, 'REC-2026-20589.json'), JSON.stringify(v1('REC-2026-20589', '2026-03-04T12:30', 17)));
writeFileSync(path.join(dir, 'REC-2026-11111.json'), JSON.stringify({ ...v1('REC-2026-11111', '2026-01-04T12:30', 0), createdAt: '2026-02-02T10:00:00.000Z' }));
const mig = await F.refresh(dir);
assert.equal(mig.migrated, 2);
const old = mig.receipts.find((x) => x.purchasedAt.startsWith('2026-03'));
assert.equal(old.id, 'REC-2026-00002'); assert.equal(old.schemaVersion, 2); assert.equal(old.legacyTaxMinor, 17);
assert.equal(old.updatedAt, '2026-02-01T10:00:00.000Z'); assert.equal(old.notes, 'n');
assert.equal(fmt.receiptTotals(old).total, 258 + 17);
assert.ok(!existsSync(path.join(dir, 'REC-2026-20589.json')));
assert.equal((await F.refresh(dir)).migrated, 0);
// The same 1.0 file migrated on two computers gets the same key.
assert.equal(lib.migrate(v1('REC-2026-20589', '2026-03-04T12:30', 17)).receipt.key, old.key);

// ---------- folder: interrupted rename leaves two files with one key ----------
dir = mkdir();
const keep = await F.saveReceipt(dir, input('2026-04-01T10:00', 'Dup'), null);
const file = readdirSync(dir).find((f) => f.endsWith('.json'));
const copy = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
writeFileSync(path.join(dir, `REC-2026-00009_${copy.key}.json`), JSON.stringify({ ...copy, id: 'REC-2026-00009' }));
const healed = await F.refresh(dir);
assert.equal(healed.receipts.length, 1); assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 1);
assert.equal(healed.receipts[0].id, 'REC-2026-00001');

// ---------- folder: import ----------
dir = mkdir();
const src = mkdir();
const a = await F.saveReceipt(src, input('2026-02-01T10:00', 'FromOther'), null);
const srcFile = path.join(src, readdirSync(src).find((f) => f.endsWith('.json')));
await F.saveReceipt(dir, input('2026-06-01T10:00', 'Mine'), null);
let res = await F.importFiles(dir, [srcFile]);
assert.deepEqual(res, { imported: 1, updated: 0, duplicates: 0, invalid: 0 });
assert.deepEqual(await ids(dir), ['REC-2026-00001:FromOther', 'REC-2026-00002:Mine']);
res = await F.importFiles(dir, [srcFile]);               // same receipt again
assert.equal(res.duplicates, 1);
const edited = { ...JSON.parse(readFileSync(srcFile, 'utf8')), notes: 'edited', updatedAt: '2099-01-01T00:00:00.000Z' };
writeFileSync(path.join(src, 'edited.json'), JSON.stringify(edited));
res = await F.importFiles(dir, [path.join(src, 'edited.json')]);
assert.equal(res.updated, 1);
assert.equal((await F.refresh(dir)).receipts.find((x) => x.key === a.key).notes, 'edited');
writeFileSync(path.join(src, 'junk.json'), '{"hello":1}');
assert.equal((await F.importFiles(dir, [path.join(src, 'junk.json')])).invalid, 1);
// A different receipt that happens to share a key gets a new key instead of overwriting.
const clash = { ...JSON.parse(readFileSync(srcFile, 'utf8')), createdAt: '2030-01-01T00:00:00.000Z', store: { name: 'Clash', location: '' } };
writeFileSync(path.join(src, 'clash.json'), JSON.stringify(clash));
assert.equal((await F.importFiles(dir, [path.join(src, 'clash.json')])).imported, 1);
assert.equal((await F.refresh(dir)).receipts.length, 3);

console.log('all tests passed');
