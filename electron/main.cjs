"use strict";

const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  powerSaveBlocker,
  shell,
} = require("electron");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Vault, seedVault, normalizePath } = require("./vault.cjs");
const { openVault } = require("./open-vault.cjs");
const { ShareServer } = require("./share-server.cjs");

app.setName("Lithos");
const bootLog = (...args) => {
  if (process.env.LITHOS_DEBUG) console.log("[Lithos]", ...args);
};
bootLog("module loaded");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "lithos-asset",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

let sharing = null;
let sharingReady = Promise.resolve();
let shareBlocker = null;
let shareMaintenance = null;
let window = null;
let vault = null;
let recent = [];
let switchQueue = Promise.resolve();
let startupReady = Promise.resolve();
let closeAuthorized = false;
let closePending = false;
let quitRequested = false;
const isDev = process.env.LITHOS_DEV === "1";
const indexPath = path.join(__dirname, "../dist/index.html");

function preferencesPath() {
  return path.join(app.getPath("userData"), "vaults.json");
}

async function loadPreferences() {
  try {
    const preferences = JSON.parse(
      await fsp.readFile(preferencesPath(), "utf8"),
    );
    recent = Array.isArray(preferences.recent)
      ? preferences.recent
          .filter((item) => typeof item === "string")
          .slice(0, 12)
      : [];
  } catch {
    recent = [];
  }
}

async function savePreferences() {
  await fsp.mkdir(app.getPath("userData"), { recursive: true });
  const target = preferencesPath();
  await fsp.writeFile(
    `${target}.tmp`,
    JSON.stringify({ recent }, null, 2),
    "utf8",
  );
  await fsp.rename(`${target}.tmp`, target);
}

async function state() {
  return { ...(await vault.getState()), recent: [...recent], editingPaths: sharing?.collaboration.lockedPaths(vault.id) || [] };
}

function switchVault(root) {
  const result = switchQueue.then(async () => {
    const next = await openVault(new Vault(root));
    if (vault) {
      await vault.queue;
      vault.close();
    }
    vault = next;
    recent = [
      vault.root,
      ...recent.filter((item) => item !== vault.root),
    ].slice(0, 12);
    vault.on("changed", (change) => {
      if (window && !window.isDestroyed())
        window.webContents.send("vault:changed", change);
    });
    vault.on("watch-error", (message) =>
      console.warn("Vault watcher:", message),
    );
    await savePreferences();
    return state();
  });
  switchQueue = result.catch(() => {});
  return result;
}

async function initialVault() {
  await loadPreferences();
  if (process.env.LITHOS_VAULT) {
    const requested = path.resolve(process.env.LITHOS_VAULT);
    await fsp.mkdir(requested, { recursive: true });
    await switchVault(requested);
    return;
  }
  for (const candidate of recent) {
    try {
      await switchVault(candidate);
      return;
    } catch (error) {
      console.warn("Could not reopen vault:", error.message);
    }
  }
  const root = path.join(app.getPath("home"), "Lithos Vault");
  let created = false;
  try {
    await fsp.mkdir(root);
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (created) await seedVault(root);
  await switchVault(root);
}

async function chooseVault() {
  const result = await dialog.showOpenDialog(window, {
    title: "Open a vault",
    buttonLabel: "Open vault",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return switchVault(result.filePaths[0]);
}

async function createVault() {
  const result = await dialog.showSaveDialog(window, {
    title: "Create a new vault",
    buttonLabel: "Create vault",
    nameFieldLabel: "Vault name:",
    defaultPath: path.join(app.getPath("home"), "My Lithos Vault"),
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  if (result.canceled || !result.filePath) return null;
  const root = path.resolve(result.filePath);
  try {
    await fsp.mkdir(root);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("That folder already exists. Use Open vault to open it.");
    throw error;
  }
  await seedVault(root);
  return switchVault(root);
}

async function openExternal(value) {
  if (typeof value !== "string" || value.length > 8192)
    throw new Error("Invalid external URL.");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid external URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Only HTTP and HTTPS links may be opened.");
  await shell.openExternal(url.href);
  return true;
}

function trustedSender(event) {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== event.sender.mainFrame
  )
    return false;
  const url = event.senderFrame.url;
  if (isDev) return new URL(url).origin === "http://127.0.0.1:5173";
  return url.split("#")[0].split("?")[0] === pathToFileURL(indexPath).href;
}

function updateSharingPower() {
  if (window && !window.isDestroyed()) window.webContents.send("vault:changed", { type: "sharing" });
  const active =
    sharing &&
    [...sharing.records.values()].some((record) => sharing.active(record));
  if (active && shareBlocker === null)
    shareBlocker = powerSaveBlocker.start("prevent-app-suspension");
  if (!active && shareBlocker !== null) {
    powerSaveBlocker.stop(shareBlocker);
    shareBlocker = null;
  }
}

async function sharingAction(operation) {
  await sharingReady;
  return { ...(await operation()), currentVaultId: vault.id };
}

function withEditingState(value, selected = vault) {
  return { ...value, editingPaths: sharing?.collaboration.lockedPaths(selected.id) || [] };
}

function localMutation(operation) {
  const selected = vault;
  return sharing.serialize(() => operation(selected));
}

function registerIPC() {
  const methods = {
    getState: state,
    getShares: () => sharingAction(() => sharing.state()),
    copyShareLink: async (token) => {
      await sharingReady;
      const share = sharing.state().shares.find((item) => item.token === token);
      if (!share?.url) throw new Error("공유 링크가 연결되지 않았습니다.");
      clipboard.writeText(share.url);
      return true;
    },
    connectShares: () => sharingAction(() => sharing.connect()),
    createShare: (relative, days, includeFiles) => {
      const selected = vault;
      return sharingAction(() => sharing.create(selected, relative, days, includeFiles));
    },
    updateShare: (token, includeFiles) => {
      const selected = vault;
      return sharingAction(() => sharing.update(selected, token, includeFiles));
    },
    configureShareEditing: (token, enabled, pin) => {
      const selected = vault;
      return sharingAction(() => sharing.collaboration.configure(selected, token, enabled, pin));
    },
    revokeShare: (token) => sharingAction(() => sharing.revoke(token)),
    chooseVault,
    createVault,
    readFile: (relative) => vault.readFile(relative),
    writeFile: (relative, content) => localMutation((selected) => {
      if (sharing.collaboration.lockedPaths(selected.id).includes(normalizePath(relative)))
        throw new Error("공동 편집 중인 노트는 공유 링크의 브라우저에서 편집해 주세요.");
      return selected.writeFile(relative, content);
    }),
    createFile: async (relative, content) => withEditingState(await vault.createFile(relative, content)),
    createFolder: async (relative) => withEditingState(await vault.createFolder(relative)),
    rename: (oldPath, newPath) => localMutation(async (selected) => {
      // Renaming any linked file may rewrite references inside collaborative notes.
      if (sharing.collaboration.lockedPaths(selected.id).length)
        throw new Error("보관함의 공동 편집을 끈 뒤 이름을 변경해 주세요. 연결된 노트의 링크도 함께 갱신됩니다.");
      return withEditingState(await selected.rename(oldPath, newPath), selected);
    }),
    trash: (relative) => localMutation(async (selected) => {
      relative = normalizePath(relative);
      if (sharing.collaboration.lockedPaths(selected.id).some((p) => p === relative || p.startsWith(relative + "/")))
        throw new Error("공동 편집을 끈 뒤 이 노트를 삭제해 주세요.");
      return withEditingState(await selected.trash(relative), selected);
    }),
    getTrash: () => vault.getTrash(),
    restoreTrash: async (id) => withEditingState(await vault.restoreTrash(id)),
    assetUrl: (relative) => vault.assetUrl(relative),
    getWorkspace: () => vault.getWorkspace(),
    saveWorkspace: (workspace) => vault.saveWorkspace(workspace),
    openExternal,
    confirmClose: async () => {
      if (!closePending || !window || window.isDestroyed()) return false;
      await vault.queue;
      closeAuthorized = true;
      if (quitRequested) app.quit();
      else window.close();
      return true;
    },
    cancelClose: () => {
      closePending = false;
      quitRequested = false;
      return true;
    },
    importFiles: async () => {
      const selectedVault = vault;
      const result = await dialog.showOpenDialog(window, {
        title: "Add attachments",
        buttonLabel: "Add files",
        properties: ["openFile", "multiSelections"],
      });
      if (result.canceled) return [];
      if (vault !== selectedVault)
        throw new Error(
          "The vault changed while the file picker was open. Please try again.",
        );
      return vault.importPaths(result.filePaths);
    },
  };
  for (const [method, handler] of Object.entries(methods)) {
    ipcMain.handle(`vault:${method}`, async (event, ...args) => {
      if (!trustedSender(event))
        throw new Error("This request did not come from the application.");
      if (!["confirmClose", "cancelClose"].includes(method)) await startupReady;
      return handler(...args);
    });
  }
}

function createWindow() {
  closeAuthorized = false;
  closePending = false;
  let rendererUnavailable = true;
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 860,
    minHeight: 580,
    title: "Lithos",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 17 },
    backgroundColor: "#1e1e1e",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });
  window.once("ready-to-show", () => window && window.show());
  window.webContents.on("did-finish-load", () => {
    rendererUnavailable = false;
  });
  window.webContents.on(
    "did-fail-load",
    (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame) {
        rendererUnavailable = true;
        if (window) window.show();
      }
    },
  );
  window.webContents.on("render-process-gone", () => {
    rendererUnavailable = true;
  });
  window.on("close", (event) => {
    if (
      !vault ||
      closeAuthorized ||
      rendererUnavailable ||
      window.webContents.isDestroyed()
    )
      return;
    event.preventDefault();
    if (!closePending) {
      closePending = true;
      window.webContents.send("vault:before-close");
    }
  });
  window.on("closed", () => {
    window = null;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const current = window.webContents.getURL().split("#")[0];
    if (url.split("#")[0] !== current) {
      event.preventDefault();
      openExternal(url).catch(() => {});
    }
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  const loading = isDev
    ? window.loadURL("http://127.0.0.1:5173")
    : window.loadFile(indexPath);
  loading.catch((error) => {
    rendererUnavailable = true;
    console.error("Could not load the workspace:", error.message);
  });
}

function createMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Vault…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => {
            if (window && !window.isDestroyed())
              window.webContents.send("vault:command", {
                action: "chooseVault",
              });
          },
        },
        {
          label: "Create Vault…",
          click: () => {
            if (window && !window.isDestroyed())
              window.webContents.send("vault:command", {
                action: "createVault",
              });
          },
        },
        { type: "separator" },
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(isDev ? [{ role: "toggleDevTools" }] : []),
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const hasLock = app.requestSingleInstanceLock();
bootLog("instance lock", hasLock);
if (!hasLock) app.quit();
else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      bootLog("ready, loading vault");
      // Show a window before disk access finishes so native folder-permission
      // prompts and slow File Providers cannot leave an invisible application.
      startupReady = initialVault();
      sharing = new ShareServer({
        directory: path.join(app.getPath("userData"), "shares"),
        webRoot: path.join(__dirname, "../dist-share"),
        onChange: updateSharingPower,
        getVault: () => vault,
      });
      sharingReady = sharing.init();
      sharingReady
        .then(() => {
          updateSharingPower();
          shareMaintenance = setInterval(updateSharingPower, 60000);
          if (
            [...sharing.records.values()].some((record) =>
              sharing.active(record),
            )
          ) {
            void sharing.connect().catch((error) => {
              sharing.tunnel.error = error.message;
            });
          }
        })
        .catch((error) =>
          console.warn("Could not load sharing settings:", error.message),
        );
      registerIPC();
      protocol.handle("lithos-asset", async (request) => {
        try {
          await startupReady;
          const url = new URL(request.url);
          if (url.hostname !== vault.id)
            return new Response("Vault unavailable", { status: 404 });
          const relative = url.pathname
            .slice(1)
            .split("/")
            .map(decodeURIComponent)
            .join("/");
          const absolute = await vault.safePath(relative);
          if (!(await fsp.stat(absolute)).isFile())
            return new Response("Not a file", { status: 400 });
          return net.fetch(pathToFileURL(absolute).href);
        } catch {
          return new Response("Asset unavailable", { status: 404 });
        }
      });
      bootLog("creating menu");
      createMenu();
      bootLog("creating window");
      createWindow();
      app.on("activate", () => {
        if (!BrowserWindow.getAllWindows().length) createWindow();
      });
      await startupReady;
      bootLog("vault ready");
    })
    .catch((error) => {
      bootLog("startup error", error);
      dialog.showErrorBox("Lithos could not start", error.message);
      app.quit();
    });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    quitRequested = true;
  });
  app.on("will-quit", () => {
    clearInterval(shareMaintenance);
    if (sharing) void sharing.close();
    if (vault) vault.close();
  });
}
