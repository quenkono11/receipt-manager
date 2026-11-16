'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  getState: () => call('app:getState'),
  setLanguage: (lang) => call('app:setLanguage', lang),
  setTheme: (theme) => call('app:setTheme', theme),
  setCheckUpdates: (on) => call('app:setCheckUpdates', on),
  openRelease: () => call('update:open'),
  chooseFolder: () => call('folder:choose'),
  openFolder: () => call('folder:open'),
  listReceipts: () => call('receipts:list'),
  saveReceipt: (input, existingKey) => call('receipts:save', input, existingKey),
  deleteReceipt: (key) => call('receipts:delete', key),
  importReceipts: () => call('receipts:import'),
  listStores: () => call('stores:list'),
  upsertStore: (store) => call('stores:upsert', store),
  deleteStore: (id) => call('stores:delete', id),
  listCategories: () => call('categories:list'),
  upsertCategory: (cat) => call('categories:upsert', cat),
  deleteCategory: (id) => call('categories:delete', id),
  exportCsv: (text, name) => call('export:csv', text, name),
  onDataChanged: (cb) => ipcRenderer.on('data:changed', () => cb()),
  onUpdateInfo: (cb) => ipcRenderer.on('update:info', (_e, info) => cb(info)),
});
