const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentbusSettings", {
  ready: () => ipcRenderer.send("settings:ready"),
  close: () => ipcRenderer.send("settings:close"),
  onView: (listener) => ipcRenderer.on("settings:view", (_event, view) => listener(view)),
  testRelay: (relay) => ipcRenderer.invoke("settings:test-relay", relay),
  probeRelay: (relay) => ipcRenderer.invoke("settings:probe-relay", relay),
  detectRelay: () => ipcRenderer.invoke("settings:detect-relay"),
  saveRelay: (relay, publicRelayUrl) =>
    ipcRenderer.invoke("settings:save-relay", { relay, publicRelayUrl }),
  toggleAgent: (agentId, enabled) =>
    ipcRenderer.send("settings:toggle-agent", { agentId, enabled }),
  showAgentError: (agentId) => ipcRenderer.send("settings:show-agent-error", agentId),
  refreshAgents: () => ipcRenderer.send("settings:refresh-agents"),
  copyProblems: () => ipcRenderer.send("settings:copy-problems"),
  repair: () => ipcRenderer.send("settings:repair"),
  unpair: () => ipcRenderer.invoke("settings:unpair"),
  chooseProjectRoot: () => ipcRenderer.invoke("settings:choose-project-root"),
  setAllowProjects: (allow) => ipcRenderer.invoke("settings:set-allow-projects", allow),
  setStartup: (enabled) => ipcRenderer.invoke("settings:set-startup", enabled),
  openLogs: () => ipcRenderer.send("settings:open-logs"),
  exportDiagnostics: () => ipcRenderer.invoke("settings:export-diagnostics"),
  copyDiagnostics: () => ipcRenderer.send("settings:copy-diagnostics"),
});
