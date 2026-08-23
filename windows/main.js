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
let knownNonPresentationSourceId = null;
let lastAutoSwitchFromId = null;
// DIP bounds of the currently captured window, refreshed at most once per
// second (the PowerShell query is the only way to get an arbitrary HWND's
// on-screen rect; windows move rarely, so a stale rect for <1s is fine).
let selectedWindowRectCache = null;
let lastWindowRectQueryAt = 0;
let windowRectQueryInFlight = false;

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

const WINDOW_ENUMERATOR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Diagnostics;

public static class MyClassWindowEnumerator {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    private static string JsonEscape(string value) {
        if (value == null) return "";
        var sb = new StringBuilder();
        foreach (char c in value) {
            switch (c) {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 32) { sb.Append("\\u").Append(((int)c).ToString("x4")); }
                    else { sb.Append(c); }
                    break;
            }
        }
        return sb.ToString();
    }

    public static string EnumerateJson() {
        var result = new StringBuilder();
        result.Append("[");
        bool first = true;
        EnumWindows((hWnd, lParam) => {
            var title = new StringBuilder(512);
            GetWindowTextW(hWnd, title, title.Capacity);
            var className = new StringBuilder(256);
            GetClassNameW(hWnd, className, className.Capacity);
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            RECT rect;
            if (!GetWindowRect(hWnd, out rect)) {
                rect.Left = rect.Top = rect.Right = rect.Bottom = 0;
            }
            string processName = "";
            try {
                processName = Process.GetProcessById((int)pid).ProcessName;
            } catch { }
            if (!first) result.Append(",");
            first = false;
            result.Append("{\"hwnd\":").Append(hWnd.ToInt64())
                  .Append(",\"title\":\"").Append(JsonEscape(title.ToString())).Append("\"")
                  .Append(",\"className\":\"").Append(JsonEscape(className.ToString())).Append("\"")
                  .Append(",\"pid\":").Append(pid)
                  .Append(",\"processName\":\"").Append(JsonEscape(processName)).Append("\"")
                  .Append(",\"visible\":").Append(IsWindowVisible(hWnd) ? "true" : "false")
                  .Append(",\"iconic\":").Append(IsIconic(hWnd) ? "true" : "false")
                  .Append(",\"x\":").Append(rect.Left)
                  .Append(",\"y\":").Append(rect.Top)
                  .Append(",\"width\":").Append(Math.Max(0, rect.Right - rect.Left))
                  .Append(",\"height\":").Append(Math.Max(0, rect.Bottom - rect.Top))
                  .Append("}");
            return true;
        }, IntPtr.Zero);
        result.Append("]");
        return result.ToString();
    }
}
'@
`;


// Returns the on-screen bounds of one window in PHYSICAL pixels together with
// the window's DPI. The query process explicitly opts into per-monitor v2 DPI
// awareness so GetWindowRect/DwmGetWindowAttribute return true physical pixels
// (no DPI virtualization); the main process divides by dpi/96 to get DIP,
// matching screen.getCursorScreenPoint()/display.bounds which are DIP.
const WINDOW_RECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MyClassWindowRect {
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

    public static string GetRectJson(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) {
            return "{\"ok\":false}";
        }
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        RECT rect;
        if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT))) != 0) {
            if (!GetWindowRect(hWnd, out rect)) {
                return "{\"ok\":false}";
            }
        }
        uint dpi = GetDpiForWindow(hWnd);
        if (dpi == 0) { dpi = 96; }
        return "{\"ok\":true,\"x\":" + rect.Left + ",\"y\":" + rect.Top +
               ",\"width\":" + Math.Max(0, rect.Right - rect.Left) +
               ",\"height\":" + Math.Max(0, rect.Bottom - rect.Top) +
               ",\"dpi\":" + dpi + "}";
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

function parseWindowHandle(sourceId) {
  const match = /^window:(\d+)/.exec(String(sourceId || ''));
  return match ? Number.parseInt(match[1], 10) : null;
}

function normalizeProcessName(name) {
  return String(name || '').toLowerCase().replace(/\.exe$/, '');
}

function isPresentationProcess(win) {
  const name = normalizeProcessName(win?.processName);
    if (name === 'powerpnt' || name === 'pptview' || name === 'wpppresentation' || name.startsWith('wpp')) {
    return true;
  }
  if (name.startsWith('wps')) {
    const title = String(win?.title || '');
    return /WPS\s*演示|演示文稿|\.pptx?|\.dps/i.test(title);
  }
  return false;
}

function isPresentationShowWindow(win) {
  if (!win || !win.visible) {
    return false;
  }
  const className = String(win.className || '').toLowerCase();
  const title = String(win.title || '');
  // Microsoft PowerPoint runs the slide show in a top-level window with the
  // "screenClass" window class; WPS Presentation (wpp.exe) can be recognised by
  // the slide-show title below even though its window class is not public.
  if (className === 'screenclass') {
    return true;
  }
  if (/幻灯片放映|slide show|全屏放映|演示放映|演讲者视图/i.test(title)) {
    return true;
  }
  if (/^WPS\s*演示\s*[-–]\s*\[/i.test(title)) return true;
  return false;
}

function isFullscreenWindow(win) {
  if (!win || !win.width || !win.height) {
    return false;
  }
  const displays = screen.getAllDisplays();
  return displays.some((display) => {
    const scale = display.scaleFactor || 1;
    const bounds = display.bounds;
    const physical = {
      x: Math.round(bounds.x * scale),
      y: Math.round(bounds.y * scale),
      width: Math.round(bounds.width * scale),
      height: Math.round(bounds.height * scale)
    };
    const dipMatch = Math.abs(win.x - bounds.x) <= 24
      && Math.abs(win.y - bounds.y) <= 24
      && Math.abs(win.width - bounds.width) <= 24
      && Math.abs(win.height - bounds.height) <= 24;
    const physicalMatch = Math.abs(win.x - physical.x) <= 24
      && Math.abs(win.y - physical.y) <= 24
      && Math.abs(win.width - physical.width) <= 24
      && Math.abs(win.height - physical.height) <= 24;
      const workArea = display.workArea || bounds;
      const workAreaMatch = Math.abs(win.x - workArea.x) <= 24
        && Math.abs(win.y - workArea.y) <= 24
        && Math.abs(win.width - workArea.width) <= 24
        && Math.abs(win.height - workArea.height) <= 24;
    return dipMatch || physicalMatch || workAreaMatch;
  });
}

function getWindowEnumeratorAssemblyPath() {
  const assemblyPath = path.join(app.getPath('userData'), 'myclass-window-enumerator-v1.dll');
  fs.mkdirSync(path.dirname(assemblyPath), { recursive: true });
  return assemblyPath;
}

function extractWindowEnumeratorCSharp() {
  // The C# source is stored as a PowerShell Add-Type here-string so it can be
  // compiled once and cached as a DLL. Strip the PowerShell wrapper to reuse it.
  return WINDOW_ENUMERATOR_SCRIPT
    .replace(/^\s*\$ErrorActionPreference\s*=\s*'Stop'\s*\r?\n/, '')
    .replace(/^\s*Add-Type -TypeDefinition @'\s*\r?\n/, '')
    .replace(/\r?\n'@\s*$/, '');
}

function buildWindowEnumeratorCommand() {
  const assemblyPath = getWindowEnumeratorAssemblyPath();
  const escapedAssemblyPath = assemblyPath.replace(/'/g, "''");
  const csharpSource = extractWindowEnumeratorCSharp();
  return `$ErrorActionPreference = 'Stop'
$assemblyPath = '${escapedAssemblyPath}'

$compiled = $false
if (-not (Test-Path $assemblyPath)) {

$source = @'
${csharpSource}
'@
  Add-Type -TypeDefinition $source -OutputAssembly $assemblyPath

  $compiled = $true
}
if (-not $compiled) {
  Add-Type -Path $assemblyPath
}
[Console]::Out.Write([MyClassWindowEnumerator]::EnumerateJson())`;
}



function runWindowEnumerator() {
  if (process.platform !== 'win32') {
    return Promise.resolve([]);
  }
  const encodedCommand = Buffer.from(
    buildWindowEnumeratorCommand(),
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
      { windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || '无法枚举 Windows 窗口').trim()));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(Array.isArray(parsed) ? parsed : []);
        } catch {
          reject(new Error('窗口枚举结果解析失败'));
        }
      }
    );
  });
}

function getWindowRectAssemblyPath() {
  const assemblyPath = path.join(app.getPath('userData'), 'myclass-window-rect-v1.dll');
  fs.mkdirSync(path.dirname(assemblyPath), { recursive: true });
  return assemblyPath;
}

function extractWindowRectCSharp() {
  // Same PowerShell-wrapper stripping as the window enumerator above.
  return WINDOW_RECT_SCRIPT
    .replace(/^\s*\$ErrorActionPreference\s*=\s*'Stop'\s*\r?\n/, '')
    .replace(/^\s*Add-Type -TypeDefinition @'\s*\r?\n/, '')
    .replace(/\r?\n'@\s*$/, '');
}

function buildWindowRectCommand(hwnd) {
  const assemblyPath = getWindowRectAssemblyPath();
  const escapedAssemblyPath = assemblyPath.replace(/'/g, "''");
  const csharpSource = extractWindowRectCSharp();
  return `$ErrorActionPreference = 'Stop'
$assemblyPath = '${escapedAssemblyPath}'

$compiled = $false
if (-not (Test-Path $assemblyPath)) {

$source = @'
${csharpSource}
'@
  Add-Type -TypeDefinition $source -OutputAssembly $assemblyPath

  $compiled = $true
}
if (-not $compiled) {
  Add-Type -Path $assemblyPath
}
[Console]::Out.Write([MyClassWindowRect]::GetRectJson([IntPtr]${hwnd}))`;
}

function runWindowRectQuery(hwnd) {
  if (process.platform !== 'win32' || !hwnd) {
    return Promise.resolve(null);
  }
  const encodedCommand = Buffer.from(
    buildWindowRectCommand(hwnd),
    'utf16le'
  ).toString('base64');
  return new Promise((resolve) => {
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
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

async function findFollowWindowSource() {
  if (process.platform !== 'win32' || selectedSourceType !== 'window' || !selectedSourceId) {
    return null;
  }
  const selectedHwnd = parseWindowHandle(selectedSourceId);
  if (!selectedHwnd) {
    return null;
  if (knownNonPresentationSourceId === selectedSourceId) {
    return null;
  }

  }

  if (knownNonPresentationSourceId === selectedSourceId) {
    return null;
  }

  let windows;
  try {
    windows = await runWindowEnumerator();
  } catch (error) {
    console.warn('[FollowWindow] failed to enumerate windows:', error.message);
    return null;
  }

  const selectedWindow = windows.find((win) => win.hwnd === selectedHwnd);
  if (!selectedWindow || !isPresentationProcess(selectedWindow)) {
      knownNonPresentationSourceId = selectedSourceId;
    return null;
  }

  const selectedProcess = normalizeProcessName(selectedWindow.processName);

  const candidates = windows
    .filter((win) => win.hwnd !== selectedHwnd
        && win.hwnd !== lastAutoSwitchFromId
      && win.visible
      
        && !win.iconic
      && (selectedProcess.startsWith('wps') || selectedProcess.startsWith('wpp')
        ? (normalizeProcessName(win.processName).startsWith('wps') || normalizeProcessName(win.processName).startsWith('wpp'))
        : normalizeProcessName(win.processName) === selectedProcess)
      && (isPresentationShowWindow(win) || isFullscreenWindow(win)))
    .sort((a, b) => (b.width * b.height) - (a.width * a.height));

  const candidate = candidates[0];
  if (!candidate) {
    return null;
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false
    });
    const source = sources.find((item) => parseWindowHandle(item.id) === candidate.hwnd);
    if (!source) {
      return null;
    }
      lastAutoSwitchFromId = selectedHwnd;
    return { id: source.id, type: 'window', name: source.name };
  } catch (error) {
    console.warn('[FollowWindow] failed to list capture sources:', error.message);
    return null;
  }
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

// --- Cursor highlight: a transparent, always-on-top, click-through overlay that
// draws a colored ring around the cursor. The overlay window is created ONCE and
// covers the whole virtual screen; the ring is drawn INSIDE it (CSS transform)
// at the cursor position reported over IPC. We deliberately never move the window:
// on Windows with fractional DPI scaling (125%/150%) or mixed-DPI monitors,
// repeatedly calling setPosition() makes Chromium round the DIP->physical pixel
// conversion (electron#10862), and while getDisplayMedia is capturing, DWM can
// present the moving transparent window at stale positions - the ring then slowly
// drifts toward the bottom-right and away from the real cursor. A static overlay
// cannot drift: the ring always sits exactly on the latest cursor coordinate.
// Because the overlay lives on the shared screen, getDisplayMedia captures it,
// so students still see the cursor emphasized on the big display.
const CURSOR_RING_SIZE = 96;
const CURSOR_POLL_INTERVAL_MS = 16;
const CURSOR_OVERLAY_PRELOAD = path.join(__dirname, 'overlay-preload.js');

function getVirtualScreenBounds() {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function destroyCursorHighlightWindow() {
  if (cursorHighlightTimer) {
    clearInterval(cursorHighlightTimer);
    cursorHighlightTimer = null;
  }
  screen.removeListener('display-metrics-changed', onCursorDisplayChanged);
  screen.removeListener('display-added', onCursorDisplayChanged);
  screen.removeListener('display-removed', onCursorDisplayChanged);
  if (cursorHighlightWindow && !cursorHighlightWindow.isDestroyed()) {
    cursorHighlightWindow.destroy();
  }
  cursorHighlightWindow = null;
}

function sendCursorPosition() {
  if (!cursorHighlightWindow || cursorHighlightWindow.isDestroyed()) {
    return;
  }
  // getCursorScreenPoint() uses DIP coordinates, same space as the overlay bounds.
  // The overlay origin (top-left of the virtual screen, possibly negative on
  // multi-monitor setups) is sent with every update so the renderer can map the
  // absolute cursor point onto its own page coordinates.
  const cursor = screen.getCursorScreenPoint();
  const bounds = getVirtualScreenBounds();
  cursorHighlightWindow.webContents.send('cursor-update', {
    x: cursor.x,
    y: cursor.y,
    ox: bounds.x,
    oy: bounds.y
  });
}

function onCursorDisplayChanged() {
  if (!cursorHighlightWindow || cursorHighlightWindow.isDestroyed()) {
    return;
  }
  // Re-cover the (possibly changed) virtual screen; the renderer keeps following
  // the latest origin it receives with every cursor update.
  cursorHighlightWindow.setBounds(getVirtualScreenBounds());
  sendCursorPosition();
}

function parseDisplayIdFromSourceId(sourceId) {
  const match = /^screen:(\d+):/.exec(String(sourceId || ''));
  return match ? match[1] : null;
}

// Returns the capture source's on-screen region in DIP, the same coordinate
// space as screen.getCursorScreenPoint(). Screen sources map to the selected
// display's bounds; window sources map to the window's DIP bounds (physical
// rect from a DPI-aware Win32 query divided by dpi/96, exact on single-monitor
// and uniform-DPI setups, best-effort on mixed-DPI multi-monitor).
async function getCaptureRegionDIP() {
  if (selectedSourceType === 'window') {
    const hwnd = parseWindowHandle(selectedSourceId);
    if (!hwnd) {
      selectedWindowRectCache = null;
      return null;
    }
    const now = Date.now();
    if (!selectedWindowRectCache || (now - lastWindowRectQueryAt > 1000 && !windowRectQueryInFlight)) {
      windowRectQueryInFlight = true;
      lastWindowRectQueryAt = now;
      try {
        const rect = await runWindowRectQuery(hwnd);
        if (rect && rect.ok && rect.width > 0 && rect.height > 0) {
          const scale = (rect.dpi && rect.dpi > 0 ? rect.dpi : 96) / 96;
          selectedWindowRectCache = {
            x: rect.x / scale,
            y: rect.y / scale,
            width: rect.width / scale,
            height: rect.height / scale
          };
        }
      } catch {
        // Keep the previous cache; the next tick retries after the throttle.
      } finally {
        windowRectQueryInFlight = false;
      }
    }
    return selectedWindowRectCache;
  }
  const displays = screen.getAllDisplays();
  if (displays.length === 0) {
    return null;
  }
  const displayId = parseDisplayIdFromSourceId(selectedSourceId);
  const cursor = screen.getCursorScreenPoint();
  const display = displays.find((item) => String(item.id) === displayId)
    // Fallback: the display the cursor is on (the screen source is usually the
    // one being used), then the primary display.
    || displays.find((item) => cursor.x >= item.bounds.x && cursor.x < item.bounds.x + item.bounds.width
      && cursor.y >= item.bounds.y && cursor.y < item.bounds.y + item.bounds.height)
    || displays[0];
  return {
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height
  };
}

// Pushes the cursor point plus the capture region to the main window so the
// renderer can composite the emphasis ring into the video frames (window
// capture does not include the desktop overlay the ring is drawn in).
function sendCursorScene() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  getCaptureRegionDIP()
    .then((region) => {
      if (!region || !mainWindow || mainWindow.isDestroyed()) {
        return;
      }
      const cursor = screen.getCursorScreenPoint();
      const inside = cursor.x >= region.x && cursor.x <= region.x + region.width
        && cursor.y >= region.y && cursor.y <= region.y + region.height;
      mainWindow.webContents.send('cursor-scene', {
        cursor: { x: cursor.x, y: cursor.y },
        region: { x: region.x, y: region.y, width: region.width, height: region.height },
        inside
      });
    })
    .catch(() => {});
}

function createCursorOverlayHtml() {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden}' +
    '#ring{position:absolute;left:0;top:0;width:' + CURSOR_RING_SIZE + 'px;height:' + CURSOR_RING_SIZE + 'px;' +
    'transform:translate(-50%,-50%);will-change:transform;opacity:0;pointer-events:none;' +
    'display:flex;align-items:center;justify-content:center}' +
    /* The dot marks the cursor hotspot (pointer tip), which sits at the ring center. */
    '.dot{width:10px;height:10px;border-radius:50%;background:rgba(255,59,48,.75);box-shadow:0 0 4px rgba(255,59,48,.45)}' +
    '.circle{width:56px;height:56px;border-radius:50%;border:4px solid rgba(255,59,48,.55);box-shadow:0 0 10px rgba(255,59,48,.3);display:flex;align-items:center;justify-content:center}' +
    '</style></head><body><div id="ring"><div class="circle"><div class="dot"></div></div></div>' +
    '<script>' +
    'var ring = document.getElementById("ring");' +
    'var latest = null;' +
    'window.cursorOverlay.onUpdate(function (point) { latest = point; });' +
    'function tick() {' +
    '  if (latest) {' +
    '    ring.style.opacity = "1";' +
    '    ring.style.transform = "translate(" + (latest.x - latest.ox) + "px," + (latest.y - latest.oy) + "px) translate(-50%,-50%)";' +
    '  }' +
    '  requestAnimationFrame(tick);' +
    '}' +
    'requestAnimationFrame(tick);' +
    '</script></body></html>'
  );
}

function setCursorHighlight(enabled) {
  if (enabled) {
    if (!cursorHighlightWindow || cursorHighlightWindow.isDestroyed()) {
      cursorHighlightWindow = new BrowserWindow({
        ...getVirtualScreenBounds(),
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        roundedCorners: false,
        enableLargerThanScreen: true,
        focusable: false,
        webPreferences: {
          preload: CURSOR_OVERLAY_PRELOAD,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: false,
          backgroundThrottling: false
        }
      });
      cursorHighlightWindow.setIgnoreMouseEvents(true, { forward: true });
      cursorHighlightWindow.setAlwaysOnTop(true, 'screen-saver');
      cursorHighlightWindow.setVisibleOnAllWorkspaces(true);
      cursorHighlightWindow.loadURL(
        'data:text/html;charset=utf-8,' + encodeURIComponent(createCursorOverlayHtml())
      );
      cursorHighlightWindow.once('ready-to-show', () => {
        if (cursorHighlightWindow && !cursorHighlightWindow.isDestroyed()) {
          sendCursorPosition();
          cursorHighlightWindow.show();
        }
      });
      cursorHighlightWindow.on('closed', () => {
        cursorHighlightWindow = null;
      });
      screen.on('display-metrics-changed', onCursorDisplayChanged);
      screen.on('display-added', onCursorDisplayChanged);
      screen.on('display-removed', onCursorDisplayChanged);
    } else {
      sendCursorPosition();
      cursorHighlightWindow.show();
    }
    if (!cursorHighlightTimer) {
      cursorHighlightTimer = setInterval(() => {
        sendCursorPosition();
        sendCursorScene();
      }, CURSOR_POLL_INTERVAL_MS);
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
    width: 360,
    height: 620,
    minWidth: 340,
    minHeight: 580,
    show: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    backgroundColor: '#f5f5f7',
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The window hides to the tray while projecting; keep requestAnimationFrame
      // (cursor-ring compositor) and the signaling timers running in background.
      backgroundThrottling: false
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
      knownNonPresentationSourceId = null;
    return { id: selectedSourceId, type: selectedSourceType };
  });
  ipcMain.handle('source-available', (_event, sourceId) => isCaptureSourceAvailable(String(sourceId || '')));
    ipcMain.handle('find-follow-window', () => findFollowWindowSource());
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
