param(
  [string]$Workspace = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
)

$ErrorActionPreference = "Stop"

$workspacePath = (Resolve-Path $Workspace).Path
$logDir = Join-Path $workspacePath ".codex-logs"
$outLog = Join-Path $logDir "dev-desktop.out.log"
$errLog = Join-Path $logDir "dev-desktop.err.log"
$defaultStateDir = Join-Path $HOME ".t3-mine/userdata"
$fallbackStateDir = Join-Path $HOME ".t3/userdata"
$stateDir = if ($env:T3CODE_STATE_DIR -and (Test-Path $env:T3CODE_STATE_DIR)) {
  $env:T3CODE_STATE_DIR
} elseif (Test-Path $defaultStateDir) {
  $defaultStateDir
} elseif (Test-Path $fallbackStateDir) {
  $fallbackStateDir
} else {
  $null
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Write-Host "[t3-dev-desktop-start] Prebuilding desktop artifacts."
Push-Location $workspacePath
try {
  & bun run --filter @t3tools/desktop build
} finally {
  Pop-Location
}

$runner = Start-Process -FilePath "cmd.exe" `
  -ArgumentList @("/c", $(if ($stateDir) {
    "set T3CODE_STATE_DIR=$stateDir&& bun run dev:desktop"
  } else {
    "bun run dev:desktop"
  })) `
  -WorkingDirectory $workspacePath `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -PassThru

Start-Sleep -Seconds 4
if ($runner.HasExited) {
  throw "dev:desktop exited early with code $($runner.ExitCode). See $outLog and $errLog"
}

$requiredDesktopFiles = @(
  "apps/desktop/dist-electron/bootstrap.js",
  "apps/desktop/dist-electron/main.js",
  "apps/desktop/dist-electron/preload.js"
) | ForEach-Object { Join-Path $workspacePath $_ }

$missing = @($requiredDesktopFiles | Where-Object { -not (Test-Path $_) })
if ($missing.Count -gt 0) {
  Write-Host "[t3-dev-desktop-start] Missing dist-electron outputs; running one-time desktop build."
  Push-Location $workspacePath
  try {
    & bun run --filter @t3tools/desktop build
  } finally {
    Pop-Location
  }
}

$deadline = (Get-Date).AddSeconds(45)
do {
  $electronCount = @(Get-Process electron -ErrorAction SilentlyContinue).Count
  if ($electronCount -gt 0) {
    break
  }
  Start-Sleep -Milliseconds 600
} while ((Get-Date) -lt $deadline)

$electronCount = @(Get-Process electron -ErrorAction SilentlyContinue).Count
if ($electronCount -eq 0) {
  throw "Electron did not appear. Inspect logs at $outLog and $errLog"
}

Write-Host "[t3-dev-desktop-start] Desktop dev app is running."
if ($stateDir) {
  Write-Host "[t3-dev-desktop-start] Bound state dir: $stateDir"
}
Write-Host "[t3-dev-desktop-start] Logs: $outLog"
Write-Host "[t3-dev-desktop-start] Logs: $errLog"
