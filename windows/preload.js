const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myclass', {
  getServerConfig: (baseUrl) => ipcRenderer.invoke('server-config', baseUrl),
  listDisplays: () => ipcRenderer.invoke('list-displays'),
  selectDisplay: (displayId) => ipcRenderer.invoke('select-display', displayId),
  setLocalAudioOutput: (enabled) => ipcRenderer.invoke('set-local-audio-output', enabled),
  connectSignaling: (options) => ipcRenderer.invoke('signaling-connect', options),
  sendSignaling: (payload) => ipcRenderer.send('signaling-send', payload),
  disconnectSignaling: () => ipcRenderer.send('signaling-disconnect'),
  hideWindow: () => ipcRenderer.send('window-hide'),
  showWindow: () => ipcRenderer.send('window-show'),
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
  }
});
