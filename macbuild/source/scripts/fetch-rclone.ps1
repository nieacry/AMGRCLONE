$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolsRoot = Join-Path $projectRoot '.runtime\tools'
New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
$version = (Invoke-RestMethod -Uri 'https://downloads.rclone.org/version.txt').Trim()
if ($version -notmatch '^rclone (v[0-9]+\.[0-9]+\.[0-9]+)$') { throw 'Unexpected version response.' }
$release = $Matches[1]
$archiveName = "rclone-$release-windows-amd64.zip"
$baseUrl = "https://downloads.rclone.org/$release"
$archivePath = Join-Path $toolsRoot $archiveName
Invoke-WebRequest -Uri "$baseUrl/$archiveName" -OutFile $archivePath
$checksums = Invoke-RestMethod -Uri "$baseUrl/SHA256SUMS"
$checksumLine = ($checksums -split "`n" | Where-Object { $_ -match ('\s+\*?' + [regex]::Escape($archiveName) + '\s*$') } | Select-Object -First 1)
if (-not $checksumLine -or $checksumLine -notmatch '^([a-fA-F0-9]{64})\s') { throw 'Archive checksum missing.' }
$expected = $Matches[1]
$actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
if ($actual -ne $expected) { throw 'SHA-256 mismatch. Archive will not be extracted.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    $binary = $archive.GetEntry("rclone-$release-windows-amd64/rclone.exe")
    if (-not $binary) { throw 'Executable not found in archive.' }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($binary, (Join-Path $toolsRoot 'rclone.exe'), $true)
} finally { $archive.Dispose() }
Write-Output "Verified $version ($actual)"
& (Join-Path $toolsRoot 'rclone.exe') version
