// Desktop window for the app. It shows the live website in a window, nothing more:
// the page cannot reach the computer, links to other sites open in the normal browser,
// and the window refuses to navigate away from the app's own address.
// Settings (app name, address) are in app.json, written by Shipyard add-shell.
const { app, BrowserWindow, Menu, session, shell, nativeTheme } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const config = require("./app.json");

const LIVE_URL = new URL(config.url);
// Only the app's own site may load inside the window (the address with and without "www.").
const APP_HOSTS = new Set(config.hosts && config.hosts.length ? config.hosts : [LIVE_URL.hostname]);
// Try the app on your own computer: SHIPYARD_DESKTOP_URL=http://localhost:3000 npm start (ignored in the installed app).
const DEV_URL = !app.isPackaged && /^http:\/\/localhost(:\d+)?(\/|$)/.test(process.env.SHIPYARD_DESKTOP_URL || "")
  ? new URL(process.env.SHIPYARD_DESKTOP_URL)
  : null;
const OFFLINE_URL = pathToFileURL(path.join(__dirname, "offline.html")).toString();
const START_URL = (DEV_URL || LIVE_URL).toString();

// Things the website may ask the computer for. Everything else is refused. Add "media" for camera or microphone.
const ALLOWED_PERMISSIONS = new Set(config.permissions || []);

function isAppUrl(raw) {
  try {
    const u = new URL(raw);
    if (DEV_URL && u.origin === DEV_URL.origin) return true;
    return u.protocol === "https:" && APP_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function openInBrowser(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:") shell.openExternal(u.toString());
  } catch {
    // not an address: ignore
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 360,
    minHeight: 480,
    title: config.name,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? config.darkBackground : config.lightBackground,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  win.once("ready-to-show", () => win.show());

  // A link that opens a new window: the app's own pages stay in this window, everything else goes to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) win.loadURL(url);
    else openInBrowser(url);
    return { action: "deny" };
  });

  // Clicking a link or a redirect that would leave the app: open it in the browser instead.
  win.webContents.on("will-navigate", (event, url) => {
    if (url === OFFLINE_URL) return;
    if (!isAppUrl(url)) {
      event.preventDefault();
      openInBrowser(url);
    }
  });

  // A server redirect (an address that sends you on to another site) must not load another site inside the window either.
  win.webContents.on("will-redirect", (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && !isAppUrl(url) && url !== OFFLINE_URL) {
      event.preventDefault();
      openInBrowser(url);
    }
  });

  // The website could not load (no internet): show the offline page. Its button tries again.
  win.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) win.loadFile(path.join(__dirname, "offline.html"));
  });

  win.loadURL(START_URL);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]));

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingOrigin);
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Never let a page add its own embedded views.
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

// One window only: opening the app again brings the first one forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
