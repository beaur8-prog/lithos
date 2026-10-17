"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const invoke =
  (method) =>
  (...args) =>
    ipcRenderer.invoke(`vault:${method}`, ...args);

contextBridge.exposeInMainWorld(
  "vault",
  Object.freeze({
    getShares: invoke("getShares"),
    copyShareLink: invoke("copyShareLink"),
    connectShares: invoke("connectShares"),
    createShare: invoke("createShare"),
    updateShare: invoke("updateShare"),
    configureShareEditing: invoke("configureShareEditing"),
    revokeShare: invoke("revokeShare"),
    getState: invoke("getState"),
    chooseVault: invoke("chooseVault"),
    createVault: invoke("createVault"),
    readFile: invoke("readFile"),
    writeFile: invoke("writeFile"),
    createFile: invoke("createFile"),
    createFolder: invoke("createFolder"),
    rename: invoke("rename"),
    trash: invoke("trash"),
    getTrash: invoke("getTrash"),
    restoreTrash: invoke("restoreTrash"),
    assetUrl: invoke("assetUrl"),
    getWorkspace: invoke("getWorkspace"),
    saveWorkspace: invoke("saveWorkspace"),
    openExternal: invoke("openExternal"),
    importFiles: invoke("importFiles"),
    confirmClose: invoke("confirmClose"),
    cancelClose: invoke("cancelClose"),
    onCommand(callback) {
      if (typeof callback !== "function")
        throw new TypeError("Expected a callback.");
      const listener = (_event, command) => callback(command);
      ipcRenderer.on("vault:command", listener);
      return () => ipcRenderer.removeListener("vault:command", listener);
    },
    onBeforeClose(callback) {
      if (typeof callback !== "function")
        throw new TypeError("Expected a callback.");
      const listener = () => callback();
      ipcRenderer.on("vault:before-close", listener);
      return () => ipcRenderer.removeListener("vault:before-close", listener);
    },
    onChanged(callback) {
      if (typeof callback !== "function")
        throw new TypeError("Expected a callback.");
      const listener = (_event, change) => callback(change);
      ipcRenderer.on("vault:changed", listener);
      return () => ipcRenderer.removeListener("vault:changed", listener);
    },
  }),
);
