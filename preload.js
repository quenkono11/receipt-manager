'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  getState: () => call('app:getState'),
  setLanguage: (lang) => call('app:setLanguage', lang),
  chooseFolder: () => call('folder:choose'),
  openFolder: () => call('folder:open'),
  listReceipts: () => call('receipts:list'),
  saveReceipt: (input, existingKey) => call('receipts:save', input, existingKey),
  deleteReceipt: (key) => call('receipts:delete', key),
  importReceipts: () => call('receipts:import'),
  listStores: () => call('stores:list'),
  upsertStore: (store) => call('stores:upsert', store),
  deleteStore: (id) => call('stores:delete', id),
  exportCsv: (text, name) => call('export:csv', text, name),
  onDataChanged: (cb) => ipcRenderer.on('data:changed', () => cb()),
});
