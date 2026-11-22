# folder-picker.ps1 — modern folder picker for project-knowledge import dialog.
# Uses the Vista+ IFileOpenDialog COM API (the same dialog VS Code / modern
# Windows apps show) with the default initial folder set to "This PC".
#
# Reads title from $args[0]. Prints the selected absolute path to stdout, or
# prints nothing if the user cancelled. Exits 0 in both cases.
#
# STA apartment + -WindowStyle Hidden is required by the caller; this script
# assumes the host process has set those flags.

param([string]$Title = 'Select folder')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$src = @'
using System;
using System.ComponentModel;
using System.Linq;
using System.Runtime.InteropServices;

[Flags]
public enum FOS : uint {
  PICKFOLDERS     = 0x00000020,
  FORCEFILESYSTEM = 0x00000040,
  NOCHANGEDIR     = 0x00000008
}

[ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFileOpenDialog {
  [PreserveSig] int Show(IntPtr hwndOwner);
  [PreserveSig] int SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
  [PreserveSig] int SetFileTypeIndex(uint iFileType);
  [PreserveSig] int GetFileTypeIndex(out uint piFileType);
  [PreserveSig] int Advise(IntPtr pfde, out uint pdwCookie);
  [PreserveSig] int Unadvise(uint dwCookie);
  [PreserveSig] int SetOptions(FOS fos);
  [PreserveSig] int GetOptions(out FOS pfos);
  [PreserveSig] int SetDefaultFolder(IntPtr psi);
  [PreserveSig] int SetFolder(IntPtr psi);
  [PreserveSig] int GetFolder(out IntPtr ppsi);
  [PreserveSig] int GetCurrentSelection(out IntPtr ppsi);
  [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
  [PreserveSig] int GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
  [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
  [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
  [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
  [PreserveSig] int GetResult(out IntPtr ppsi);
  [PreserveSig] int AddPlace(IntPtr psi, int fdap);
  [PreserveSig] int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
  [PreserveSig] int Close(int hr);
  [PreserveSig] int SetClientGuid(ref Guid guid);
  [PreserveSig] int ClearClientData();
  [PreserveSig] int SetFilter(IntPtr pFilter);
  [PreserveSig] int GetResults(out IntPtr ppenum);
  [PreserveSig] int GetSelectedItems(out IntPtr ppsai);
}

public static class Shell32 {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, PreserveSig = true)]
  public static extern int SHCreateItemFromParsingName(
    [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
    IntPtr pbc,
    [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
    out IntPtr ppv);

  [DllImport("ole32.dll", PreserveSig = true)]
  public static extern int CoCreateInstance(
    ref Guid rclsid, IntPtr pUnkOuter, uint dwClsContext, ref Guid riid, out IntPtr ppv);
}

public static class User32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}

public static class FolderPicker {
  public static string Pick(string title) {
    Guid clsid = new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7");
    Guid iid   = new Guid("d57c7288-d4ad-4768-be02-9d969532d960");
    IntPtr pIfod = IntPtr.Zero;
    IntPtr pItem = IntPtr.Zero;
    IntPtr pResult = IntPtr.Zero;

    try {
      int hr = Shell32.CoCreateInstance(ref clsid, IntPtr.Zero, 0x1, ref iid, out pIfod);
      if (hr != 0) throw new Win32Exception(hr);

      IFileOpenDialog dialog = (IFileOpenDialog)Marshal.GetTypedObjectForIUnknown(pIfod, typeof(IFileOpenDialog));

      FOS opts = FOS.PICKFOLDERS | FOS.FORCEFILESYSTEM | FOS.NOCHANGEDIR;
      hr = dialog.SetOptions(opts);
      if (hr != 0) throw new Win32Exception(hr);

      // On Win11 with system ANSI codepage set (e.g. 936 GBK) the Fluent
// title-bar chrome can garble CJK even though the dialog stores the title
// correctly in Unicode (taskbar preview is correct via the Unicode path).
// Use an ASCII title to keep the chrome legible; the import button's
// surrounding UI (Chinese) tells the user what the picker is for.
string safeTitle = title.All(c => c < 128) ? title : "Select Project Folder";
hr = dialog.SetTitle(safeTitle);
if (hr != 0) throw new Win32Exception(hr);

      // Initial folder = This PC (FOLDERID_ComputerFolder)
      Guid iidShellItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
      hr = Shell32.SHCreateItemFromParsingName(
        "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}",
        IntPtr.Zero, iidShellItem, out pItem);
      if (hr != 0) throw new Win32Exception(hr);
      hr = dialog.SetFolder(pItem);
      if (hr != 0) throw new Win32Exception(hr);

      // Pass the current foreground window as owner so the dialog is parented
      // to it (positioned on top, modal to it). Without an owner, the dialog
      // has no z-order anchor and on Windows 11 ends up hidden behind the
      // browser window that initiated the call.
      IntPtr owner = User32.GetForegroundWindow();
      hr = dialog.Show(owner);
      // 0 = OK, 0x800704C7 = ERROR_CANCELLED, others = error
      if (hr != 0) return null;

      hr = dialog.GetResult(out pResult);
      if (hr != 0 || pResult == IntPtr.Zero) return null;

      // IShellItem vtable index 5 = GetDisplayName(SIGDN, LPWSTR*)
      IntPtr vtable = Marshal.ReadIntPtr(pResult);
      IntPtr getDisplayNameFn = Marshal.ReadIntPtr(vtable, 5 * IntPtr.Size);
      GetDisplayNameDelegate del = (GetDisplayNameDelegate)Marshal.GetDelegateForFunctionPointer(
        getDisplayNameFn, typeof(GetDisplayNameDelegate));

      IntPtr strPtr = IntPtr.Zero;
      int ghr = del(pResult, 0x80058000u, out strPtr);  // SIGDN_FILESYSPATH
      if (ghr != 0 || strPtr == IntPtr.Zero) return null;

      string path = Marshal.PtrToStringUni(strPtr);
      Marshal.FreeCoTaskMem(strPtr);
      return path;
    } finally {
      if (pResult != IntPtr.Zero) Marshal.Release(pResult);
      if (pItem != IntPtr.Zero) Marshal.Release(pItem);
      if (pIfod != IntPtr.Zero) Marshal.Release(pIfod);
    }
  }

  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  private delegate int GetDisplayNameDelegate(IntPtr pThis, uint sigdn, out IntPtr ppszName);
}
'@

Add-Type -TypeDefinition $src -Language CSharp | Out-Null

$path = [FolderPicker]::Pick($Title)
if ($null -ne $path -and $path.Length -gt 0) {
  Write-Output $path
}
exit 0
