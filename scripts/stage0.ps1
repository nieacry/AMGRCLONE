<#
  Stage 0 of the roadmap: put the project under git and tidy the workspace.

  Safe by design:
    - nothing is deleted except the duplicate launcher, and only if it is byte-identical;
    - loose files in .runtime are MOVED to .runtime\_archive-<date>, folders are not touched;
    - verification reports are MOVED to docs\verification;
    - the first commit is made only after a size check of everything being committed.

  Usage (from the project folder, in PowerShell):
    powershell -ExecutionPolicy Bypass -File scripts\stage0.ps1            # dry run, prints the plan
    powershell -ExecutionPolicy Bypass -File scripts\stage0.ps1 -Apply     # do it
    ... -Apply -GitHub -RepoName amg-rclone-ui                             # also create a private GitHub repo and push
    ... -Releases                                                          # upload versions\*.zip as GitHub releases
#>
param(
  [switch]$Apply,
  [switch]$GitHub,
  [string]$RepoName = 'amg-rclone-ui',
  [switch]$Releases
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
Set-Location -LiteralPath $root
function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Plan($text) { if ($Apply) { Write-Host "   $text" } else { Write-Host "   [dry run] $text" -ForegroundColor DarkGray } }

if (!(Test-Path -LiteralPath (Join-Path $root 'package.json'))) { throw "package.json not found in $root" }

# --- 1. .runtime: archive loose one-off files -------------------------------------------
Step '.runtime: move loose files to an archive folder'
$runtime = Join-Path $root '.runtime'
$keep = @('release-stage.json')   # read by release.mjs and cleanup-runtime.ps1
if (Test-Path -LiteralPath $runtime) {
  $archive = Join-Path $runtime ('_archive-' + (Get-Date -Format 'yyyyMMdd'))
  $loose = @(Get-ChildItem -LiteralPath $runtime -File | Where-Object { $keep -notcontains $_.Name })
  Write-Host ("   {0} loose files -> {1}" -f $loose.Count, $archive)
  if ($Apply -and $loose.Count) {
    New-Item -ItemType Directory -Force -Path $archive | Out-Null
    foreach ($file in $loose) { Move-Item -LiteralPath $file.FullName -Destination $archive }
  }
  Write-Host '   Folders in .runtime are left alone (test roots may be registered cloud roots).'
  Write-Host '   Report of removable build folders (existing cleanup script, dry run):'
  try { & (Join-Path $PSScriptRoot 'cleanup-runtime.ps1') } catch { Write-Host "   cleanup-runtime report skipped: $($_.Exception.Message)" -ForegroundColor Yellow }
}

# --- 2. docs: verification reports into docs\verification ------------------------------
Step 'docs: move VERIFICATION*.md to docs\verification'
$docs = Join-Path $root 'docs'
$target = Join-Path $docs 'verification'
$reports = @(Get-ChildItem -LiteralPath $docs -File -Filter 'VERIFICATION*.md')
Plan ("{0} files -> docs\verification" -f $reports.Count)
if ($Apply -and $reports.Count) {
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  foreach ($file in $reports) {
    $destination = Join-Path $target $file.Name
    if (Test-Path -LiteralPath $destination) { throw "Already exists: $destination" }
    Move-Item -LiteralPath $file.FullName -Destination $destination
  }
}

# --- 3. duplicate launcher ---------------------------------------------------------------
Step 'Remove the duplicate launcher (*Cloudlane.cmd) if identical to the main one'
$duplicate = Get-ChildItem -LiteralPath $root -File -Filter '*Cloudlane.cmd' | Select-Object -First 1
$main = Get-ChildItem -LiteralPath $root -File -Filter '*AMG rclone UI.cmd' | Select-Object -First 1
if ($duplicate -and $main) {
  $same = (Get-FileHash -LiteralPath $duplicate.FullName).Hash -eq (Get-FileHash -LiteralPath $main.FullName).Hash
  if ($same) { Plan "delete $($duplicate.Name)"; if ($Apply) { Remove-Item -LiteralPath $duplicate.FullName } }
  else { Write-Host '   Launchers differ - kept both, please compare them manually.' -ForegroundColor Yellow }
} else { Write-Host '   Nothing to do.' }

# --- 3b. CI workflow ----------------------------------------------------------------------
Step 'CI: install scripts\github-ci.yml as .github\workflows\ci.yml'
$ciSource = Join-Path $PSScriptRoot 'github-ci.yml'
$ciTarget = Join-Path $root '.github\workflows\ci.yml'
if (Test-Path -LiteralPath $ciTarget) { Write-Host '   Already installed.' }
elseif (Test-Path -LiteralPath $ciSource) {
  Plan 'move scripts\github-ci.yml -> .github\workflows\ci.yml'
  if ($Apply) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ciTarget) | Out-Null; Move-Item -LiteralPath $ciSource -Destination $ciTarget }
} else { Write-Host '   scripts\github-ci.yml not found - skipped.' -ForegroundColor Yellow }

# --- 4. git ------------------------------------------------------------------------------
Step 'git: init and first commit'
if (!(Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is not installed: https://git-scm.com/download/win' }
$hasRepo = Test-Path -LiteralPath (Join-Path $root '.git')
if ($hasRepo) { Write-Host '   .git already exists - init skipped.' }
elseif ($Apply) { git init -b main | Out-Host }
else { Plan 'git init -b main' }

if ($Apply) {
  if (!(git config user.name) -or !(git config user.email)) {
    throw 'Set your git identity first: git config --global user.name "Name"; git config --global user.email "you@example.com"'
  }
  git -c core.safecrlf=false add -A 2>&1 | Where-Object { $_ -notmatch 'CRLF|LF will be replaced' } | Out-Host
  # Refuse to commit anything large: releases, profiles and binaries belong outside git.
  $large = @(git diff --cached --name-only -z | ForEach-Object { $_ -split "`0" } | Where-Object { $_ } |
    Where-Object { (Get-Item -LiteralPath (Join-Path $root $_) -ErrorAction SilentlyContinue).Length -gt 5MB })
  if ($large.Count) { git reset -q; throw ("Files over 5 MB are staged, nothing committed:`n" + ($large -join "`n")) }
  $count = @(git diff --cached --name-only).Count
  Write-Host "   $count files staged."
  $ErrorActionPreference = 'Continue'; git rev-parse -q --verify HEAD 2>$null | Out-Null; $hasCommit = ($LASTEXITCODE -eq 0); $ErrorActionPreference = 'Stop'
  if ($hasCommit) { Write-Host '   Repository already has commits - initial commit skipped; review and commit the changes yourself.' }
  if ($count -and !$hasCommit) {
    $version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    $message = @"
Initial import of AMG rclone UI $version

Stage 0 of the roadmap: git, CI, .gitattributes, docs refresh,
verification reports moved to docs/verification, duplicate launcher removed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011SeQ1oozuRL1oLdHhJYHSs
"@
    $messageFile = Join-Path ([IO.Path]::GetTempPath()) ('amg-commit-' + [guid]::NewGuid() + '.txt')
    [IO.File]::WriteAllText($messageFile, $message, (New-Object Text.UTF8Encoding $false))
    try { git commit -q -F $messageFile; git log --oneline -1 | Out-Host } finally { Remove-Item -LiteralPath $messageFile }
    git tag "v$version"
  }
} else { Plan 'git add -A, size check (>5 MB is refused), first commit, tag v<version>' }

# --- 5. GitHub (optional) ----------------------------------------------------------------
if ($GitHub -or $Releases) {
  Step 'GitHub'
  if (!(Get-Command gh -ErrorAction SilentlyContinue)) { throw 'GitHub CLI is not installed: winget install GitHub.cli, then gh auth login' }
  gh auth status | Out-Host
  if ($GitHub) {
    Plan "gh repo create $RepoName --private --source . --push"
    if ($Apply) { gh repo create $RepoName --private --source . --remote origin --push; git push origin --tags }
  }
  if ($Releases) {
    foreach ($zip in Get-ChildItem -LiteralPath (Join-Path $root 'versions') -File -Filter '*.zip') {
      if ($zip.Name -notmatch '(\d+\.\d+\.\d+)') { continue }
      $tag = 'v' + $Matches[1]
      $assets = @($zip.FullName)
      if (Test-Path -LiteralPath ($zip.FullName + '.sha256')) { $assets += ($zip.FullName + '.sha256') }
      Plan "release $tag <- $($zip.Name)"
      if ($Apply) {
        $ErrorActionPreference = 'Continue'; gh release view $tag 2>$null | Out-Null; $exists = ($LASTEXITCODE -eq 0); $ErrorActionPreference = 'Stop'
        if ($exists) { Write-Host "   $tag already exists - skipped."; continue }
        # Older versions have no commit of their own; their tag points at the initial import.
        gh release create $tag @assets --title "AMG rclone UI $($Matches[1])" --notes "Windows x64 portable build. See docs/verification for checks." --target main
      }
    }
  }
}

Write-Host ''
if ($Apply) { Write-Host 'Done.' -ForegroundColor Green } else { Write-Host 'Dry run finished. Re-run with -Apply to make the changes.' -ForegroundColor Green }
