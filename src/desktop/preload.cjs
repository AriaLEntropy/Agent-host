const { contextBridge, ipcRenderer } = require("electron");

// 弹层只拿得到这几件事，页面没有 Node 权限
contextBridge.exposeInMainWorld("agentbus", {
  ready: () => ipcRenderer.send("panel:ready"),
  toggle: (agentId, enabled) => ipcRenderer.send("panel:toggle", { agentId, enabled }),
  entry: (id) => ipcRenderer.send("panel:entry", id),
  showError: (agentId) => ipcRenderer.send("panel:error", agentId),
  copyProblems: () => ipcRenderer.send("panel:copy-problems"),
  refresh: () => ipcRenderer.send("panel:refresh"),
  quit: () => ipcRenderer.send("panel:quit"),
  close: () => ipcRenderer.send("panel:close"),
  resize: (height) => ipcRenderer.send("panel:resize", height),
  onView: (listener) => {
    ipcRenderer.on("panel:view", (_event, view, theme) => listener(view, theme));
  },
});
