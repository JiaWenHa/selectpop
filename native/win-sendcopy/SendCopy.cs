using System;
using System.Runtime.InteropServices;
using System.Threading;

// SelectPop 的 Windows 按键注入小工具。
//
// 为什么需要它：Chromium / Edge 等程序不接受 WScript.Shell.SendKeys 注入的按键
// （实测：同进程窗口能收到，别的进程窗口收不到），而 PowerShell 的 Add-Type
// 在运行时编译 C# 又可能在受限环境里失败（「客户端没有所需的特权」）。
// 所以把「按一次 Ctrl+C」这件事编译成这个不依赖 .NET 之外任何东西的小 exe：
//   sendcopy.exe                发一次 Ctrl+C 后退出（退出码 0 成功）
//   sendcopy.exe serve          常驻，读 stdin 的 copy/quit，回 OK/ERR（几十毫秒一次）
//   sendcopy.exe focuscopy <h>  先把窗口 h 置前，再发 Ctrl+C（焦点被别人抢走时用）
static class SelectPopSendCopy
{
    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public KEYBDINPUT ki;
        public int pad1;
        public int pad2;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

    private const uint GA_ROOT = 2;

    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 2;
    private const uint KEYEVENTF_SCANCODE = 8;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_C = 0x43;
    private const ushort SCAN_CONTROL = 0x1D;
    private const ushort SCAN_C = 0x2E;

    private static readonly int InputSize = Marshal.SizeOf(typeof(INPUT));

    private static void Key(ushort vk, ushort scan, bool up)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].ki.wVk = vk;
        inputs[0].ki.wScan = scan;
        inputs[0].ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0u) | KEYEVENTF_SCANCODE;
        SendInput(1, inputs, InputSize);
    }

    private static void Copy()
    {
        Key(VK_CONTROL, SCAN_CONTROL, false);
        Key(VK_C, SCAN_C, false);
        Thread.Sleep(25);
        Key(VK_C, SCAN_C, true);
        Key(VK_CONTROL, SCAN_CONTROL, true);
    }

    private static int Main(string[] args)
    {
        string mode = args.Length > 0 ? args[0].Trim().ToLowerInvariant() : "copy";

        if (mode == "serve")
        {
            Console.Out.WriteLine("READY");
            Console.Out.Flush();
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                line = line.Trim().ToLowerInvariant();
                if (line == "quit")
                {
                    break;
                }
                if (line == "copy")
                {
                    try
                    {
                        Copy();
                        Console.Out.WriteLine("OK");
                    }
                    catch
                    {
                        Console.Out.WriteLine("ERR");
                    }
                    Console.Out.Flush();
                }
            }
            return 0;
        }

        if (mode == "focuscopy")
        {
            long raw;
            if (args.Length < 2 || !long.TryParse(args[1], out raw) || raw == 0)
            {
                Console.Error.WriteLine("usage: sendcopy focuscopy <hwnd>");
                return 1;
            }
            IntPtr target = new IntPtr(raw);
            IntPtr root = GetAncestor(target, GA_ROOT);
            if (root != IntPtr.Zero) target = root;
            if (GetForegroundWindow() != target)
            {
                SetForegroundWindow(target);
                Thread.Sleep(90);
            }
            try
            {
                Copy();
                return 0;
            }
            catch
            {
                return 2;
            }
        }

        try
        {
            Copy();
            return 0;
        }
        catch
        {
            return 2;
        }
    }
}
