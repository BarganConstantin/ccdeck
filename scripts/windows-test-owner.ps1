param([Parameter(Mandatory=$true)][string]$NodePath,[Parameter(Mandatory=$true)][string]$ArgumentsBase64,[Parameter(Mandatory=$true)][string]$WorkingDirectory,[switch]$ForceTokenFallback)
# An elevated CI token can default new files to Administrators ownership.
# Change only a duplicated child token's default owner. The calling process,
# elevation, groups, privileges and production credential checks stay intact.
$ErrorActionPreference='Stop'
$originalOwner=[Security.Principal.WindowsIdentity]::GetCurrent().Owner.Value
Microsoft.PowerShell.Utility\Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
public static class UserOwnedTestProcess {
  [StructLayout(LayoutKind.Sequential)] struct TokenOwner { public IntPtr Owner; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
    public int Size; public string Reserved,Desktop,Title; public int X,Y,Width,Height,XChars,YChars,Fill,Flags; public short Show,ReservedSize; public IntPtr ReservedBytes,Input,Output,Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint ProcessId,ThreadId; }
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr token,uint access,IntPtr attributes,int level,int type,out IntPtr copy);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int type,ref TokenOwner owner,uint size);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUserW(IntPtr token,string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessWithTokenW(IntPtr token,uint logon,string app,StringBuilder command,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr copy,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  static void Require(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char ch in value) {
      if(ch=='\\') { slashes++; continue; }
      if(ch=='\"') { b.Append('\\',slashes*2+1); b.Append(ch); }
      else { b.Append('\\',slashes); b.Append(ch); }
      slashes=0;
    }
    return b.Append('\\',slashes*2).Append('"').ToString();
  }
  static IntPtr Standard(int kind) {
    IntPtr handle=GetStdHandle(kind),copy;
    if(handle==IntPtr.Zero || handle==new IntPtr(-1)) return IntPtr.Zero;
    Require(DuplicateHandle(GetCurrentProcess(),handle,GetCurrentProcess(),out copy,0,true,2)); return copy;
  }
  public static int Run(string node,string[] args,string cwd,bool forceFallback) {
    using(var identity=WindowsIdentity.GetCurrent()) {
      if(identity.Owner==identity.User && !forceFallback) {
        var arguments=new StringBuilder();
        foreach(string arg in args) { if(arguments.Length>0)arguments.Append(' '); arguments.Append(Quote(arg)); }
        var start=new System.Diagnostics.ProcessStartInfo(node,arguments.ToString()) { UseShellExecute=false, WorkingDirectory=cwd };
        using(var process=System.Diagnostics.Process.Start(start)) { process.WaitForExit(); return process.ExitCode; }
      }
    }
    IntPtr token=IntPtr.Zero,environment=IntPtr.Zero; var info=new ProcessInfo(); var startup=new Startup();
    try {
      using(var identity=WindowsIdentity.GetCurrent()) {
        Require(DuplicateTokenEx(identity.Token,0xF01FF,IntPtr.Zero,2,1,out token));
        var sid=new byte[identity.User.BinaryLength]; identity.User.GetBinaryForm(sid,0);
        var pin=GCHandle.Alloc(sid,GCHandleType.Pinned);
        try { var owner=new TokenOwner {Owner=pin.AddrOfPinnedObject()}; Require(SetTokenInformation(token,4,ref owner,(uint)Marshal.SizeOf(typeof(TokenOwner)))); }
        finally { pin.Free(); }
      }
      startup.Size=Marshal.SizeOf(typeof(Startup)); startup.Flags=0x100;
      startup.Input=Standard(-10); startup.Output=Standard(-11); startup.Error=Standard(-12);
      var command=new StringBuilder(Quote(node)); foreach(string arg in args)command.Append(' ').Append(Quote(arg));
      var entries=Environment.GetEnvironmentVariables();
      var keys=new System.Collections.Generic.List<string>(); foreach(string key in entries.Keys)keys.Add(key);
      keys.Sort(StringComparer.OrdinalIgnoreCase);
      var block=new StringBuilder(); foreach(string key in keys)block.Append(key).Append('=').Append(entries[key]).Append('\0');
      block.Append('\0'); environment=Marshal.StringToHGlobalUni(block.ToString());
      if(forceFallback || !CreateProcessAsUserW(token,node,new StringBuilder(command.ToString()),IntPtr.Zero,IntPtr.Zero,true,0x400,environment,cwd,ref startup,out info)) {
        int error=forceFallback ? 1314 : Marshal.GetLastWin32Error(); if(error!=1314)throw new Win32Exception(error);
        Require(CreateProcessWithTokenW(token,0,node,new StringBuilder(command.ToString()),0x400,environment,cwd,ref startup,out info));
      }
      Require(WaitForSingleObject(info.Process,0xffffffff)==0); uint code; Require(GetExitCodeProcess(info.Process,out code)); return unchecked((int)code);
    } finally {
      if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);
      foreach(var h in new[]{info.Thread,info.Process,token,startup.Input,startup.Output,startup.Error})if(h!=IntPtr.Zero)CloseHandle(h);
    }
  }
}
'@
$nodeArgs=[string[]](Microsoft.PowerShell.Utility\ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64))))
# Prove both Node and a child it spawns create user-owned files before the
# suite starts. This catches token inheritance regressions without real logins.
$probe=Join-Path ([IO.Path]::GetTempPath()) ('ccdeck-test-owner-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($probe)|Out-Null
try {
  $code=@'
const fs=require("node:fs"),cp=require("node:child_process");fs.writeFileSync("parent.txt","fictional");const child=cp.spawnSync(process.execPath,["-e",'require("node:fs").writeFileSync("child.txt","fictional")'],{stdio:"inherit"});process.exitCode=child.status??1
'@
  $check=[UserOwnedTestProcess]::Run($NodePath,[string[]]@('-e',$code),$probe,$ForceTokenFallback.IsPresent)
  if($check -ne 0){throw 'test owner preflight failed'}
  $user=[Security.Principal.WindowsIdentity]::GetCurrent().User
  foreach($name in @('parent.txt','child.txt')) {
    $owner=[IO.File]::GetAccessControl((Join-Path $probe $name)).GetOwner([Security.Principal.SecurityIdentifier])
    if($owner -ne $user){throw 'test child did not inherit user ownership'}
  }
  if([Security.Principal.WindowsIdentity]::GetCurrent().Owner.Value -ne $originalOwner){throw 'launcher token was modified'}
} finally {[IO.Directory]::Delete($probe,$true)}
exit [UserOwnedTestProcess]::Run($NodePath,$nodeArgs,$WorkingDirectory,$ForceTokenFallback.IsPresent)
