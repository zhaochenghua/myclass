const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  desktopCapturer,
  ipcMain,
  nativeImage,
  screen,
  session
} = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocket } = require('ws');

const DEFAULT_SERVER_URL = 'http://10.30.13.1/myclass';
const APP_ICON_PATH = path.join(__dirname, 'assets', 'icon.ico');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let selectedSourceId = null;
let selectedSourceType = null;
let signaling = null;
let localAudioMutedByApp = false;
let localAudioPreviousMute = null;
let audioStateFilePath = null;
let restoringAudioForQuit = false;
let cursorHighlightWindow = null;
let cursorHighlightTimer = null;

const AUDIO_ENDPOINT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MyClassAudioEndpoint {
    private enum DataFlow { Render = 0, Capture = 1, All = 2 }
    private enum Role { Console = 0, Multimedia = 1, Communications = 2 }
    private enum ClsCtx { All = 23 }

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator { }

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(DataFlow dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(DataFlow dataFlow, Role role, out IMMDevice device);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice {
        int Activate(ref Guid iid, ClsCtx clsCtx, IntPtr activationParams, out IAudioEndpointVolume endpoint);
        int OpenPropertyStore(int access, out IntPtr properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [ComImport]
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume {
        int RegisterControlChangeNotify(IntPtr notify);
        int UnregisterControlChangeNotify(IntPtr notify);
        int GetChannelCount(out uint count);
        int SetMasterVolumeLevel(float level, ref Guid eventContext);
        int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
        int GetMasterVolumeLevel(out float level);
        int GetMasterVolumeLevelScalar(out float level);
        int SetChannelVolumeLevel(uint channel, float level, ref Guid eventContext);
        int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
        int GetChannelVolumeLevel(uint channel, out float level);
        int GetChannelVolumeLevelScalar(uint channel, out float level);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
        int GetVolumeStepInfo(out uint step, out uint stepCount);
        int VolumeStepUp(ref Guid eventContext);
        int VolumeStepDown(ref Guid eventContext);
        int QueryHardwareSupport(out uint supportMask);
        int GetHardwareSupport(out uint supportMask);
        int GetVolumeRange(out float minDb, out float maxDb, out float incrementDb);
    }

    private static IAudioEndpointVolume GetEndpoint() {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice device = null;
        try {
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia, out device));
            var iid = typeof(IAudioEndpointVolume).GUID;
            IAudioEndpointVolume endpoint;
            Marshal.ThrowExceptionForHR(device.Activate(ref iid, ClsCtx.All, IntPtr.Zero, out endpoint));
            return endpoint;
        } finally {
            if (device != null) Marshal.ReleaseComObject(device);
            Marshal.ReleaseComObject(enumerator);
        }
    }

    public static bool GetMute() {
        var endpoint = GetEndpoint();
        try {
            bool mute;
            Marshal.ThrowExceptionForHR(endpoint.GetMute(out mute));
            return mute;
        } finally {
            Marshal.ReleaseComObject(endpoint);
        }
    }

    public static void SetMute(bool mute) {
        var endpoint = GetEndpoint();
        try {
            var context = Guid.Empty;
            Marshal.ThrowExceptionForHR(endpoint.SetMute(mute, ref context));
        } finally {
            Marshal.ReleaseComObject(endpoint);
        }
    }
}
'@
`;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', () => {
  showMainWindow();
});

function normalizeBaseUrl(value) {
  const input = String(value || DEFAULT_SERVER_URL).trim();
  return (input || DEFAULT_SERVER_URL).replace(/\/+$/, '');
}

function getAudioStatePath() {
  if (!audioStateFilePath) {
    audioStateFilePath = path.join(app.getPath('userData'), 'local-audio-state.json');
  }
  return audioStateFilePath;
}

function saveAudioState() {
  try {
    const target = getAudioStatePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({
      mutedByApp: localAudioMutedByApp,
      previousMute: localAudioPreviousMute
    }), 'utf8');
  } catch (error) {
    console.warn('[Audio] failed to save mute state:', error.message);
  }
}

function clearAudioState() {
  try {
    fs.rmSync(getAudioStatePath(), { force: true });
  } catch (error) {
    console.warn('[Audio] failed to clear mute state:', error.message);
  }
}

function runAudioPowerShell(action, mute = false) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('本机声音控制目前只支持 Windows'));
  }

  const actionScript = action === 'get'
    ? '$muted = [MyClassAudioEndpoint]::GetMute(); Write-Output $muted'
    : `[MyClassAudioEndpoint]::SetMute(${mute ? '$true' : '$false'})`;
  const encodedCommand = Buffer.from(
    `${AUDIO_ENDPOINT_SCRIPT}\n${actionScript}\n`,
    'utf16le'
  ).toString('base64');

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedCommand
      ],
      { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || '无法控制 Windows 声音输出').trim()));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

async function setLocalAudioOutput(enabled) {
  if (process.platform !== 'win32') {
    throw new Error('本机声音控制目前只支持 Windows');
  }

  if (enabled) {
    if (localAudioMutedByApp) {
      await runAudioPowerShell('set', localAudioPreviousMute ?? false);
      localAudioMutedByApp = false;
      localAudioPreviousMute = null;
      clearAudioState();
    }
    return { ok: true, enabled: true };
  }

  if (!localAudioMutedByApp) {
    const currentMute = await runAudioPowerShell('get');
    localAudioPreviousMute = /^true$/i.test(currentMute);
  }
  await runAudioPowerShell('set', true);
  localAudioMutedByApp = true;
  saveAudioState();
  return { ok: true, enabled: false };
}

async function restoreInterruptedAudioState() {
  try {
    const state = JSON.parse(fs.readFileSync(getAudioStatePath(), 'utf8'));
    if (state?.mutedByApp && typeof state.previousMute === 'boolean') {
      await runAudioPowerShell('set', state.previousMute);
    }
    clearAudioState();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[Audio] failed to restore previous mute state:', error.message);
    }
  }
}

function toWebSocketUrl(baseUrl, wsPath = '/myclass/ws') {
  const parsed = new URL(baseUrl);
  const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${parsed.host}${wsPath.startsWith('/') ? wsPath : `/${wsPath}`}`;
}

async function fetchServerConfig(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  const response = await fetch(`${normalized}/api/config`, {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`服务器配置请求失败（HTTP ${response.status}）`);
  }
  const config = await response.json();
  return {
    baseUrl: normalized,
    config,
    wsUrl: toWebSocketUrl(normalized, config.wsPath || '/myclass/ws')
  };
}

function sendRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function restoreLocalAudioOutput() {
  if (!localAudioMutedByApp || typeof localAudioPreviousMute !== 'boolean') {
    return;
  }
  await runAudioPowerShell('set', localAudioPreviousMute);
  localAudioMutedByApp = false;
  localAudioPreviousMute = null;
  clearAudioState();
}

function sendSignalingMessage(payload) {
  if (!signaling || !signaling.socket || signaling.socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  signaling.socket.send(JSON.stringify(payload));
  return true;
}

function closeSignaling({ notify = true } = {}) {
  if (!signaling) {
    return;
  }
  const current = signaling;
  current.manualClose = true;
  if (current.reconnectTimer) {
    clearTimeout(current.reconnectTimer);
    current.reconnectTimer = null;
  }
  if (current.socket) {
    current.socket.close(1000, 'client closed');
  }
  signaling = null;
  if (notify) {
    sendRenderer('signaling-state', { state: 'closed' });
  }
}

function scheduleReconnect(connection) {
  if (connection.manualClose || signaling !== connection || connection.reconnectTimer) {
    return;
  }
  const delay = Math.min(10000, 1000 * Math.max(1, connection.attempts));
  connection.reconnectTimer = setTimeout(() => {
    connection.reconnectTimer = null;
    if (connection.manualClose || signaling !== connection) {
      return;
    }
    openSignalingSocket(connection);
  }, delay);
}

function openSignalingSocket(connection) {
  if (connection.manualClose || signaling !== connection) {
    return;
  }
  if (connection.socket) {
    connection.socket.removeAllListeners();
    connection.socket = null;
  }

  sendRenderer('signaling-state', { state: 'connecting' });
  const socket = new WebSocket(connection.wsUrl, {
    handshakeTimeout: 10000,
    perMessageDeflate: false
  });
  connection.socket = socket;

  socket.on('open', () => {
    if (signaling !== connection) {
      socket.close();
      return;
    }
    connection.attempts = 0;
    sendRenderer('signaling-state', { state: 'connected' });
    sendSignalingMessage({ type: 'teacher.join', code: connection.code });
  });

  socket.on('message', (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      return;
    }

    sendRenderer('signaling-message', message);
    if (message.type === 'teacher.kicked' || message.type === 'room.expired' || message.type === 'viewer.disconnected') {
      connection.manualClose = true;
    }
  });

  socket.on('error', (error) => {
    sendRenderer('signaling-error', { message: error.message || '信令连接失败' });
  });

  socket.on('close', () => {
    if (signaling !== connection) {
      return;
    }
    connection.socket = null;
    sendRenderer('signaling-state', { state: 'closed' });
    if (!connection.manualClose) {
      connection.attempts += 1;
      scheduleReconnect(connection);
    }
  });
}

async function connectSignaling({ baseUrl, code }) {
  closeSignaling({ notify: false });
  const server = await fetchServerConfig(baseUrl);
  signaling = {
    ...server,
    code: String(code),
    socket: null,
    attempts: 0,
    reconnectTimer: null,
    manualClose: false
  };
  openSignalingSocket(signaling);
  return server;
}

function getCaptureSourceType(source) {
  return String(source.id || '').startsWith('window:') ? 'window' : 'screen';
}

async function listCaptureSources() {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 240, height: 135 },
    fetchWindowIcons: true
  });
  const mappedSources = sources
    .filter((source) => source.name?.trim())
    .map((source) => ({
      id: source.id,
      type: getCaptureSourceType(source),
      name: source.name.trim(),
      displayId: source.display_id || null,
      thumbnail: source.thumbnail.toDataURL()
    }));
  if (!selectedSourceId || !mappedSources.some((source) => source.id === selectedSourceId)) {
    const defaultSource = mappedSources.find((source) => source.type === 'screen') || mappedSources[0];
    selectedSourceId = defaultSource?.id || null;
    selectedSourceType = defaultSource?.type || null;
  } else {
    selectedSourceType = mappedSources.find((source) => source.id === selectedSourceId)?.type || null;
  }
  return {
    sources: mappedSources,
    selectedId: selectedSourceId,
    selectedType: selectedSourceType
  };
}

async function isCaptureSourceAvailable(sourceId) {
  if (!sourceId) {
    return false;
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 1, height: 1 },
    fetchWindowIcons: false
  });
  return sources.some((source) => source.id === sourceId);
}

function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 160, height: 90 },
      fetchWindowIcons: true
    }).then((sources) => {
      const source = sources.find((item) => item.id === selectedSourceId)
        || sources.find((item) => getCaptureSourceType(item) === 'screen')
        || sources[0];
      if (!source) {
        callback({});
        return;
      }
      const selection = { video: source };
      // Electron's Windows loopback source carries the computer's output audio.
      if (process.platform === 'win32') {
        selection.audio = 'loopback';
      }
      callback(selection);
    }).catch(() => callback({}));
  });
}

// --- Cursor highlight: a transparent, always-on-top, click-through window that
// draws a colored ring around the cursor. Because it lives on the shared screen,
// getDisplayMedia captures it, so students see the cursor emphasized on the big display.
const CURSOR_RING_SIZE = 96;

function destroyCursorHighlightWindow() {
  if (cursorHighlightTimer) {
    clearInterval(cursorHighlightTimer);
    cursorHighlightTimer = null;
  }
  if (cursorHighlightWindow && !cursorHighlightWindow.isDestroyed()) {
    cursorHighlightWindow.destroy();
  }
  cursorHighlightWindow = null;
}

function moveCursorHighlightWindow() {
  if (!cursorHighlightWindow || cursorHighlightWindow.isDestroyed()) {
    return;
  }
  // getCursorScreenPoint() and setPosition() both use DIP coordinates.
  // No work-area clamping: the ring may extend past the screen edge so the
  // cursor can still reach the very edge of the display.
  const cursor = screen.getCursorScreenPoint();
  const size = CURSOR_RING_SIZE;
  cursorHighlightWindow.setPosition(Math.round(cursor.x - size / 2), Math.round(cursor.y - size / 2));
}

function setCursorHighlight(enabled) {
  if (enabled) {
    if (!cursorHighlightWindow || cursorHighlightWindow.isDestroyed()) {
      cursorHighlightWindow = new BrowserWindow({
        width: CURSOR_RING_SIZE,
        height: CURSOR_RING_SIZE,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        focusable: false,
        fullscreenable: false,
        webPreferences: {
          offscreen: false,
          backgroundThrottling: false
        }
      });
      cursorHighlightWindow.setIgnoreMouseEvents(true, { forward: true });
      cursorHighlightWindow.setVisibleOnAllWorkspaces(true);
      cursorHighlightWindow.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<!doctype html><html><head><meta charset="utf-8"><style>' +
            'html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden}' +
            '.ring{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}' +
            /* The dot marks the cursor hotspot (pointer tip), which sits at the window center. */
            '.dot{width:10px;height:10px;border-radius:50%;background:rgba(255,59,48,.75);box-shadow:0 0 4px rgba(255,59,48,.45)}' +
            '.circle{width:56px;height:56px;border-radius:50%;border:4px solid rgba(255,59,48,.55);box-shadow:0 0 10px rgba(255,59,48,.3);display:flex;align-items:center;justify-content:center}' +
            '</style></head><body><div class="ring"><div class="circle"><div class="dot"></div></div></div></body></html>'
          )
      );
      cursorHighlightWindow.once('ready-to-show', () => {
        if (cursorHighlightWindow && !cursorHighlightWindow.isDestroyed()) {
          moveCursorHighlightWindow();
          cursorHighlightWindow.show();
        }
      });
      cursorHighlightWindow.on('closed', () => {
        cursorHighlightWindow = null;
      });
    } else {
      moveCursorHighlightWindow();
      cursorHighlightWindow.show();
    }
    if (!cursorHighlightTimer) {
      cursorHighlightTimer = setInterval(moveCursorHighlightWindow, 33);
    }
  } else {
    destroyCursorHighlightWindow();
  }
}

function createTrayIcon() {
  return nativeImage.createFromPath(APP_ICON_PATH);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function openSourceSwitcher() {
  showMainWindow();
  sendRenderer('tray-switch-source');
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('MyClass 投屏');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '切换投屏窗口', click: openSourceSwitcher },
    { label: '强调鼠标位置', click: () => sendRenderer('toggle-cursor-highlight') },
    { type: 'separator' },
    {
      label: '断开投屏',
      click: () => sendRenderer('tray-stop')
    },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', openSourceSwitcher);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 314,
    height: 680,
    minWidth: 314,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#07131a',
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle('server-config', (_event, baseUrl) => fetchServerConfig(baseUrl));
  ipcMain.handle('list-sources', () => listCaptureSources());
  ipcMain.handle('select-source', (_event, source) => {
    selectedSourceId = String(source?.id || '') || null;
    selectedSourceType = source?.type === 'window' ? 'window' : 'screen';
    return { id: selectedSourceId, type: selectedSourceType };
  });
  ipcMain.handle('source-available', (_event, sourceId) => isCaptureSourceAvailable(String(sourceId || '')));
  ipcMain.handle('set-local-audio-output', (_event, enabled) => setLocalAudioOutput(Boolean(enabled)));
  ipcMain.handle('signaling-connect', (_event, options) => connectSignaling(options));
  ipcMain.on('signaling-send', (_event, payload) => sendSignalingMessage(payload));
  ipcMain.on('signaling-disconnect', () => closeSignaling());
  ipcMain.handle('app-version', () => app.getVersion());
  ipcMain.handle('cursor-highlight', (_event, enabled) => {
    setCursorHighlight(Boolean(enabled));
    return { enabled: Boolean(enabled) };
  });
  ipcMain.on('window-hide', () => mainWindow?.hide());
  ipcMain.on('app-quit', () => {
    isQuitting = true;
    closeSignaling({ notify: false });
    app.quit();
  });
}

app.setAppUserModelId('cn.edu.nb3.myclass.windows');

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    await restoreInterruptedAudioState();
    installDisplayMediaHandler();
    registerIpc();
    createWindow();
    createTray();
    app.on('activate', showMainWindow);
  });
}

app.on('before-quit', (event) => {
  if (localAudioMutedByApp && !restoringAudioForQuit) {
    event.preventDefault();
    restoringAudioForQuit = true;
    restoreLocalAudioOutput()
      .catch((error) => console.warn('[Audio] failed to restore output on quit:', error.message))
      .finally(() => app.quit());
    return;
  }
  isQuitting = true;
  closeSignaling({ notify: false });
  destroyCursorHighlightWindow();
});

app.on('window-all-closed', (event) => {
  // Keep the tray application alive on Windows and macOS.
  event.preventDefault();
});
