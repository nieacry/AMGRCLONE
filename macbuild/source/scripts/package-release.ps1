param([Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$Archive)
$ErrorActionPreference = 'Stop'
$taskWorkspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$taskAllowed = (Join-Path $taskWorkspace '.runtime') + '\'
$taskSource = [IO.Path]::GetFullPath($Source)
$taskArchive = [IO.Path]::GetFullPath($Archive)
if (-not $taskSource.StartsWith($taskAllowed,[StringComparison]::OrdinalIgnoreCase) -or -not $taskArchive.StartsWith($taskAllowed,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected release staging path' }
if (Test-Path -LiteralPath $taskArchive) { throw 'Archive already exists' }
Compress-Archive -LiteralPath $taskSource -DestinationPath $taskArchive -CompressionLevel Optimal
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskZip = [IO.Compression.ZipFile]::OpenRead($taskArchive)
try {
  $taskEntries = @($taskZip.Entries | Where-Object { $_.Name } | ForEach-Object { $_.FullName.Replace('\','/') } | Sort-Object)
  $taskExpected = @(Get-ChildItem -LiteralPath $taskSource -File -Recurse -Force | ForEach-Object { (Split-Path -Leaf $taskSource) + '/' + $_.FullName.Substring($taskSource.Length+1).Replace('\','/') } | Sort-Object)
  if (Compare-Object $taskExpected $taskEntries) { throw 'Distribution archive does not contain the complete application' }
} finally { $taskZip.Dispose() }
