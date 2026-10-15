// Small out-of-process Windows desktop helpers. No system cursor replacement.
// Cursor coordinates, window bounds and DPI are physical pixels throughout.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class DesktopTools {
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    internal static void Send(object value) { Console.WriteLine(Json.Serialize(value)); }
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [STAThread] static int Main(string[] args) {
        try {
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += (sender, error) => {
                Send(new { type = "error", message = error.Exception.GetBaseException().Message });
                Application.Exit();
            };
            using (var dispatcher = new Control()) {
                dispatcher.CreateControl();
                var handle = dispatcher.Handle;
                using (var cursor = args[0] == "cursor" ? new CursorHalo() : null) {
                    object ink = null;
                    Type inkType = null;
                    bool lastInkActive = false;
                    if (args[0] == "ink") {
                        var assembly = Assembly.LoadFrom(Path.GetFullPath(args[2]));
                        inkType = assembly.GetType("gInk.Root", true);
                        ink = Activator.CreateInstance(inkType);
                        // MyClass owns activation so window capture can first switch to a screen.
                        // A separate gInk tray entry remains available for tool configuration.
                    }
                    Action<string> command = line => {
                        try {
                            if (line == "quit") { Application.Exit(); return; }
                            if (cursor != null && line == "on") cursor.Enable();
                            if (ink != null && line == "on") inkType.GetMethod("StartInk").Invoke(ink, null);
                            if (ink != null && line == "pointer" && inkType.GetField("FormCollection").GetValue(ink) != null) {
                                bool pointer = (bool)inkType.GetField("PointerMode").GetValue(ink);
                                int pen = pointer ? (int)inkType.GetField("LastPen").GetValue(ink) : -2;
                                inkType.GetMethod("SelectPen").Invoke(ink, new object[] { pen });
                            }
                            if (ink != null && line == "off" && inkType.GetField("FormCollection").GetValue(ink) != null)
                                inkType.GetMethod("StopInk").Invoke(ink, null);
                            Send(new { type = "ack", command = line });
                        } catch (Exception error) { Send(new { type = "error", message = error.GetBaseException().Message }); }
                    };
                    var input = new Thread(() => {
                        string line;
                        try {
                            while ((line = Console.ReadLine()) != null) {
                                string next = line;
                                dispatcher.BeginInvoke(new Action(() => command(next)));
                            }
                            dispatcher.BeginInvoke(new Action(Application.Exit));
                        } catch { }
                    });
                    input.IsBackground = true;
                    input.Start();
                    using (var parent = Process.GetProcessById(int.Parse(args[1])))
                    using (var timer = new System.Windows.Forms.Timer()) {
                        timer.Interval = 200;
                        timer.Tick += (s, e) => {
                            try { if (parent.HasExited) Application.Exit(); }
                            catch { Application.Exit(); }
                            if (ink != null) {
                                bool active = inkType.GetField("FormCollection").GetValue(ink) != null;
                                if (lastInkActive != active) { lastInkActive = active; Send(new { type = "ink-state", active = active }); }
                            }
                        };
                        timer.Start();
                        Send(new { type = "ready" });
                        Application.Run();
                    }
                    if (ink != null) {
                        var tray = inkType.GetField("trayIcon").GetValue(ink) as NotifyIcon;
                        if (tray != null) tray.Dispose();
                    }
                }
            }
            return 0;
        } catch (Exception error) { Send(new { type = "error", message = error.GetBaseException().ToString() }); return 1; }
    }
}

internal sealed class CursorHalo : NativeWindow, IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; public Point(int x, int y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential)] struct Size { public int Width, Height; public Size(int w, int h) { Width = w; Height = h; } }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] struct Blend { public byte Op, Flags, Alpha, Format; }
    [StructLayout(LayoutKind.Sequential)] struct MouseData { public Point Position; public uint Data, Flags, Time; public IntPtr Extra; }
    delegate IntPtr MouseProc(int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, MouseProc proc, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(Point point, uint flags);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr window, IntPtr destDC, ref Point dest, ref Size size, IntPtr sourceDC, ref Point source, uint key, ref Blend blend, uint flags);
    readonly MouseProc callback;
    IntPtr hook, monitor;
    int diameter;
    bool visible;
    public CursorHalo() {
        CreateHandle(new CreateParams { Caption = "MyClass cursor halo", X = 0, Y = 0, Width = 1, Height = 1,
            Style = unchecked((int)0x80000000), ExStyle = 0x00080000 | 0x00000020 | 0x08000000 | 0x00000080 });
        callback = OnMouse;
    }
    public void Enable() {
        if (hook == IntPtr.Zero) {
            hook = SetWindowsHookEx(14, callback, GetModuleHandle(null), 0);
            if (hook == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        }
        visible = true;
        Point point; GetCursorPos(out point); Move(point);
        SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0040);
    }
    IntPtr OnMouse(int code, IntPtr message, IntPtr data) {
        // Draw/move locally on the input thread: no timer, IPC, CSS easing or rAF.
        if (code >= 0 && visible) {
            try { Move(((MouseData)Marshal.PtrToStructure(data, typeof(MouseData))).Position); }
            catch { visible = false; DesktopTools.Send(new { type = "error", message = "鼠标标记绘制失败，请重新开启鼠标强调" }); }
        }
        return CallNextHookEx(hook, code, message, data);
    }
    void Move(Point point) {
        var nextMonitor = MonitorFromPoint(point, 2);
        if (nextMonitor != monitor) {
            monitor = nextMonitor;
            uint dx, dy;
            if (GetDpiForMonitor(monitor, 0, out dx, out dy) != 0) dx = 96;
            diameter = Math.Max(28, (int)Math.Round(28 * dx / 96.0));
            Paint(point);
        }
        // Preserve z-order while moving: repeatedly raising HWND_TOPMOST from a
        // low-level hook can stall input while other desktop windows respond.
        SetWindowPos(Handle, IntPtr.Zero, point.X - diameter / 2, point.Y - diameter / 2, diameter, diameter, 0x0004 | 0x0010 | 0x0400);
    }
    void Paint(Point point) {
        using (var bitmap = new Bitmap(diameter, diameter, PixelFormat.Format32bppPArgb)) {
            using (var graphics = Graphics.FromImage(bitmap)) {
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                float scale = diameter / 28f;
                var rect = new RectangleF(2 * scale, 2 * scale, diameter - 4 * scale, diameter - 4 * scale);
                using (var fill = new SolidBrush(Color.FromArgb(28, 255, 90, 80))) graphics.FillEllipse(fill, rect);
                using (var edge = new Pen(Color.FromArgb(180, 255, 255, 255), 3 * scale)) graphics.DrawEllipse(edge, rect);
                using (var edge = new Pen(Color.FromArgb(210, 239, 83, 80), 1.5f * scale)) graphics.DrawEllipse(edge, rect);
            }
            var destDC = GetDC(IntPtr.Zero);
            var sourceDC = CreateCompatibleDC(destDC);
            var dib = bitmap.GetHbitmap(Color.FromArgb(0));
            var previous = SelectObject(sourceDC, dib);
            try {
                var dest = new Point(point.X - diameter / 2, point.Y - diameter / 2);
                var source = new Point(0, 0);
                var size = new Size(diameter, diameter);
                var blend = new Blend { Alpha = 255, Format = 1 };
                if (!UpdateLayeredWindow(Handle, destDC, ref dest, ref size, sourceDC, ref source, 0, ref blend, 2))
                    throw new System.ComponentModel.Win32Exception();
            } finally { SelectObject(sourceDC, previous); DeleteObject(dib); DeleteDC(sourceDC); ReleaseDC(IntPtr.Zero, destDC); }
        }
    }
    public void Dispose() {
        if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
        DestroyHandle();
    }
    protected override void WndProc(ref Message message) {
        if (message.Msg == 0x007E || message.Msg == 0x02E0) monitor = IntPtr.Zero;
        base.WndProc(ref message);
    }
}
