# Logs every visible top-level window (pid, exe, class, title, rect) as JSON lines and grabs the screen every 500 ms until -Stop exists.
param(
  [Parameter(Mandatory)][string]$Out,
  [Parameter(Mandatory)][string]$Shots,
  [Parameter(Mandatory)][string]$Stop,
  [Parameter(Mandatory)][string]$Ready
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class Win {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int f, StringBuilder s, ref int n);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  static string Exe(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return "";
    var s = new StringBuilder(1024);
    int n = s.Capacity;
    string path = QueryFullProcessImageName(h, 0, s, ref n) ? s.ToString() : "";
    CloseHandle(h);
    return path;
  }

  static string J(string s) {
    var b = new StringBuilder();
    foreach (char ch in s) {
      if (ch == '\\' || ch == '"') b.Append('\\').Append(ch);
      else if (ch < 0x20) b.AppendFormat("\\u{0:x4}", (int)ch);
      else b.Append(ch);
    }
    return b.ToString();
  }

  public static string Visible() {
    var rows = new List<string>();
    var exes = new Dictionary<uint, string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int cloaked;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      RECT r;
      GetWindowRect(h, out r);
      if (r.R - r.L < 50 || r.B - r.T < 20) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      string exe;
      if (!exes.TryGetValue(pid, out exe)) { exe = Exe(pid); exes[pid] = exe; }
      if (exe.EndsWith("\\explorer.exe", StringComparison.OrdinalIgnoreCase)) return true;
      var t = new StringBuilder(256);
      GetWindowText(h, t, 256);
      var c = new StringBuilder(256);
      GetClassName(h, c, 256);
      rows.Add(String.Format("{{\"pid\":{0},\"exe\":\"{1}\",\"cls\":\"{2}\",\"title\":\"{3}\",\"rect\":[{4},{5},{6},{7}]}}",
        pid, J(exe), J(c.ToString()), J(t.ToString()), r.L, r.T, r.R - r.L, r.B - r.T));
      return true;
    }, IntPtr.Zero);
    return "[" + String.Join(",", rows) + "]";
  }
}
'@

New-Item -ItemType Directory -Force $Shots | Out-Null
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
function Shot([string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $g.Dispose()
    $bmp.Dispose()
  }
}

$w = [IO.StreamWriter]::new($Out, $false)
$prev = ''
$beat = 0
$shot = 0
Set-Content -LiteralPath $Ready -Value "$($bounds.Width)x$($bounds.Height)"
while (-not (Test-Path -LiteralPath $Stop)) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $v = [Win]::Visible()
  if ($v -ne $prev -or $now - $beat -ge 1000) {
    $w.WriteLine("{""t"":$now,""w"":$v}")
    $w.Flush()
    $prev = $v
    $beat = $now
  }
  if ($now - $shot -ge 500) {
    $shot = $now
    try { Shot (Join-Path $Shots "$now.png") } catch { $w.WriteLine("{""t"":$now,""shotError"":""$($_.Exception.Message -replace '"', "'")""}") }
  }
  Start-Sleep -Milliseconds 30
}
$w.Close()
