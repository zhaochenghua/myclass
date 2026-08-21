const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myclass', {
  getServerConfig: (baseUrl) => ipcRenderer.invoke('server-config', baseUrl),
  listSources: () => ipcRenderer.invoke('list-sources'),
  selectSource: (source) => ipcRenderer.invoke('select-source', source),
  sourceAvailable: (sourceId) => ipcRenderer.invoke('source-available', sourceId),
  setLocalAudioOutput: (enabled) => ipcRenderer.invoke('set-local-audio-output', enabled),
  connectSignaling: (options) => ipcRenderer.invoke('signaling-connect', options),
  sendSignaling: (payload) => ipcRenderer.send('signaling-send', payload),
  disconnectSignaling: () => ipcRenderer.send('signaling-disconnect'),
  getAppVersion: () => ipcRenderer.invoke('app-version'),
  setCursorHighlight: (enabled) => ipcRenderer.invoke('cursor-highlight', enabled),
  hideWindow: () => ipcRenderer.send('window-hide'),
  quit: () => ipcRenderer.send('app-quit'),
  onSignalingMessage: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('signaling-message', listener);
    return () => ipcRenderer.removeListener('signaling-message', listener);
  },
  onSignalingState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('signaling-state', listener);
    return () => ipcRenderer.removeListener('signaling-state', listener);
  },
  onSignalingError: (callback) => {
    const listener = (_event, error) => callback(error);
    ipcRenderer.on('signaling-error', listener);
    return () => ipcRenderer.removeListener('signaling-error', listener);
  },
  onTrayStop: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('tray-stop', listener);
    return () => ipcRenderer.removeListener('tray-stop', listener);
  },
  onTraySwitchSource: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('tray-switch-source', listener);
    return () => ipcRenderer.removeListener('tray-switch-source', listener);
  },
  onToggleCursorHighlight: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('toggle-cursor-highlight', listener);
    return () => ipcRenderer.removeListener('toggle-cursor-highlight', listener);
  }
});
