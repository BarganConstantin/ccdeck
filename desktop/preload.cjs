// The one thing the deck's page can ask the app for: its own custom
// notification sounds and voices (#1207), which the desktop app keeps in its
// data folder rather than the page's IndexedDB.
//
// CommonJS because the window is sandboxed, and a sandboxed preload is not an
// ES module and may require nothing but a short list that includes "electron".
// Deliberately tiny: four calls by opaque id, no path, no generic read or write
// primitive. main.mjs checks who is calling and notification-audio-store.mjs
// checks what they sent, so nothing here is trusted to have done either.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ccdeckNotificationAudio", {
  list: () => ipcRenderer.invoke("ccdeck:notification-audio:list"),
  get: id => ipcRenderer.invoke("ccdeck:notification-audio:get", id),
  put: asset => ipcRenderer.invoke("ccdeck:notification-audio:put", asset),
  remove: id => ipcRenderer.invoke("ccdeck:notification-audio:remove", id),
});
