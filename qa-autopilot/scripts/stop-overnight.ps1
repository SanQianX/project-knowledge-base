$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# 只结束 overnight supervisor 进程；绝不触碰开发知识库（Project Knowledge 桌面端）或任何 node 测试进程。
$targets = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains('overnight-supervisor') }
if (-not $targets) { Write-Host '  (no overnight supervisor running)' }
foreach ($p in $targets) {
  Write-Host ("  stopping supervisor node PID {0}" -f $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force
}
Start-Sleep -Seconds 2
$stateDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'state/overnight'
Remove-Item -Path (Join-Path $stateDir 'supervisor.lock') -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $stateDir 'supervisor.pid') -ErrorAction SilentlyContinue
Write-Host '  lock and pid file cleared'
