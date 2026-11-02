'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const chokidar = require('chokidar');
const { FILE_RE, validateReceipt, sanitizeReceipt, newId } = require('./lib/receipts');

const STORES_FILE = 'stores.json';
let mainWindow = null;
let watcher = null;
let config = { folder: null, language: null };

// Texts for native dialogs (the web UI has its own translations).
const MSG = {
  en: {
    chooseFolder: 'Choose receipt folder',
    existingTitle: 'Existing receipts found',
    existingText: 'The previous folder contains receipts. What should happen to them?',
    move: 'Move to new folder', copy: 'Copy to new folder', leave: 'Leave them where they are',
    importTitle: 'Select receipt files', csvTitle: 'Export CSV',
  },
  de: {
    chooseFolder: 'Belegordner wählen',
    existingTitle: 'Vorhandene Belege gefunden',
    existingText: 'Der bisherige Ordner enthält Belege. Was soll damit passieren?',
    move: 'In neuen Ordner verschieben', copy: 'In neuen Ordner kopieren', leave: 'Dort belassen',
    importTitle: 'Belegdateien auswählen', csvTitle: 'CSV exportieren',
  },
};

// ---------- config ----------
const configPath = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; } catch { /* first start */ }
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}
const lang = () => config.language || (app.getLocale().toLowerCase().startsWith('de') ? 'de' : 'en');
const msg = () => MSG[lang()];

async function folderOk(folder) {
  if (!folder) return false;
  try { await fsp.access(folder, fs.constants.R_OK | fs.constants.W_OK); return true; } catch { return false; }
}
async function getState() {
  return { folder: config.folder, language: lang(), folderOk: await folderOk(config.folder) };
}

// ---------- file helpers ----------
async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file);
}

async function loadAll() {
  const receipts = [];
  const problems = [];
  let names;
  try { names = await fsp.readdir(config.folder); } catch (e) { return { receipts, problems, error: e.code || 'ERROR', names: [] }; }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json') || name === STORES_FILE) continue;
    try {
      if (!FILE_RE.test(name)) throw new Error('file name is not a receipt ID (REC-YYYY-XXXXX.json)');
      const data = JSON.parse(await fsp.readFile(path.join(config.folder, name), 'utf8'));
      const err = validateReceipt(data);
      if (err) throw new Error(err);
      if (name !== `${data.id}.json`) throw new Error('file name does not match the ID inside');
      receipts.push(data);
    } catch (e) {
      problems.push({ file: name, message: e.message });
    }
  }
  return { receipts, problems, names };
}

function takenIds(names, receipts) {
  const set = new Set(receipts.map(r => r.id));
  names.forEach(n => set.add(n.replace(/\.json$/i, '')));
  return set;
}

// ---------- stores ----------
async function readStores() {
  try {
    const data = JSON.parse(await fsp.readFile(path.join(config.folder, STORES_FILE), 'utf8'));
    return Array.isArray(data.stores) ? data.stores.filter(s => s && s.id && s.name) : [];
  } catch { return []; }
}
const writeStores = (stores) =>
  writeJsonAtomic(path.join(config.folder, STORES_FILE), { schemaVersion: 1, stores });

// ---------- watcher ----------
function stopWatcher() {
  if (watcher) { watcher.close().catch(() => {}); watcher = null; }
}
function startWatcher() {
  stopWatcher();
  if (!config.folder) return;
  let timer = null;
  const notify = (p) => {
    if (!p.toLowerCase().endsWith('.json')) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('data:changed');
    }, 250);
  };
  watcher = chokidar.watch(config.folder, {
    depth: 0,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  watcher.on('add', notify).on('change', notify).on('unlink', notify).on('error', () => {});
}

// ---------- IPC ----------
ipcMain.handle('app:getState', getState);

ipcMain.handle('app:setLanguage', async (_e, value) => {
  config.language = value === 'de' ? 'de' : 'en';
  saveConfig();
  return getState();
});

ipcMain.handle('folder:choose', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: msg().chooseFolder,
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: config.folder || undefined,
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  const target = res.filePaths[0];
  if (!(await folderOk(target))) return { error: 'not-writable' };

  const old = config.folder;
  if (old && path.resolve(old) !== path.resolve(target) && (await folderOk(old))) {
    const files = (await fsp.readdir(old)).filter(n => FILE_RE.test(n) || n === STORES_FILE);
    if (files.length) {
      const m = msg();
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'question', title: m.existingTitle, message: m.existingText,
        buttons: [m.move, m.copy, m.leave], defaultId: 1, cancelId: 2,
      });
      if (choice.response < 2) {
        for (const name of files) {
          try {
            await fsp.copyFile(path.join(old, name), path.join(target, name), fs.constants.COPYFILE_EXCL);
            if (choice.response === 0) await fsp.unlink(path.join(old, name));
          } catch { /* already exists in target: keep the target's version */ }
        }
      }
    }
  }
  config.folder = target;
  saveConfig();
  startWatcher();
  return { state: await getState() };
});

ipcMain.handle('folder:open', () => (config.folder ? shell.openPath(config.folder) : ''));

ipcMain.handle('receipts:list', async () => {
  if (!config.folder) return { receipts: [], problems: [] };
  const { receipts, problems, error } = await loadAll();
  return { receipts, problems, error };
});

ipcMain.handle('receipts:save', async (_e, input, existingId) => {
  try {
    const { receipts, names } = await loadAll();
    let id = existingId;
    let prev = null;
    if (id) {
      prev = receipts.find(r => r.id === id) || null;
    } else {
      id = newId(String(input.purchasedAt).slice(0, 4), takenIds(names, receipts));
    }
    const receipt = sanitizeReceipt(input, id, prev);
    await writeJsonAtomic(path.join(config.folder, `${id}.json`), receipt);
    return { receipt };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('receipts:delete', async (_e, id) => {
  if (!FILE_RE.test(`${id}.json`)) return { error: 'invalid id' };
  try { await fsp.unlink(path.join(config.folder, `${id}.json`)); return { ok: true }; }
  catch (e) { return { error: e.message }; }
});

ipcMain.handle('receipts:import', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: msg().importTitle,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled) return { canceled: true };
  const out = { imported: 0, updated: 0, duplicates: 0, renumbered: 0, invalid: 0 };
  const { receipts, names } = await loadAll();
  const byId = new Map(receipts.map(r => [r.id, r]));
  const taken = takenIds(names, receipts);
  for (const file of res.filePaths) {
    try {
      const data = JSON.parse(await fsp.readFile(file, 'utf8'));
      const err = validateReceipt(data);
      if (err) throw new Error(err);
      const existing = byId.get(data.id);
      if (existing) {
        if (existing.createdAt && existing.createdAt === data.createdAt) {
          // Same receipt, possibly edited on another computer: keep the newer version.
          if ((data.updatedAt || '') > (existing.updatedAt || '')) {
            await writeJsonAtomic(path.join(config.folder, `${data.id}.json`), data);
            byId.set(data.id, data); out.updated++;
          } else { out.duplicates++; }
          continue;
        }
        // Different receipt that happens to use the same ID: give it a new one.
        data.id = newId(data.purchasedAt.slice(0, 4), taken);
        out.renumbered++;
      }
      taken.add(data.id);
      byId.set(data.id, data);
      await writeJsonAtomic(path.join(config.folder, `${data.id}.json`), data);
      out.imported++;
    } catch { out.invalid++; }
  }
  return out;
});

ipcMain.handle('stores:list', async () => (config.folder ? readStores() : []));

ipcMain.handle('stores:upsert', async (_e, store) => {
  const stores = await readStores();
  const name = String(store.name || '').trim();
  const location = String(store.location || '').trim();
  if (!name) return stores;
  if (store.id) {
    const s = stores.find(x => x.id === store.id);
    if (s) { s.name = name; s.location = location; }
  } else if (!stores.some(s => s.name.toLowerCase() === name.toLowerCase() &&
      (s.location || '').toLowerCase() === location.toLowerCase())) {
    stores.push({ id: 's_' + crypto.randomBytes(5).toString('hex'), name, location });
  }
  stores.sort((a, b) => a.name.localeCompare(b.name));
  await writeStores(stores);
  return stores;
});

ipcMain.handle('stores:delete', async (_e, id) => {
  const stores = (await readStores()).filter(s => s.id !== id);
  await writeStores(stores);
  return stores;
});

ipcMain.handle('export:csv', async (_e, text, name) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: msg().csvTitle,
    defaultPath: name,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  await fsp.writeFile(res.filePath, text, 'utf8');
  return { ok: true };
});

// ---------- window ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 760, minWidth: 880, minHeight: 600,
    title: 'Receipt Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  loadConfig();
  createWindow();
  startWatcher();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { stopWatcher(); if (process.platform !== 'darwin') app.quit(); });
