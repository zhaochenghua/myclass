const { contextBridge, ipcRenderer } = require('electron');

// Preload for the cursor-highlight overlay window. Only exposes the cursor
// position channel; the overlay page itself is a plain data: URL with no
// node access, so nothing else is bridged.
contextBridge.exposeInMainWorld('cursorOverlay', {
  onUpdate: (callback) => {
    const listener = (_event, point) => callback(point);
    ipcRenderer.on('cursor-update', listener);
    return () => ipcRenderer.removeListener('cursor-update', listener);
  }
});
