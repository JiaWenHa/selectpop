using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// 打印窗口的 hwnd / pid / 进程名 / 标题，字段用 TAB 分隔。
//   wininfo            → 当前前台窗口
//   wininfo <hwnd>     → 指定窗口（调试用，不改焦点）
//   wininfo at <x> <y> → 屏幕坐标 (x, y) 处的窗口（物理像素，用来找「用户在哪拖的」）
// 用途：划词失败时把「Ctrl+C 到底发给了谁」记进日志；以及把 Ctrl+C 送回到
// 用户真正拖拽的那个窗口（焦点可能已经被通知气泡或别的程序抢走）。
static class SelectPopWinInfo
{
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT point);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

    private const uint GA_ROOT = 2;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder name, ref uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    // Process.GetProcessById 对某些受保护/高权限进程会抛异常，退回到 OpenProcess 拿映像名
    private static string ProcessNameByPid(uint pid)
    {
        try
        {
            return Process.GetProcessById((int)pid).ProcessName;
        }
        catch
        {
            /* 走下面的兜底 */
        }

        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle == IntPtr.Zero) return "";
        try
        {
            var buffer = new StringBuilder(1024);
            uint size = (uint)buffer.Capacity;
            if (!QueryFullProcessImageName(handle, 0, buffer, ref size)) return "";
            string full = buffer.ToString();
            int slash = full.LastIndexOf('\\');
            string file = slash >= 0 ? full.Substring(slash + 1) : full;
            return file.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                ? file.Substring(0, file.Length - 4)
                : file;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    private static int Main(string[] args)
    {
        try
        {
            IntPtr hwnd = GetForegroundWindow();
            if (args.Length == 3 && args[0].Trim().ToLowerInvariant() == "at")
            {
                var point = new POINT();
                point.x = int.Parse(args[1]);
                point.y = int.Parse(args[2]);
                hwnd = WindowFromPoint(point);
                // WindowFromPoint 可能返回子窗口，置前要用顶层窗口
                if (hwnd != IntPtr.Zero)
                {
                    IntPtr root = GetAncestor(hwnd, GA_ROOT);
                    if (root != IntPtr.Zero) hwnd = root;
                }
            }
            else if (args.Length > 0)
            {
                long requested;
                if (long.TryParse(args[0], out requested) && requested != 0) hwnd = new IntPtr(requested);
            }

            uint pid = 0;
            if (hwnd != IntPtr.Zero) GetWindowThreadProcessId(hwnd, out pid);

            var title = new StringBuilder(512);
            if (hwnd != IntPtr.Zero) GetWindowText(hwnd, title, title.Capacity);

            string process = pid != 0 ? ProcessNameByPid(pid) : "";

            string clean = title.ToString().Replace('\t', ' ').Replace("\r", " ").Replace("\n", " ");
            Console.Out.WriteLine(hwnd.ToInt64() + "\t" + pid + "\t" + process + "\t" + clean);
            return 0;
        }
        catch
        {
            return 1;
        }
    }
}
