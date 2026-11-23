<#
.SYNOPSIS
  Build and install Still from source on Windows.

.DESCRIPTION
  Checks prerequisites, builds the per-user installer (no administrator rights
  needed) and runs it. Remove everything again with uninstall\uninstall.ps1 or
  from Settings > About & uninstall.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Silent
#>
param([switch]$Silent)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$root = Get-Location

function Fail([string]$Message) { Write-Host "`n$Message" -ForegroundColor Red; exit 1 }
function Say([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }

Say "Checking prerequisites"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js 22.12 or newer is required: https://nodejs.org (or: winget install OpenJS.NodeJS.LTS)" }
$nodeVersion = [version]((node -v).TrimStart('v'))
if ($nodeVersion -lt [version]"22.12.0") { Fail "Node.js $nodeVersion is too old. Install 22.12 or newer: winget install OpenJS.NodeJS.LTS" }
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Fail "Rust is required. Install it with:`n  winget install Rustlang.Rustup`nthen open a new terminal and run this script again."
}
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasBuildTools = (Test-Path $vswhere) -and (& $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if (-not $hasBuildTools) {
  Fail "Microsoft C++ Build Tools are required. Install them with:`n  winget install Microsoft.VisualStudio.2022.BuildTools --override `"--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended`""
}
foreach ($tool in @("git", "python", "java", "ssh")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Write-Host "    note: $tool was not found; Still works without it, but related features stay off." }
}

Say "Installing JavaScript dependencies"
npm ci
if ($LASTEXITCODE -ne 0) { Fail "npm ci failed." }

Say "Building the installer (this takes a few minutes the first time)"
npm run tauri -- build --bundles nsis
if ($LASTEXITCODE -ne 0) { Fail "The build failed." }

$setup = Get-ChildItem "$root\src-tauri\target\release\bundle\nsis\*-setup.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { Fail "The build did not produce an installer." }

Say "Running $($setup.Name)"
$arguments = if ($Silent) { "/S" } else { "" }
$process = Start-Process -FilePath $setup.FullName -ArgumentList $arguments -Wait -PassThru
if ($process.ExitCode -ne 0) { Fail "The installer exited with code $($process.ExitCode)." }

Write-Host "`nStill is installed for your user account. Start it from the Start menu."
Write-Host "To uninstall later: Settings > About & uninstall, or run:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$root\uninstall\uninstall.ps1`""
