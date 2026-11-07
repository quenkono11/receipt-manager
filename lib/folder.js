'use strict';
// All work on the receipt folder (no Electron, so it can be tested with plain Node).
// Rules: every receipt file is named <ID>_<key>.json. The key never changes; the ID is recomputed from the
// purchase order whenever the folder is read, so the numbers stay correct when older receipts are added,
// dates change, receipts are deleted, or files arrive from another computer.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const R = require('./receipts');

const STORES_FILE = 'stores.json';

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file);
}

// Reads every .json file. Files that are not valid receipts are reported and never touched.
async function scan(dir) {
  const entries = []; const problems = [];
  let names;
  try { names = await fsp.readdir(dir); } catch (e) { return { entries, problems, error: e.code || 'ERROR' }; }
  for (const file of names) {
    if (!file.toLowerCase().endsWith('.json') || file === STORES_FILE) continue;
    try {
      const data = JSON.parse(await fsp.readFile(path.join(dir, file), 'utf8'));
      const err = R.validateReceipt(data);
      if (err) throw new Error(err);
      const { receipt, migrated } = R.migrate(data);
      entries.push({ file, receipt, migrated });
    } catch (e) { problems.push({ file, message: e.message }); }
  }
  return { entries, problems };
}

// Two files with the same key are the same receipt (for example after an interrupted rename, or a copy that
// was edited elsewhere): the newer version wins, the rest are stale.
function dedupe(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.receipt.key)) groups.set(e.receipt.key, []);
    groups.get(e.receipt.key).push(e);
  }
  const keep = []; const stale = [];
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const ua = a.receipt.updatedAt || ''; const ub = b.receipt.updatedAt || '';
      if (ua !== ub) return ua < ub ? 1 : -1;
      const ca = a.file === R.fileNameFor(a.receipt.id, a.receipt.key) ? 0 : 1;
      const cb = b.file === R.fileNameFor(b.receipt.id, b.receipt.key) ? 0 : 1;
      return ca - cb || (a.file < b.file ? -1 : 1);
    });
    keep.push(list[0]);
    stale.push(...list.slice(1));
  }
  return { keep, stale };
}

// Brings the folder into its canonical state (migrates 1.0 files, renumbers, renames, removes stale copies)
// and returns the receipts. Running it again changes nothing.
async function refresh(dir) {
  const { entries, problems, error } = await scan(dir);
  if (error) return { receipts: [], problems, error, migrated: 0, writes: 0 };
  const { keep, stale } = dedupe(entries);
  const plan = R.planNumbers(keep.map((e) => e.receipt));
  const receipts = []; const writes = []; const oldFiles = new Set(stale.map((e) => e.file));
  let migrated = 0;
  for (const e of keep) {
    const p = plan.get(e.receipt.key);
    const next = { ...e.receipt, id: p.id };
    if (e.migrated) migrated++;
    if (e.migrated || e.receipt.id !== p.id || e.file !== p.file) {
      writes.push({ file: p.file, data: next });
      if (e.file !== p.file) oldFiles.add(e.file);
    }
    receipts.push(next);
  }
  // Write first, delete afterwards: if this is interrupted, the next run finds duplicates and cleans up.
  for (const w of writes) await writeJsonAtomic(path.join(dir, w.file), w.data);
  const targets = new Set(writes.map((w) => w.file));
  for (const f of oldFiles) {
    if (targets.has(f)) continue;
    try { await fsp.unlink(path.join(dir, f)); } catch { /* already gone */ }
  }
  return { receipts, problems, migrated, writes: writes.length + [...oldFiles].filter((f) => !targets.has(f)).length };
}

// Creates (existingKey null) or updates a receipt, then renumbers. Returns the saved receipt with its final ID.
async function saveReceipt(dir, input, existingKey) {
  const { receipts } = await refresh(dir);
  let prev = null; let key;
  if (existingKey) {
    prev = receipts.find((r) => r.key === existingKey) || null;
    if (!prev) throw new Error('receipt no longer exists');
    key = prev.key;
  } else {
    key = R.newKey(new Set(receipts.map((r) => r.key)));
  }
  const date = String(input.purchasedAt || '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) throw new Error('invalid purchase date');
  // The ID written here is provisional; refresh() below assigns the real one.
  const id = prev ? prev.id : R.formatId(date.slice(0, 4), 99999);
  const receipt = R.sanitizeReceipt(input, id, key, prev);
  await writeJsonAtomic(path.join(dir, R.fileNameFor(id, key)), receipt);
  const after = await refresh(dir);
  return after.receipts.find((r) => r.key === key) || receipt;
}

async function deleteReceipt(dir, key) {
  if (!R.KEY_RE.test(String(key))) throw new Error('invalid key');
  const { entries } = await scan(dir);
  for (const e of entries.filter((x) => x.receipt.key === key)) await fsp.unlink(path.join(dir, e.file));
  await refresh(dir);
}

// Adds receipt files from elsewhere. Same receipt (same key and creation time): the newer version wins.
// Different receipt with the same key (very unlikely): it gets a new key. IDs are always assigned by refresh().
async function importFiles(dir, files) {
  const out = { imported: 0, updated: 0, duplicates: 0, invalid: 0 };
  const { receipts } = await refresh(dir);
  const byKey = new Map(receipts.map((r) => [r.key, r]));
  for (const file of files) {
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
      const err = R.validateReceipt(raw);
      if (err) throw new Error(err);
      const data = { ...R.migrate(raw).receipt };
      const existing = byKey.get(data.key);
      if (existing) {
        if (existing.createdAt && existing.createdAt === data.createdAt) {
          if ((data.updatedAt || '') > (existing.updatedAt || '')) {
            await writeJsonAtomic(path.join(dir, R.fileNameFor(data.id, data.key)), data);
            byKey.set(data.key, data); out.updated++;
          } else out.duplicates++;
          continue;
        }
        data.key = R.newKey(new Set(byKey.keys()));
      }
      byKey.set(data.key, data);
      await writeJsonAtomic(path.join(dir, R.fileNameFor(data.id, data.key)), data);
      out.imported++;
    } catch { out.invalid++; }
  }
  await refresh(dir);
  return out;
}

const isReceiptFileName = (n) => R.FILE_RE.test(n) || n === STORES_FILE;

module.exports = { STORES_FILE, writeJsonAtomic, scan, refresh, saveReceipt, deleteReceipt, importFiles, isReceiptFileName };
