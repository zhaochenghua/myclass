// Test-only desktop input and timing probe; not shipped in the installer.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

class DesktopProbe {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern IntPtr FindWindow(string cls, string name);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    static void Main(string[] args) {
        try { Run(args); } catch (Exception error) { Console.Error.WriteLine(error.Message); Environment.ExitCode = 1; }
    }
    static void Run(string[] args) {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        if (args[0] == "move") { SetCursorPos(int.Parse(args[1]), int.Parse(args[2])); return; }
        if (args[0] == "key") {
            var key = byte.Parse(args[1]);
            keybd_event(key, 0, 0, UIntPtr.Zero); Thread.Sleep(30); keybd_event(key, 0, 2, UIntPtr.Zero); return;
        }
        if (args[0] == "shortcut") {
            keybd_event(17, 0, 0, UIntPtr.Zero); keybd_event(18, 0, 0, UIntPtr.Zero);
            keybd_event(71, 0, 0, UIntPtr.Zero); Thread.Sleep(30);
            keybd_event(71, 0, 2, UIntPtr.Zero); keybd_event(18, 0, 2, UIntPtr.Zero); keybd_event(17, 0, 2, UIntPtr.Zero); return;
        }
        if (args[0] == "draw") {
            int x = int.Parse(args[1]), y = int.Parse(args[2]);
            SetCursorPos(x, y); Thread.Sleep(100); mouse_event(2, 0, 0, 0, UIntPtr.Zero);
            for (int i = 1; i <= 60; i++) { SetCursorPos(x + 5 * i, y + i); Thread.Sleep(8); }
            mouse_event(4, 0, 0, 0, UIntPtr.Zero); return;
        }
        if (args[0] == "measure") {
            var hwnd = FindWindow(null, "MyClass cursor halo");
            if (hwnd == IntPtr.Zero) throw new Exception("Native cursor overlay missing");
            var times = new List<double>();
            for (int i = 0; i < 120; i++) {
                int x = 400 + i * 3, y = 200 + i % 30;
                var clock = Stopwatch.StartNew();
                if (!SetCursorPos(x, y)) throw new Exception("SetCursorPos failed: " + Marshal.GetLastWin32Error() + " (desktop must be connected and unlocked)");
                Rect rect;
                do {
                    GetWindowRect(hwnd, out rect);
                    if (Math.Abs((rect.Left + rect.Right) / 2 - x) <= 1 && Math.Abs((rect.Top + rect.Bottom) / 2 - y) <= 1) break;
                    Thread.Sleep(1);
                } while (clock.ElapsedMilliseconds < 1000);
                if (clock.ElapsedMilliseconds >= 1000) throw new Exception("Cursor failed to follow");
                times.Add(clock.Elapsed.TotalMilliseconds); Thread.Sleep(4);
            }
            times.Sort();
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { samples = times.Count, p50Ms = times[60], p95Ms = times[114], maxMs = times[119] }));
        }
    }
}
