<#
.SYNOPSIS
  Still uninstaller for Windows.

.DESCRIPTION
  Removes the Still application and everything Still wrote to this computer:
  the installed program, Start menu and desktop shortcuts, uninstall registry
  entries, settings, saved servers, themes, WebView2 storage, caches and logs.
  It never deletes project folders. Code that earlier versions kept inside
  Still's data folder is moved to "Still Rescued Projects" in your user folder.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File uninstall.ps1
  powershell -ExecutionPolicy Bypass -File uninstall.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Source C:\code\still
#>
param(
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$Gui,
  [int]$WaitPid = 0,
  [string]$AppPath = "",
  [string]$Source = ""
)

$ErrorActionPreference = "Continue"
$Identifier = "dev.still.editor"
$Binary = "still-ide"
$Product = "Still"

function Test-StillPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($full -eq [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')) { return $false }
  if ($full.Length -le 3) { return $false }
  return $full -match '(?i)still'
}

$remove = New-Object System.Collections.Generic.List[string]
function Add-Target([string]$Path) {
  if ($Path -and (Test-Path -LiteralPath $Path) -and (Test-StillPath $Path) -and -not $remove.Contains($Path)) { $remove.Add($Path) }
}

# ---- Installed program ------------------------------------------------------
$uninstallers = @()
$roots = @(
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
  "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
)
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
    $entry = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
    if (-not $entry -or $entry.DisplayName -ne $Product) { continue }
    $evidence = "$($entry.DisplayIcon) $($entry.InstallLocation) $($entry.UninstallString)"
    if ($evidence -notmatch "(?i)$Binary|\\$Product\\") { continue }
    $uninstallers += [pscustomobject]@{
      Key = $key.PSPath; Name = $entry.DisplayName; Location = $entry.InstallLocation
      Quiet = $entry.QuietUninstallString; Command = $entry.UninstallString
    }
  }
}

$installDirs = @("$env:LOCALAPPDATA\$Product", "$env:LOCALAPPDATA\Programs\$Product", "$env:ProgramFiles\$Product", "${env:ProgramFiles(x86)}\$Product")
if ($AppPath -and (Split-Path -Leaf $AppPath) -like "$Binary*.exe") {
  $dir = Split-Path -Parent $AppPath
  if ($dir -notmatch '(?i)\\target\\(debug|release)') { $installDirs += $dir }
}
foreach ($u in $uninstallers) { if ($u.Location) { $installDirs += $u.Location.Trim('"') } }
foreach ($dir in ($installDirs | Select-Object -Unique)) {
  if ($dir -and (Test-Path -LiteralPath (Join-Path $dir "$Binary.exe"))) { Add-Target $dir }
}

# ---- Data, shortcuts and leftovers ------------------------------------------
$dataDirs = @("$env:APPDATA\$Identifier", "$env:LOCALAPPDATA\$Identifier", "$env:APPDATA\$Binary", "$env:LOCALAPPDATA\$Binary")
foreach ($dir in $dataDirs) { Add-Target $dir }
$shortcutDirs = @(
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
  "$env:ProgramData\Microsoft\Windows\Start Menu\Programs",
  [Environment]::GetFolderPath("Desktop"),
  "$env:PUBLIC\Desktop"
)
foreach ($dir in $shortcutDirs) {
  if ($dir) { Add-Target (Join-Path $dir "$Product.lnk"); Add-Target (Join-Path $dir "$Product\$Product.lnk") }
}
Get-ChildItem -LiteralPath $env:TEMP -Filter "still-uninstall-*.ps1" -ErrorAction SilentlyContinue | ForEach-Object { if ($_.FullName -ne $PSCommandPath) { Add-Target $_.FullName } }
$registryLeftovers = @("HKCU:\Software\$Product\$Product", "HKCU:\Software\$Identifier") | Where-Object { Test-Path $_ }
# The still command and the File Explorer entries (Open with Still, Open with).
Add-Target "$env:LOCALAPPDATA\Microsoft\WindowsApps\still.cmd"
$explorerKeys = @(
  "HKCU:\Software\Classes\Directory\shell\Still",
  "HKCU:\Software\Classes\Directory\Background\shell\Still",
  "HKCU:\Software\Classes\*\shell\Still",
  "HKCU:\Software\Classes\Still.Source",
  "HKCU:\Software\Classes\Applications\still-ide.exe"
) | Where-Object { Test-Path -LiteralPath $_ }

# ---- Kept folders -----------------------------------------------------------
$keep = @()
$configFile = "$env:APPDATA\$Identifier\config.json"
if (Test-Path -LiteralPath $configFile) {
  try {
    $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    if ($config.projectsRoot) { $keep += $config.projectsRoot }
    foreach ($p in $config.projects) { if ($p.path) { $keep += $p.path } }
  } catch { }
}
$rescueFrom = "$env:LOCALAPPDATA\$Identifier\orbit-lab"
$rescueTo = Join-Path $env:USERPROFILE "Still Rescued Projects"

$sourceBuild = @()
if ($Source) {
  $conf = Join-Path $Source "src-tauri\tauri.conf.json"
  if ((Test-Path -LiteralPath $conf) -and ((Get-Content -LiteralPath $conf -Raw) -match [regex]::Escape($Identifier))) {
    foreach ($b in @("node_modules", "dist", "src-tauri\target", "src-tauri\gen")) {
      $path = Join-Path $Source $b
      if (Test-Path -LiteralPath $path) { $sourceBuild += $path }
    }
  } else {
    Write-Output "SKIP $Source is not a Still source checkout"
  }
}

# ---- Report -----------------------------------------------------------------
Write-Output "Still uninstaller"
Write-Output ""
foreach ($u in $uninstallers) { Write-Output "PACKAGE windows $($u.Name) ($($u.Command))" }
foreach ($item in $remove) { Write-Output "REMOVE $item" }
foreach ($item in $registryLeftovers) { Write-Output "REMOVE $item" }
foreach ($item in $sourceBuild) { Write-Output "REMOVE $item" }
if (Test-Path -LiteralPath $rescueFrom) { Write-Output "RESCUE $rescueFrom -> $rescueTo\orbit-lab" }
foreach ($item in ($keep | Select-Object -Unique)) { Write-Output "KEEP $item" }
if (-not $uninstallers -and -not $remove.Count -and -not $registryLeftovers -and -not $sourceBuild) { Write-Output "NOTHING Still is not installed for this user." }
if ($DryRun) { exit 0 }

if (-not $Yes) {
  $answer = Read-Host "`nRemove everything listed above? Projects are kept. [y/N]"
  if ($answer -notmatch '^(y|yes)$') { Write-Output "Nothing was changed."; exit 0 }
}

# ---- Uninstall --------------------------------------------------------------
if ($WaitPid -gt 0) { Wait-Process -Id $WaitPid -Timeout 30 -ErrorAction SilentlyContinue }
Get-Process -Name $Binary -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath $rescueFrom) {
  New-Item -ItemType Directory -Force -Path $rescueTo | Out-Null
  Move-Item -LiteralPath $rescueFrom -Destination (Join-Path $rescueTo "orbit-lab") -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $rescueFrom) { Write-Output "Could not move $rescueFrom; stopping so no code is lost."; exit 1 }
  Write-Output "Moved Orbit Lab to $rescueTo\orbit-lab"
}

$failed = @()
foreach ($u in $uninstallers) {
  try {
    if ($u.Command -match '(?i)msiexec.*(\{[0-9A-F-]+\})') {
      $code = $Matches[1]
      $p = Start-Process msiexec.exe -ArgumentList "/x $code /qb /norestart" -Wait -PassThru
    } else {
      $exe = if ($u.Quiet) { $u.Quiet } else { $u.Command }
      if ($exe -match '^"([^"]+)"\s*(.*)$') { $file = $Matches[1]; $rest = $Matches[2] } else { $file = $exe; $rest = "" }
      $dir = Split-Path -Parent $file
      if ($rest -notmatch '/S') { $rest = "$rest /S" }
      # _?= keeps the NSIS uninstaller in place so we can wait for it to finish.
      $p = Start-Process -FilePath $file -ArgumentList "$rest _?=$dir" -Wait -PassThru
    }
    if ($p.ExitCode -ne 0) { $failed += $u.Name }
    Remove-Item -LiteralPath $u.Key -Recurse -Force -ErrorAction SilentlyContinue
    Write-Output "Uninstalled $($u.Name)"
  } catch { $failed += $u.Name; Write-Output "Could not run the uninstaller: $_" }
}

foreach ($item in (@($remove) + @($sourceBuild))) {
  if (-not (Test-Path -LiteralPath $item)) { Write-Output "Removed $item"; continue }
  Remove-Item -LiteralPath $item -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $item) { $failed += $item; Write-Output "Could not remove $item" } else { Write-Output "Removed $item" }
}
foreach ($key in $registryLeftovers) {
  Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output "Removed $key"
}
foreach ($key in $explorerKeys) {
  Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output "Removed $key"
}
Get-ChildItem -LiteralPath "HKCU:\Software\Classes" -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -like '.*' } | ForEach-Object {
  $progids = Join-Path $_.PSPath 'OpenWithProgids'
  if ((Test-Path -LiteralPath $progids) -and ((Get-Item -LiteralPath $progids).Property -contains 'Still.Source')) {
    Remove-ItemProperty -LiteralPath $progids -Name 'Still.Source' -ErrorAction SilentlyContinue
  }
}
$vendor = "HKCU:\Software\$Product"
if ((Test-Path $vendor) -and -not (Get-ChildItem $vendor -ErrorAction SilentlyContinue) -and -not ((Get-Item $vendor).Property)) {
  Remove-Item $vendor -Force -ErrorAction SilentlyContinue
}

$message = if ($failed.Count) { "Still was removed, except: $($failed -join ', ')" } else { "Still was removed. Your projects were not touched." }
Write-Output ""
Write-Output $message
if ($Gui) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($message, "Still") | Out-Null
}
if ($PSCommandPath -like "$env:TEMP\still-uninstall-*") { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue }
exit 0
