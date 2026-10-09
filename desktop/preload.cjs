// The deck's desktop integrations: window chrome and its own custom
// notification sounds and voices (#1207), which the desktop app keeps in its
// data folder rather than the page's IndexedDB.
//
// CommonJS because the window is sandboxed, and a sandboxed preload is not an
// ES module and may require nothing but a short list that includes "electron".
// Deliberately small: audio calls by opaque id, caption colours and a menu.
// No path, window handle, generic IPC, or generic read or write
// primitive. main.mjs checks who is calling and notification-audio-store.mjs
// checks what they sent, so nothing here is trusted to have done either.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ccdeckNotificationAudio", {
  list: () => ipcRenderer.invoke("ccdeck:notification-audio:list"),
  get: id => ipcRenderer.invoke("ccdeck:notification-audio:get", id),
  put: asset => ipcRenderer.invoke("ccdeck:notification-audio:put", asset),
  remove: id => ipcRenderer.invoke("ccdeck:notification-audio:remove", id),
});

// No window handle or generic IPC is exposed to the page.
if (!process.argv.includes("--ccdeck-native-chrome")) contextBridge.exposeInMainWorld("ccdeckWindow", {
  platform: process.platform,
  colors: value => ipcRenderer.invoke("ccdeck:window:colors", value),
  menu: () => ipcRenderer.invoke("ccdeck:window:menu"),
});
