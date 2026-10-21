$ErrorActionPreference = 'Stop'
# Hide the Project Knowledge desktop window by posting WM_CLOSE to its top-level
# window. The app's own close handler calls preventDefault() + hide(), so the
# process and the tray icon stay alive and the owned backend keeps running.
# Nothing is killed, no file is written, no data is touched.

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class Win {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp);

  public static List<IntPtr> TopLevelWindows() {
    var res = new List<IntPtr>();
    EnumWindows((h, l) => { if (GetWindowTextLength(h) > 0) res.Add(h); return true; }, IntPtr.Zero);
    return res;
  }
  public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static string TitleOf(IntPtr h) {
    int len = GetWindowTextLength(h); var sb = new StringBuilder(len + 2); GetWindowText(h, sb, len + 2); return sb.ToString();
  }
  public static bool Visible(IntPtr h) { return IsWindowVisible(h); }
  public static bool Close(IntPtr h) { return PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); } // WM_CLOSE
}
'@

$target = 0
if ($args.Count -ge 1) { $target = [int]$args[0] }

$procs = @(Get-Process electron -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$hits = @()
foreach ($h in [Win]::TopLevelWindows()) {
  $pid2 = [Win]::PidOf($h)
  if ($procs -notcontains $pid2) { continue }
  $title = [Win]::TitleOf($h)
  if ($title -notlike 'Project Knowledge*') { continue }
  $vis = [Win]::Visible($h)
  if ($vis) { [void][Win]::Close($h); $hits += "pid=$pid2 visible=was-visible title=[$title] -> WM_CLOSE posted" }
  else { $hits += "pid=$pid2 visible=already-hidden title=[$title] -> no action" }
}

if ($hits.Count -eq 0) { Write-Output "NO_WINDOW_FOUND" }
else { $hits | ForEach-Object { Write-Output $_ } }

Start-Sleep -Seconds 3
$after = @()
foreach ($h in [Win]::TopLevelWindows()) {
  $pid2 = [Win]::PidOf($h)
  if ($procs -notcontains $pid2) { continue }
  $title = [Win]::TitleOf($h)
  if ($title -like 'Project Knowledge*') { $after += "pid=$pid2 visible=$([Win]::Visible($h)) title=[$title]" }
}
if ($after.Count -eq 0) { Write-Output "AFTER: no Project Knowledge window present" }
else { $after | ForEach-Object { Write-Output "AFTER: $_" } }
