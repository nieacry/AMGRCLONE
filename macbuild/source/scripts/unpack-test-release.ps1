param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime')) + '\'
$taskDestination = [IO.Path]::GetFullPath($Destination)
if (-not $taskDestination.StartsWith($taskRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Only isolated test destinations are allowed' }
Expand-Archive -LiteralPath $Archive -DestinationPath $taskDestination
