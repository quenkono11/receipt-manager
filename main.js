'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const chokidar = require('chokidar');
const F = require('./lib/folder');

const STORES_FILE = F.STORES_FILE;
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
  return { folder: config.folder, language: lang(), folderOk: await folderOk(config.folder), version: app.getVersion() };
}

// ---------- file helpers ----------
const writeJsonAtomic = F.writeJsonAtomic;

// All changes to the receipt folder run one after another, so renumbering never overlaps with a save or import.
let queue = Promise.resolve();
const exclusive = (fn) => { const run = queue.then(() => fn()); queue = run.catch(() => {}); return run; };

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
    const files = (await fsp.readdir(old)).filter(F.isReceiptFileName);
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

ipcMain.handle('receipts:list', () => {
  if (!config.folder) return { receipts: [], problems: [] };
  // Reading also migrates 1.0 files and keeps IDs in order, so it runs in the same queue as writes.
  return exclusive(() => F.refresh(config.folder));
});

ipcMain.handle('receipts:save', (_e, input, existingKey) => exclusive(async () => {
  try { return { receipt: await F.saveReceipt(config.folder, input, existingKey) }; }
  catch (e) { return { error: e.message }; }
}));

ipcMain.handle('receipts:delete', (_e, key) => exclusive(async () => {
  try { await F.deleteReceipt(config.folder, key); return { ok: true }; }
  catch (e) { return { error: e.message }; }
}));

ipcMain.handle('receipts:import', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: msg().importTitle,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled) return { canceled: true };
  return exclusive(() => F.importFiles(config.folder, res.filePaths));
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
