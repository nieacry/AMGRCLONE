$ErrorActionPreference = 'Stop'
$taskAllowed = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime')) + '\'
$taskTarget = [IO.Path]::GetFullPath($args[0])
if (-not $taskTarget.StartsWith($taskAllowed,[StringComparison]::OrdinalIgnoreCase)) { throw 'Only isolated project fixtures may be recycled' }
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class RecycleFixture {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Op {public IntPtr hwnd;public uint func;[MarshalAs(UnmanagedType.LPWStr)]public string from;[MarshalAs(UnmanagedType.LPWStr)]public string to;public ushort flags;[MarshalAs(UnmanagedType.Bool)]public bool aborted;public IntPtr maps;[MarshalAs(UnmanagedType.LPWStr)]public string title;}
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)] public static extern int SHFileOperation(ref Op op);
 public static int Recycle(string path){var op=new Op{func=3,from=path+"\0\0",flags=0x654};return SHFileOperation(ref op);}
}
'@
$taskResult=[RecycleFixture]::Recycle($taskTarget)
if ($taskResult -ne 0) { throw "Recycle operation failed: $taskResult" }
