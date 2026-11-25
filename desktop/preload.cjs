// The deck's desktop integrations: window chrome and its own custom
// notification sounds and voices (#1207), which the desktop app keeps in its
// data folder rather than the page's IndexedDB.
//
// CommonJS because the window is sandboxed, and a sandboxed preload is not an
// ES module and may require nothing but a short list that includes "electron".
// Deliberately small: audio calls by opaque id, caption colours, a menu, the
// page's zoom, whether the terminal pane has the keys, and the system's
// folder dialog, which returns only the folder the person chose in it, plus
// native paths for File objects explicitly dropped by the user.
// No path from the page, window handle, generic IPC, or generic read or write
// primitive. main.mjs checks who is calling and notification-audio-store.mjs
// checks what they sent, so nothing here is trusted to have done either.
const { contextBridge, ipcRenderer, webFrame, webUtils } = require("electron");

contextBridge.exposeInMainWorld("ccdeckNotificationAudio", {
  list: () => ipcRenderer.invoke("ccdeck:notification-audio:list"),
  get: id => ipcRenderer.invoke("ccdeck:notification-audio:get", id),
  put: asset => ipcRenderer.invoke("ccdeck:notification-audio:put", asset),
  remove: id => ipcRenderer.invoke("ccdeck:notification-audio:remove", id),
});

// The terminal panel's one question to the app: whether its pane has the
// keys, so the menu's Ctrl shortcuts (reload, close, quit, copy, select all)
// step aside while they belong to the program in the pane. A boolean, nothing
// else.
contextBridge.exposeInMainWorld("ccdeckTerminal", {
  keys: owned => ipcRenderer.invoke("ccdeck:terminal:keys", owned === true),
});

// New session's "Choose another folder…" (internal #106): opens the system's
// folder dialog and hears back the folder the person chose, or null. It takes
// no argument, so the page cannot name a folder for the app to open or read.
contextBridge.exposeInMainWorld("ccdeckFolder", {
  choose: () => ipcRenderer.invoke("ccdeck:folder:choose"),
});

// File objects supplied by a user drop only. webUtils rejects fabricated
// values and returns no path for browser-created files; no filesystem reads.
contextBridge.exposeInMainWorld("ccdeckFiles", {
  paths: files => {
    if (!Array.isArray(files) || files.length > 64) return [];
    try { return files.map(file => webUtils.getPathForFile(file)); }
    catch { return []; }
  },
});

// No window handle or generic IPC is exposed to the page. It may also read its
// own zoom, a number: the traffic lights stand in window points, and the bar
// keeps their room in its own CSS px (src/web/desktop-chrome.ts).
if (!process.argv.includes("--ccdeck-native-chrome")) contextBridge.exposeInMainWorld("ccdeckWindow", {
  platform: process.platform,
  colors: value => ipcRenderer.invoke("ccdeck:window:colors", value),
  menu: () => ipcRenderer.invoke("ccdeck:window:menu"),
  zoom: () => webFrame.getZoomFactor(),
});
