'use strict';

const { spawn } = require('child_process');

// Native system folder picker behind GET /system/pick-folder. Windows drives
// the WinForms FolderBrowserDialog through PowerShell; other platforms try
// zenity first, then macOS osascript. The picker is host-stateless, so the
// HTTP handler can require this module directly. Everything a test needs to
// fake (spawn, platform, timeout) is injectable via options.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // a user may browse for minutes
const MAX_OUTPUT = 64 * 1024;

// One native dialog at a time: concurrent callers (double click, two tabs)
// share the in-flight pick instead of stacking modal dialogs.
let activePick = null;

const WINDOWS_DIALOG_ARGS = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass'];
// The modern Windows folder picker (IFileDialog with FOS_PICKFOLDERS) is the
// same dialog Chrome/Edge surface for file inputs: breadcrumb bar, Quick
// Access sidebar, search. The legacy FolderBrowserDialog looks like a Win8
// relic by comparison, so shell out to the COM API via an inline C# shim.
const WINDOWS_DIALOG_SCRIPT = `\
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$cs = @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class FolderPicker {
    public string ResultPath { get; private set; }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IntPtr ppv);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    public bool ShowDialog(int cx, int cy) {
        // The dialog centers on its owner, so the owner is a 1x1 transparent
        // topmost window parked at the anchor point (browser window center,
        // or the primary screen center when no anchor was supplied).
        var owner = new Form();
        owner.StartPosition = FormStartPosition.Manual;
        owner.FormBorderStyle = FormBorderStyle.None;
        owner.ShowInTaskbar = false;
        owner.TopMost = true;
        owner.Size = new System.Drawing.Size(1, 1);
        try {
            var area = Screen.FromPoint(new System.Drawing.Point(cx, cy)).WorkingArea;
            if (cx < area.Left || cx > area.Right) cx = area.Left + area.Width / 2;
            if (cy < area.Top || cy > area.Bottom) cy = area.Top + area.Height / 2;
        } catch { }
        owner.Location = new System.Drawing.Point(cx, cy);
        owner.Opacity = 0;
        owner.Show();
        // A background process normally may not steal the foreground from the
        // browser. Attaching our input thread to the foreground window's
        // thread makes the activation legal (classic AttachThreadInput
        // technique); the topmost owner then keeps the modal above the
        // browser even when the OS still denies the focus change.
        IntPtr fg = GetForegroundWindow();
        uint fgPid;
        uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
        uint thisThread = GetCurrentThreadId();
        bool attached = fgThread != thisThread && fgThread != 0 && AttachThreadInput(thisThread, fgThread, true);
        try {
            SetForegroundWindow(owner.Handle);
            owner.Activate();
        } finally {
            if (attached) AttachThreadInput(thisThread, fgThread, false);
        }
        try {
            var dialog = (IFileDialog)(new FileOpenDialogRCW());
            try {
                dialog.SetOptions(FOS.PICKFOLDERS | FOS.FORCEFILESYSTEM | FOS.PATHMUSTEXIST);
                dialog.SetTitle("选择项目文件夹");
                int hr = dialog.Show(owner.Handle);
                if (hr != 0) return false;
                IShellItem item;
                dialog.GetResult(out item);
                IntPtr pathPtr;
                item.GetDisplayName(SIGDN.FILESYSPATH, out pathPtr);
                ResultPath = Marshal.PtrToStringUni(pathPtr);
                Marshal.FreeCoTaskMem(pathPtr);
                Marshal.ReleaseComObject(item);
                return true;
            } finally { Marshal.ReleaseComObject(dialog); }
        } finally { owner.Close(); }
    }

    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    private class FileOpenDialogRCW { }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
        // Full vtable order matters: COM slots before GetDisplayName must be
        // declared even though this picker never calls them.
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        IShellItem GetParent();
        [PreserveSig] int GetDisplayName(SIGDN sigdnName, out IntPtr ppszName);
        [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        [PreserveSig] int Compare(IShellItem psi, uint hint);
    }

    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog {
        [PreserveSig] int Show(IntPtr hwndOwner);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(FOS fos);
        void GetOptions(out FOS pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
    }

    private enum SIGDN : uint { FILESYSPATH = 0x80058000 }

    [Flags]
    private enum FOS : uint {
        PICKFOLDERS = 0x20,
        FORCEFILESYSTEM = 0x40,
        PATHMUSTEXIST = 0x800,
    }
}
"@
Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Windows.Forms.dll,System.Drawing.dll
$picker = New-Object FolderPicker
$cx = $centerX
$cy = $centerY
if ($null -eq $cx -or $null -eq $cy) {
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $cx = $wa.X + [int]($wa.Width / 2)
    $cy = $wa.Y + [int]($wa.Height / 2)
}
if ($picker.ShowDialog([int]$cx, [int]$cy)) { Write-Output $picker.ResultPath }
`;

// The dialog centers on its owner, so the invisible owner is placed at the
// caller's anchor point (the browser window center) or the primary screen
// center. `windowRect` is the UI page's {x, y, width, height} in screen
// coordinates; anything malformed falls back to centering.
function windowsScript(windowRect) {
  let centerX = '$null';
  let centerY = '$null';
  const rect = Number.isFinite(windowRect) ? null : windowRect;
  if (rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
    const x = Math.round(rect.x + Math.min(Math.max(rect.width, 0), 32768) / 2);
    const y = Math.round(rect.y + Math.min(Math.max(rect.height, 0), 32768) / 2);
    // Guard against absurd coordinates; Screen.FromPoint clamps the rest.
    if (Math.abs(x) <= 100000 && Math.abs(y) <= 100000) {
      centerX = String(x);
      centerY = String(y);
    }
  }
  return WINDOWS_DIALOG_SCRIPT.replace('$centerX', centerX).replace('$centerY', centerY);
}

function pickFolder(options = {}) {
  if (activePick) return activePick;
  const shared = pickFolderUnlocked(options);
  activePick = shared;
  // Release on settle; the attached handler also means a dropped shared
  // rejection never surfaces as unhandled.
  const release = () => { if (activePick === shared) activePick = null; };
  shared.then(release, release);
  return shared;
}

async function pickFolderUnlocked(options = {}) {
  const platform = options.platform || process.platform;
  const doSpawn = options.spawn || spawn;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const run = (command, args) => runPicker(command, args, doSpawn, timeoutMs);
  if (platform === 'win32') {
    const { stdout } = await run('powershell.exe', [...WINDOWS_DIALOG_ARGS, '-Command', windowsScript(options.windowRect)]);
    return { path: parseSelectedPath(stdout, false) };
  }
  try {
    const { stdout } = await run('zenity', ['--file-selection', '--directory']);
    return { path: parseSelectedPath(stdout, false) };
  } catch (error) {
    // Only "not installed" falls through to osascript; real failures (crash,
    // timeout) are already terminal.
    if (error.status !== 501) throw error;
  }
  const { stdout } = await run('osascript', ['-e', 'POSIX path of (choose folder)']);
  return { path: parseSelectedPath(stdout, true) };
}

// Empty output means the user cancelled: every backend keeps that contract.
function parseSelectedPath(stdout, stripTrailingSlashes) {
  let value = String(stdout || '').replace(/\u0000/g, '').replace(/^\uFEFF/, '').trim();
  value = value.replace(/^"|"$/g, '');
  if (stripTrailingSlashes && value) value = value.replace(/\/+$/, '') || '/';
  return value || null;
}

function runPicker(command, args, doSpawn, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = doSpawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(pickerError(command, error));
      return;
    }
    let stdout = '';
    let settled = false;
    const settle = finish => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const timer = setTimeout(() => settle(() => {
      killChild(child);
      reject(Object.assign(
        new Error(`folder picker timed out after ${Math.round(timeoutMs / 1000)}s`),
        { status: 500 },
      ));
    }), timeoutMs);
    if (timer.unref) timer.unref();
    if (child.stdout && child.stdout.on) {
      child.stdout.on('data', chunk => {
        if (stdout.length < MAX_OUTPUT) stdout += String(chunk).slice(0, MAX_OUTPUT - stdout.length);
      });
    }
    if (child.stderr && child.stderr.on) child.stderr.on('data', () => { /* cancellation chatter */ });
    child.on('error', error => settle(() => reject(pickerError(command, error))));
    child.on('close', () => settle(() => resolve({ stdout })));
  });
}

function pickerError(command, error) {
  if (error && error.code === 'ENOENT') {
    return Object.assign(new Error(`${command} is not available on this system`), { status: 501 });
  }
  const message = error && error.message ? error.message : 'unknown error';
  return Object.assign(new Error(`failed to run ${command}: ${message}`), { status: 500 });
}

function killChild(child) {
  try { child && child.kill && child.kill(); } catch { /* already gone */ }
}

module.exports = { pickFolder };
