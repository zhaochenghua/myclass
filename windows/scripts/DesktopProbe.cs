// Test-only desktop input and timing probe; not shipped in the installer.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

class DesktopProbe {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public MouseInput Mouse; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr FindWindow(string cls, string name);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    static void Move(int x, int y) {
        // Inject a real mouse move. RDP round-trips SetCursorPos through its
        // client before delivering the corresponding low-level hook event.
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
        int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        var inputs = new[] { new Input { Type = 0, Mouse = new MouseInput { X = (int)Math.Ceiling((x - left) * 65536.0 / width), Y = (int)Math.Ceiling((y - top) * 65536.0 / height), Flags = 0xC001 } } };
        if (SendInput(1, inputs, Marshal.SizeOf(typeof(Input))) != 1) throw new Exception("SendInput failed: " + Marshal.GetLastWin32Error());
    }
    static void Main(string[] args) {
        try { Run(args); } catch (Exception error) { Console.Error.WriteLine(error.Message); Environment.ExitCode = 1; }
    }
    static void Run(string[] args) {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        if (args[0] == "move") { Move(int.Parse(args[1]), int.Parse(args[2])); Thread.Sleep(200); Point p; GetCursorPos(out p); Console.WriteLine(string.Format("desktop=({0},{1},{2},{3}), cursor=({4},{5})", GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79), p.X, p.Y)); return; }
        if (args[0] == "key") {
            var key = byte.Parse(args[1]);
            keybd_event(key, 0, 0, UIntPtr.Zero); Thread.Sleep(30); keybd_event(key, 0, 2, UIntPtr.Zero); return;
        }
        if (args[0] == "ctrl") {
            var key = byte.Parse(args[1]);
            keybd_event(17, 0, 0, UIntPtr.Zero); keybd_event(key, 0, 0, UIntPtr.Zero); Thread.Sleep(30);
            keybd_event(key, 0, 2, UIntPtr.Zero); keybd_event(17, 0, 2, UIntPtr.Zero); return;
        }
        if (args[0] == "shortcut") {
            keybd_event(17, 0, 0, UIntPtr.Zero); keybd_event(18, 0, 0, UIntPtr.Zero);
            keybd_event(71, 0, 0, UIntPtr.Zero); Thread.Sleep(30);
            keybd_event(71, 0, 2, UIntPtr.Zero); keybd_event(18, 0, 2, UIntPtr.Zero); keybd_event(17, 0, 2, UIntPtr.Zero); return;
        }
        if (args[0] == "draw") {
            int x = int.Parse(args[1]), y = int.Parse(args[2]);
            Move(x, y); Thread.Sleep(100); mouse_event(2, 0, 0, 0, UIntPtr.Zero);
            for (int i = 1; i <= 60; i++) { Move(x + 5 * i, y + i); Thread.Sleep(8); }
            mouse_event(4, 0, 0, 0, UIntPtr.Zero); return;
        }
        if (args[0] == "measure") {
            var hwnd = FindWindow(null, "MyClass cursor halo");
            if (hwnd == IntPtr.Zero) throw new Exception("Native cursor overlay missing");
            var times = new List<double>();
            var inputTimes = new List<double>();
            for (int i = 0; i < 120; i++) {
                int x = 400 + i * 3, y = 200 + i % 30;
                var clock = Stopwatch.StartNew();
                Move(x, y);
                inputTimes.Add(clock.Elapsed.TotalMilliseconds);
                Rect rect = new Rect();
                do {
                    GetWindowRect(hwnd, out rect);
                    if (Math.Abs((rect.Left + rect.Right) / 2 - x) <= 1 && Math.Abs((rect.Top + rect.Bottom) / 2 - y) <= 1) break;
                    Thread.Sleep(1);
                } while (clock.ElapsedMilliseconds < 1000);
                if (clock.ElapsedMilliseconds >= 1000) {
                    Point actual; GetCursorPos(out actual);
                    throw new Exception(string.Format("Cursor failed to follow sample {0}: target=({1},{2}), cursor=({3},{4}), halo=({5},{6},{7},{8})", i, x, y, actual.X, actual.Y, rect.Left, rect.Top, rect.Right, rect.Bottom));
                }
                times.Add(clock.Elapsed.TotalMilliseconds); Thread.Sleep(4);
            }
            times.Sort();
            inputTimes.Sort();
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { samples = times.Count, p50Ms = times[60], p95Ms = times[114], maxMs = times[119], inputP50Ms = inputTimes[60], inputP95Ms = inputTimes[114] }));
        }
    }
}
