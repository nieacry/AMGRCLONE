param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$runtime = Join-Path $workspace '.runtime'
if (!(Test-Path -LiteralPath $runtime -PathType Container)) { throw 'Runtime directory does not exist' }
if ((Get-Item -LiteralPath $runtime).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime must not be a link' }
$stage = Get-Content -LiteralPath (Join-Path $runtime 'release-stage.json') -Raw | ConvertFrom-Json
$currentStage = [IO.Path]::GetFullPath($stage.binary)
if (!$currentStage.StartsWith($runtime + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid current stage' }
$processes = @(Get-CimInstance Win32_Process)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AMGRuntimeCleanup {
  [DllImport("CldApi.dll", CharSet=CharSet.Unicode)]
  public static extern int CfGetSyncRootInfoByPath(string path, int kind, byte[] buffer, uint size, out uint returned);
}
'@
$guid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
$candidates = @(Get-ChildItem -LiteralPath $runtime -Directory | Where-Object {
  ($_.Name -match "^(package-|previous-publish-|publish-|publish-retry-)$guid`$" -or $_.Name -in @('portable-test','upgrade-test')) -and
  !$currentStage.StartsWith($_.FullName + '\', [StringComparison]::OrdinalIgnoreCase)
})
$plan = foreach ($candidate in $candidates) {
  $target = [IO.Path]::GetFullPath($candidate.FullName)
  if ([IO.Path]::GetDirectoryName($target) -ne $runtime) { throw 'Target is not a direct runtime child' }
  $reason = ''
  foreach ($process in $processes) {
    if ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { $reason = 'Running executable'; break }
    if ($process.CommandLine -and $process.CommandLine.IndexOf($target, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $reason = 'Referenced by a running process'; break }
  }
  $bytes = 0L
  $stack = [Collections.Generic.Stack[IO.FileSystemInfo]]::new()
  $stack.Push($candidate)
  $buffer = New-Object byte[] 65536
  while ($stack.Count -and !$reason) {
    $item = $stack.Pop()
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $reason = 'Contains a link or cloud placeholder'; break }
    if ($item -is [IO.DirectoryInfo]) {
      [uint32]$returned = 0
      $hr = [AMGRuntimeCleanup]::CfGetSyncRootInfoByPath($item.FullName, 1, $buffer, 65536, [ref]$returned)
      if ($hr -eq 0) { $reason = 'Contains a registered cloud root'; break }
      # Only the documented non-cloud-path result permits deletion. Unknown
      # failures (permissions, unavailable driver, etc.) keep the candidate.
      if ($hr -ne -2147024506) { $reason = ('Cloud-root check inconclusive: 0x{0:X8}' -f $hr); break }
      foreach ($child in $item.EnumerateFileSystemInfos()) { $stack.Push($child) }
    } else { $bytes += $item.Length }
  }
  [pscustomobject]@{Path=$target;Bytes=$bytes;Delete=(!$reason);KeptBecause=$reason}
}
$plan | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runtime 'cleanup-plan.json')
$plan | Select-Object @{N='Name';E={[IO.Path]::GetFileName($_.Path)}},@{N='GiB';E={[math]::Round($_.Bytes/1GB,3)}},Delete,KeptBecause | Format-Table -AutoSize
$total = ($plan | Where-Object Delete | Measure-Object Bytes -Sum).Sum
Write-Output ('Reclaimable GiB: ' + [math]::Round($total/1GB,3))
if (!$Apply) { Write-Output 'Dry run only. Use -Apply to remove the listed safe candidates.'; return }
foreach ($entry in $plan | Where-Object Delete) {
  # Revalidate each absolute target immediately before its recursive removal.
  $target = [IO.Path]::GetFullPath($entry.Path)
  if ([IO.Path]::GetDirectoryName($target) -ne $runtime -or $currentStage.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cleanup target' }
  if ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup target changed into a link' }
  Remove-Item -LiteralPath $target -Recurse -Force
  Write-Output ('Removed: ' + [IO.Path]::GetFileName($target))
}
