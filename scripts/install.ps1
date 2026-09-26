# ===========================================================================
# scripts/install.ps1 - sets Lantern up on this computer. Run it with
# "Install Lantern.cmd" (which passes its words on), from the unzipped folder.
#
#   Install Lantern.cmd                      asks its questions in the window
#   Install Lantern.cmd --quiet              no questions, no pauses (for other apps)
#
# Options (either -Name or --name):
#   --quiet          never ask; take the defaults below
#   --install-node   if Node.js is missing, install it with winget (only after
#                    the person has agreed to that, e.g. in Dayspring)
#   --no-shortcuts   no desktop / Start menu shortcuts
#   --no-protocol    do not register lantern:// links
#   --startup        start Lantern when Windows starts (quiet mode: off unless given)
#   --no-start       do not start Lantern at the end
#   --status <file>  where to write progress (default: <data>\install-status.json)
#
# Progress is written as JSON after every step, so another app can show it:
#   { "step": "...", "progress": 0-100, "ok": true|false, "message": "...",
#     "exitCode": null|n, "at": "..." }
#
# Exit codes:
#    0  installed
#   10  Node.js is missing and --install-node was not given (ask the person,
#       then run again with --install-node)
#   11  Node.js is missing and winget is not available (send the person to
#       https://nodejs.org, "LTS", then run again)
#   12  Lantern's self-test failed (the download may be damaged)
#   13  installing Node.js with winget failed
#   14  anything else (the message says what)
#
# Only this Windows user is touched: HKCU for lantern:// links, the user's own
# Start menu and desktop, and %LOCALAPPDATA%\Lantern for data.
# ===========================================================================

$ErrorActionPreference = 'Stop'
$flags = @{}
$statusFile = $null
for ($i = 0; $i -lt $args.Count; $i++) {
  $a = [string]$args[$i]
  $n = $a.TrimStart('-').ToLower()
  if ($n -eq 'status' -and $i + 1 -lt $args.Count) { $statusFile = [string]$args[$i + 1]; $i++; continue }
  $flags[$n] = $true
}
$quiet = $flags.ContainsKey('quiet')
$root = Split-Path -Parent $PSScriptRoot
$data = if ($env:LANTERN_DATA) { $env:LANTERN_DATA } else { Join-Path $env:LOCALAPPDATA 'Lantern' }
New-Item -ItemType Directory -Force -Path $data | Out-Null
if (-not $statusFile) { $statusFile = Join-Path $data 'install-status.json' }

function Status($step, $progress, $ok, $message, $code) {
  $o = [ordered]@{ step = $step; progress = $progress; ok = $ok; message = $message; exitCode = $code; root = $root; at = (Get-Date).ToString('o') }
  # UTF-8 WITHOUT a byte-order mark: other apps (Dayspring) read this with JSON.parse
  [IO.File]::WriteAllText($statusFile, ($o | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  if (-not $quiet) { if ($ok) { Write-Host "[ok] $message" } else { Write-Host "[!] $message" } }
}
function Finish($code, $step, $message) {
  Status $step 100 ($code -eq 0) $message $code
  if (-not $quiet -and $code -ne 0) { Read-Host 'Press Enter to close' | Out-Null }
  exit $code
}
function Ask($q) {
  if ($quiet) { return $false }
  $a = Read-Host "$q (Y/N)"
  return ($a -match '^[Yy]')
}
function NodeOk {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $false }
  $v = (& node -v) -replace '^v', ''
  $p = $v.Split('.') | ForEach-Object { [int]$_ }
  return ($p[0] -gt 22) -or ($p[0] -eq 22 -and $p[1] -ge 13)
}
function RefreshPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

try {
  if (-not $quiet) { Write-Host ''; Write-Host '  Lantern installer'; Write-Host '  -----------------'; Write-Host '' }

  # 1 - Node.js
  Status 'node' 10 $true 'Checking for Node.js 22.13 or newer' $null
  if (-not (NodeOk)) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    $want = $flags.ContainsKey('install-node')
    if (-not $want -and -not $quiet) { $want = Ask 'Lantern needs Node.js, and it is not installed (or it is too old). Install it now with winget (Microsoft''s installer)?' }
    if (-not $want) {
      if (-not $winget) { Finish 11 'node' 'Node.js is needed. Get it from https://nodejs.org (the LTS button), install it, then run the installer again.' }
      Finish 10 'node' 'Node.js is needed. Run the installer again with --install-node to install it with winget.'
    }
    if (-not $winget) { Finish 11 'node' 'Node.js is needed, and winget is not available here. Get Node.js from https://nodejs.org (the LTS button), then run the installer again.' }
    Status 'node' 20 $true 'Installing Node.js (this can take a few minutes)' $null
    & winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Null
    RefreshPath
    if (-not (NodeOk)) { Finish 13 'node' 'Installing Node.js did not work. Install it from https://nodejs.org, then run the installer again.' }
  }
  Status 'node' 35 $true ('Node.js ' + (& node -v)) $null

  # 2 - the data folder (never inside the program folder; updates never touch it)
  $cfg = Join-Path $data 'lantern.json'
  if (-not (Test-Path $cfg)) { [IO.File]::WriteAllText($cfg, (@{ mode = 'app' } | ConvertTo-Json), (New-Object Text.UTF8Encoding $false)) }
  Status 'data' 45 $true "Your data folder: $data" $null

  # 3 - does it start?
  Status 'selftest' 55 $true 'Checking that Lantern starts' $null
  $env:LANTERN_DB = ':memory:'
  & node (Join-Path $root 'server\src\index.js') --selftest | Out-Null
  $selftest = $LASTEXITCODE
  Remove-Item Env:\LANTERN_DB
  if ($selftest -ne 0) { Finish 12 'selftest' 'Lantern did not pass its start-up check. Download it again and re-run the installer.' }

  $wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
  $vbs = Join-Path $root 'scripts\launch-hidden.vbs'
  $icon = Join-Path $root 'lantern.ico'

  # 4 - shortcuts
  if (-not $flags.ContainsKey('no-shortcuts')) {
    $w = New-Object -ComObject WScript.Shell
    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Lantern'
    New-Item -ItemType Directory -Force -Path $menu | Out-Null
    function Mk($path, $vbsArgs, $desc) {
      $s = $w.CreateShortcut($path); $s.TargetPath = $wscript; $s.Arguments = "`"$vbs`" $vbsArgs"
      $s.WorkingDirectory = $root; if (Test-Path $icon) { $s.IconLocation = $icon }; $s.Description = $desc; $s.Save()
    }
    Mk (Join-Path $menu 'Lantern.lnk') '' 'Open Lantern'
    Mk (Join-Path $menu 'Stop Lantern.lnk') '--stop' 'Stop Lantern'
    $u = $w.CreateShortcut((Join-Path $menu 'Update Lantern.lnk')); $u.TargetPath = (Join-Path $root 'Update Lantern.cmd'); $u.WorkingDirectory = $root; $u.Save()
    Mk (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Lantern.lnk') '' 'Open Lantern'
    Status 'shortcuts' 70 $true 'Added Lantern to the Start menu and the desktop' $null
  }

  # 5 - lantern:// links (this user only)
  if (-not $flags.ContainsKey('no-protocol')) {
    $k = 'HKCU:\Software\Classes\lantern'
    New-Item -Path $k -Force | Out-Null
    Set-ItemProperty -Path $k -Name '(default)' -Value 'URL:Lantern'
    Set-ItemProperty -Path $k -Name 'URL Protocol' -Value ''
    New-Item -Path "$k\DefaultIcon" -Force | Out-Null
    Set-ItemProperty -Path "$k\DefaultIcon" -Name '(default)' -Value $icon
    New-Item -Path "$k\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path "$k\shell\open\command" -Name '(default)' -Value "`"$wscript`" `"$vbs`" `"%1`""
    Status 'protocol' 80 $true 'lantern:// links open Lantern' $null
  }

  # 6 - start with Windows
  $startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Lantern.lnk'
  $wantStartup = $flags.ContainsKey('startup')
  if (-not $quiet -and -not $wantStartup) { $wantStartup = Ask 'Start Lantern (quietly, in the background) when you sign in to Windows?' }
  if ($wantStartup) {
    $w = New-Object -ComObject WScript.Shell
    $s = $w.CreateShortcut($startup); $s.TargetPath = $wscript; $s.Arguments = "`"$vbs`" --hidden"; $s.WorkingDirectory = $root; $s.Save()
    Status 'startup' 90 $true 'Lantern will start when you sign in' $null
  } elseif (-not $quiet -and (Test-Path $startup)) { Remove-Item $startup -Force }   # quiet never undoes an earlier choice

  Status 'done' 100 $true 'Lantern is installed' 0
  if (-not $flags.ContainsKey('no-start')) {
    if ($quiet -or (Ask 'Open Lantern now?')) { Start-Process -FilePath $wscript -ArgumentList "`"$vbs`"" -WindowStyle Hidden }
  }
  exit 0
} catch {
  Finish 14 'error' ('The installer stopped: ' + $_.Exception.Message)
}
