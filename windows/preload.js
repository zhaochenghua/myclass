const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myclass', {
  getServerConfig: (baseUrl) => ipcRenderer.invoke('server-config', baseUrl),
  listSources: () => ipcRenderer.invoke('list-sources'),
  selectSource: (source) => ipcRenderer.invoke('select-source', source),
  sourceAvailable: (sourceId) => ipcRenderer.invoke('source-available', sourceId),
    findFollowWindow: () => ipcRenderer.invoke('find-follow-window'),
  setLocalAudioOutput: (enabled) => ipcRenderer.invoke('set-local-audio-output', enabled),
  connectSignaling: (options) => ipcRenderer.invoke('signaling-connect', options),
  sendSignaling: (payload) => ipcRenderer.send('signaling-send', payload),
  disconnectSignaling: () => ipcRenderer.send('signaling-disconnect'),
  getAppVersion: () => ipcRenderer.invoke('app-version'),
  setCursorHighlight: (enabled) => ipcRenderer.invoke('cursor-highlight', enabled),
  getInkScreenSource: () => ipcRenderer.invoke('ink-screen-source'),
  setScreenInk: (enabled) => ipcRenderer.invoke('screen-ink', enabled),
  toggleInkPointer: () => ipcRenderer.invoke('screen-ink-pointer'),
  stopScreenInk: () => ipcRenderer.send('screen-ink-stop'),
  onToggleScreenInk: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('toggle-screen-ink', listener);
    return () => ipcRenderer.removeListener('toggle-screen-ink', listener);
  },
  onScreenInkState: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('screen-ink-state', listener);
    return () => ipcRenderer.removeListener('screen-ink-state', listener);
  },
  onDesktopToolError: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('desktop-tool-error', listener);
    return () => ipcRenderer.removeListener('desktop-tool-error', listener);
  },
  setTrayStatus: (text) => ipcRenderer.send('tray-status', text),
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
  },
  onCursorScene: (callback) => {
    const listener = (_event, scene) => callback(scene);
    ipcRenderer.on('cursor-scene', listener);
    return () => ipcRenderer.removeListener('cursor-scene', listener);
  }
});
