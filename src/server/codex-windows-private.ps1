param(
  [ValidateSet('ensure','check','hold')][string]$Operation,
  [Parameter(Mandatory=$true)][string]$TargetPath,
  [ValidateSet('directory','file','socket')][string]$Kind = 'directory'
)
$ErrorActionPreference = 'Stop'
try {
  # Fixed source only. Paths arrive via -File arguments, never interpolation.
  Microsoft.PowerShell.Utility\Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class CodexPrivatePath {
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
    public int Length; public IntPtr Descriptor; public int Inherit;
  }
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string p, uint access, uint share, IntPtr sa, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateDirectoryW(string p, ref SecurityAttributes sa);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle h, out FileInfo info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder b, uint size, uint flags);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern uint GetSecurityInfo(SafeFileHandle h, uint type, uint what, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr sd);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  static void Require(bool valid) { if (!valid) throw new IOException("unsafe"); }
  public static string Canonical(SafeFileHandle h) {
    var b = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandleW(h, b, (uint)b.Capacity, 0);
    Require(length > 0 && length < b.Capacity);
    return b.ToString();
  }
  public static SafeFileHandle Open(string path, bool directory) {
    // OPEN_REPARSE_POINT prevents following a substituted final link. Listing
    // access makes omission of SHARE_DELETE actually pin a directory on Windows.
    var h = CreateFileW(path, 0x20000u | 0x80u | 1u, directory ? 3u : 1u,
      IntPtr.Zero, 3, 0x02000000u | 0x00200000u, IntPtr.Zero);
    if (h.IsInvalid) { h.Dispose(); throw new IOException("unsafe"); }
    try {
      FileInfo info;
      Require(GetFileInformationByHandle(h, out info));
      Require((info.Attributes & 0x400u) == 0 && ((info.Attributes & 0x10u) != 0) == directory);
      if (!directory) Require(info.Links == 1);
      ValidateAcl(h, directory);
      return h;
    } catch { h.Dispose(); throw; }
  }
  static void ValidateAcl(SafeFileHandle h, bool directory) {
    IntPtr owner, group, dacl, sacl, descriptor;
    Require(GetSecurityInfo(h, 1, 5, out owner, out group, out dacl, out sacl, out descriptor) == 0);
    try {
      Require(owner != IntPtr.Zero && dacl != IntPtr.Zero);
      var bytes = new byte[GetSecurityDescriptorLength(descriptor)];
      Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      var sd = new RawSecurityDescriptor(bytes, 0);
      var user = WindowsIdentity.GetCurrent().User;
      Require(sd.Owner == user && sd.DiscretionaryAcl != null && sd.DiscretionaryAcl.Count > 0);
      if (directory) Require((sd.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0);
      bool userAccess = false;
      foreach (GenericAce entry in sd.DiscretionaryAcl) {
        var ace = entry as CommonAce;
        Require(ace != null && !ace.IsCallback && ace.AceQualifier == AceQualifier.AccessAllowed);
        Require(ace.SecurityIdentifier == user || ace.SecurityIdentifier.Value == "S-1-5-18");
        if (ace.SecurityIdentifier == user && (ace.AceFlags & AceFlags.InheritOnly) == 0 && (ace.AccessMask & 0x1f01ff) == 0x1f01ff) {
          if (directory) Require((ace.AceFlags & (AceFlags.ContainerInherit | AceFlags.ObjectInherit)) == (AceFlags.ContainerInherit | AceFlags.ObjectInherit));
          userAccess = true;
        }
      }
      Require(userAccess);
    } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
  }
  public static void Ensure(string path) {
    // The security descriptor is supplied to creation, never applied afterwards.
    var user = WindowsIdentity.GetCurrent().User;
    var sd = new RawSecurityDescriptor("O:" + user.Value + "D:P(A;OICI;FA;;;" + user.Value + ")");
    var bytes = new byte[sd.BinaryLength]; sd.GetBinaryForm(bytes, 0);
    var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
    try {
      var sa = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = pinned.AddrOfPinnedObject(), Inherit = 0 };
      if (!CreateDirectoryW(path, ref sa)) Require(Marshal.GetLastWin32Error() == 183);
    } finally { pinned.Free(); }
  }
}
'@
  $guards = [System.Collections.Generic.List[System.IDisposable]]::new()
  try {
    $path = [IO.Path]::GetFullPath($TargetPath)
    if ($Operation -eq 'ensure') {
      if ($Kind -ne 'directory') { throw 'unsafe' }
      [CodexPrivatePath]::Ensure($path)
    }
    if ($Kind -eq 'directory') {
      $guard = [CodexPrivatePath]::Open($path, $true)
      $guards.Add($guard)
      $canonical = [CodexPrivatePath]::Canonical($guard)
    } else {
      $parent = [CodexPrivatePath]::Open([IO.Path]::GetDirectoryName($path), $true)
      $guards.Add($parent)
      $canonical = [IO.Path]::Combine([CodexPrivatePath]::Canonical($parent), [IO.Path]::GetFileName($path))
      if ($Kind -eq 'file') {
        $guard = [CodexPrivatePath]::Open($canonical, $false)
        $guards.Add($guard)
        $canonical = [CodexPrivatePath]::Canonical($guard)
      } else {
        # AF_UNIX rendezvous entries are not POSIX sockets in Windows metadata.
        # Its private pinned directory is the trust boundary, as in codex_uds.
        if (![IO.File]::Exists($canonical)) { throw 'unsafe' }
      }
    }
    [Console]::Out.WriteLine((@{ path = $canonical } | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    if ($Operation -eq 'hold') { $null = [Console]::In.ReadLine() }
  } finally { foreach ($guard in $guards) { $guard.Dispose() } }
} catch { [Console]::Error.WriteLine('windows_private_path_unsafe'); exit 1 }
