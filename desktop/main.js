// NomuHub CRM desktop app (Windows), Anton, 15 Oct 2026.
//
// A thin window around the live dashboard (crm.nomuhub.com): it holds no copy
// of the dashboard, so every change pushed to the site shows up here too.
// Two kinds of update, each offered with an "Update now / Later" pop-up:
//   1. Dashboard updates (most of them): the app watches the site's ETag,
//      which changes whenever a new version of the page is deployed, and
//      offers to reload. "Later" asks again in an hour.
//   2. App updates (rare: icon, name, window behaviour): a new installer
//      published as a GitHub Release is found by electron-updater, downloaded
//      and installed on "Update now".

const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

const DASH = process.env.NOMUHUB_URL || 'https://crm.nomuhub.com';
const ORIGIN = new URL(DASH).origin;
const CHECK_EVERY_MS = 5 * 60 * 1000; // dashboard version check
const SNOOZE_MS = 60 * 60 * 1000; // "Later"
const APP_CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // installer check

let win = null;
let loadedTag = null; // ETag of the page currently shown
let snoozed = { tag: null, until: 0 };
let asking = false;

async function siteTag() {
  try {
    const res = await fetch(DASH, { method: 'HEAD', cache: 'no-store' });
    return res.headers.get('etag') || res.headers.get('last-modified');
  } catch (e) {
    return null; // offline: nothing to compare
  }
}

async function ask(title, message, detail) {
  if (!win || asking) return false;
  asking = true;
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title,
      message,
      detail,
      buttons: ['Update now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      icon: path.join(__dirname, 'build', 'icon.png'),
    });
    return response === 0;
  } finally {
    asking = false;
  }
}

async function checkDashboard() {
  const tag = await siteTag();
  if (!tag || !loadedTag || tag === loadedTag) return;
  if (snoozed.tag === tag && Date.now() < snoozed.until) return;
  const yes = await ask('New update available',
    'A new version of the NomuHub CRM dashboard is available.',
    'Update now to see the latest changes, or choose Later and you will be reminded in an hour.');
  if (yes) {
    loadedTag = tag;
    win.webContents.reloadIgnoringCache();
  } else {
    snoozed = { tag, until: Date.now() + SNOOZE_MS };
  }
}

function setupAppUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = false;
  autoUpdater.on('update-available', async (info) => {
    const yes = await ask('New app update available',
      `NomuHub CRM ${info.version} is available.`,
      'Update now downloads it and restarts the app. Later keeps this version until next time.');
    if (yes) autoUpdater.downloadUpdate();
  });
  autoUpdater.on('update-downloaded', () => autoUpdater.quitAndInstall(false, true));
  autoUpdater.on('error', (err) => console.error('app update:', err && err.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, APP_CHECK_EVERY_MS);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'NomuHub CRM',
    backgroundColor: '#14223d',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.maximize();
  win.loadURL(DASH);

  // Remember which version of the page is on screen.
  win.webContents.on('did-finish-load', async () => {
    if (win.webContents.getURL().startsWith(ORIGIN)) loadedTag = await siteTag();
  });

  // No connection: a friendly page with a retry button instead of a blank window.
  win.webContents.on('did-fail-load', (e, code, desc, failedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3) win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: DASH } });
  });

  // Links to other sites (monday, WeTravel, Meta...) open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN) && !url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { label: 'Help', submenu: [{ label: 'Check for updates', click: () => { checkDashboard(); if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {}); } }, { label: `Version ${app.getVersion()}`, enabled: false }] },
    ]));
    createWindow();
    setInterval(checkDashboard, CHECK_EVERY_MS);
    setupAppUpdates();
  });
  app.on('window-all-closed', () => app.quit());
}
