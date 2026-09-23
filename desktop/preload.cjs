const { contextBridge, ipcRenderer } = require("electron");

// A deliberately tiny bridge: the page can manage notification assets, but it
// never receives a filesystem path or a generic read/write primitive.
contextBridge.exposeInMainWorld("ccdeckNotificationAudio", {
  list: () => ipcRenderer.invoke("ccdeck:notification-audio:list"),
  get: id => ipcRenderer.invoke("ccdeck:notification-audio:get", id),
  put: asset => ipcRenderer.invoke("ccdeck:notification-audio:put", asset),
  remove: id => ipcRenderer.invoke("ccdeck:notification-audio:remove", id),
});
