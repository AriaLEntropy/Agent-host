const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentbusPairing", {
  ready: () => ipcRenderer.send("pairing:ready"),
  close: () => ipcRenderer.send("pairing:close"),
  regenerate: () => ipcRenderer.send("pairing:regenerate"),
  copy: (text) => ipcRenderer.send("pairing:copy", text),
  testRelay: (relay) => ipcRenderer.invoke("pairing:test-relay", relay),
  saveRelay: (relay, publicRelayUrl) =>
    ipcRenderer.invoke("pairing:save-relay", { relay, publicRelayUrl }),
  onView: (listener) => {
    ipcRenderer.on("pairing:view", (_event, view) => listener(view));
  },
});
