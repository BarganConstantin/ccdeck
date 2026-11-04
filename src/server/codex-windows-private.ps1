param(
  [ValidateSet('ensure','check','hold','protect-login','snapshot-login')][string]$Operation,
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
  [StructLayout(LayoutKind.Sequential)] struct AttributeTagInfo { public uint Attributes, Tag; }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int type, out AttributeTagInfo info, uint size);
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
  // Explicit preparation only. Open both objects without following final
  // reparse points or sharing deletion; modify security through those handles,
  // never by looking up an unchecked path a second time. No credential bytes
  // are read, copied or replaced here.
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern uint SetSecurityInfo(SafeFileHandle h, uint type, uint what, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  static SafeFileHandle OpenForProtection(string path, bool directory) {
    var h = CreateFileW(path, 0xe0081u, directory ? 3u : 1u,
      IntPtr.Zero, 3, 0x02000000u | 0x00200000u, IntPtr.Zero);
    if (h.IsInvalid) { h.Dispose(); throw new IOException("unsafe"); }
    try {
      FileInfo info; Require(GetFileInformationByHandle(h, out info));
      Require((info.Attributes & 0x400u) == 0 && ((info.Attributes & 0x10u) != 0) == directory);
      if (!directory) Require(info.Links == 1);
      return h;
    } catch { h.Dispose(); throw; }
  }
  static void Protect(SafeFileHandle h, bool directory) {
    var user = WindowsIdentity.GetCurrent().User;
    var sid = new byte[user.BinaryLength]; user.GetBinaryForm(sid, 0);
    var acl = new RawAcl(2, 1);
    acl.InsertAce(0, new CommonAce(directory ? AceFlags.ContainerInherit | AceFlags.ObjectInherit : AceFlags.None,
      AceQualifier.AccessAllowed, 0x1f01ff, user, false, null));
    var bytes = new byte[acl.BinaryLength]; acl.GetBinaryForm(bytes, 0);
    var owner = GCHandle.Alloc(sid, GCHandleType.Pinned);
    var dacl = GCHandle.Alloc(bytes, GCHandleType.Pinned);
    try {
      Require(SetSecurityInfo(h, 1, 0x80000005u, owner.AddrOfPinnedObject(), IntPtr.Zero, dacl.AddrOfPinnedObject(), IntPtr.Zero) == 0);
      ValidateAcl(h, directory);
    } finally { dacl.Free(); owner.Free(); }
  }
  public static string ProtectLogin(string path) {
    Require(!String.Equals(Path.GetPathRoot(path).TrimEnd('\\'), path.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase));
    using (var directory = OpenForProtection(path, true)) {
      string canonical = Canonical(directory);
      using (var file = OpenForProtection(Path.Combine(canonical, "auth.json"), false)) {
        Protect(file, false);
        Protect(directory, true);
        ValidateAcl(file, false);
      }
      return canonical;
    }
  }
  // Explicit local import: the source may be shared with Codex's sandbox.
  // Pin owner-controlled objects and read one immutable regular-file handle.
  // Never alter source permissions and never export a refresh token.
  public static string SnapshotLogin(string path) {
    using (var directory = OpenForProtection(path, true)) {
      Require(Owned(directory));
      string canonical = Canonical(directory);
      using (var file = OpenForProtection(Path.Combine(canonical, "auth.json"), false)) {
        Require(Owned(file));
        FileInfo info; Require(GetFileInformationByHandle(file, out info));
        Require(info.SizeHigh == 0 && info.SizeLow <= 1048576);
        using (var stream = new FileStream(file, FileAccess.Read)) {
          var bytes = new byte[info.SizeLow];
          int offset = 0;
          while (offset < bytes.Length) { int n = stream.Read(bytes, offset, bytes.Length - offset); Require(n > 0); offset += n; }
          return Encoding.UTF8.GetString(bytes);
        }
      }
    }
  }
  static bool Owned(SafeFileHandle h) {
    IntPtr owner, group, dacl, sacl, descriptor;
    Require(GetSecurityInfo(h, 1, 5, out owner, out group, out dacl, out sacl, out descriptor) == 0);
    try {
      Require(owner != IntPtr.Zero && dacl != IntPtr.Zero);
      var bytes = new byte[GetSecurityDescriptorLength(descriptor)];
      Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      var sd = new RawSecurityDescriptor(bytes, 0);
      Require(sd.DiscretionaryAcl != null && sd.DiscretionaryAcl.Count > 0);
      foreach (GenericAce entry in sd.DiscretionaryAcl) {
        var ace = entry as CommonAce;
        Require(ace != null && !ace.IsCallback);
        if (ace.AceQualifier == AceQualifier.AccessAllowed) {
          string sid = ace.SecurityIdentifier.Value;
          Require(sid != "S-1-1-0" && sid != "S-1-5-11" && sid != "S-1-5-32-545" && sid != "S-1-5-7");
        }
      }
      return sd.Owner == WindowsIdentity.GetCurrent().User;
    }
    finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
  }
  public static string SocketGeneration(string path) {
    // Node/libuv lstat returns EACCES on Windows AF_UNIX entries. Open only
    // reparse metadata, never follow a symlink/junction or read socket bytes.
    using (var h = CreateFileW(path, 0x80u, 3, IntPtr.Zero, 3, 0x00200000u | 0x02000000u, IntPtr.Zero)) {
      Require(!h.IsInvalid);
      AttributeTagInfo tag; FileInfo info;
      Require(GetFileInformationByHandleEx(h, 9, out tag, (uint)Marshal.SizeOf(typeof(AttributeTagInfo))));
      Require((tag.Attributes & 0x400u) != 0 && tag.Tag == 0x80000023u && (tag.Attributes & 0x10u) == 0);
      Require(GetFileInformationByHandle(h, out info));
      return info.Volume + ":" + info.IndexHigh + ":" + info.IndexLow + ":" + (uint)info.Created.dwHighDateTime + ":" + (uint)info.Created.dwLowDateTime;
    }
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
  if ($Operation -eq 'snapshot-login') {
    $auth = [CodexPrivatePath]::SnapshotLogin($TargetPath) | Microsoft.PowerShell.Utility\ConvertFrom-Json
    if ($null -ne $auth.OPENAI_API_KEY -or $null -eq $auth.tokens) { throw 'unsafe' }
    # Only the access/identity material needed by the live daemon crosses this
    # pipe. Native Codex remains the sole owner of refresh-token rotation.
    $safe = @{ auth_mode = $auth.auth_mode; OPENAI_API_KEY = $null; tokens = @{
      access_token = $auth.tokens.access_token; id_token = $auth.tokens.id_token; account_id = $auth.tokens.account_id
    } }
    [Console]::Out.WriteLine(($safe | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 4 -Compress))
    exit 0
  } elseif ($Operation -eq 'protect-login') {
      if ($Kind -ne 'directory') { throw 'unsafe' }
      $null = [CodexPrivatePath]::ProtectLogin($path)
    }
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
        $generation = [CodexPrivatePath]::SocketGeneration($canonical)
      }
    }
    $result = @{ path = $canonical }
    if ($Kind -eq 'socket') { $result.generation = $generation }
    [Console]::Out.WriteLine(($result | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    if ($Operation -eq 'hold') { $null = [Console]::In.ReadLine() }
  } finally { foreach ($guard in $guards) { $guard.Dispose() } }
} catch { [Console]::Error.WriteLine('windows_private_path_unsafe'); exit 1 }
