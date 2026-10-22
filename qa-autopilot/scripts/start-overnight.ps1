<#
  T03-OVERNIGHT · overnight QA Autopilot launcher

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-overnight.ps1           # start (or show status if already running)
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-overnight.ps1 -Status  # status only
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-overnight.ps1 -Stop    # stop scheduling (never touches the dev KB)

  The supervisor is an independent node process: it survives the model session.
  When the quota is low it enters PAUSED_QUOTA and keeps polling; when the quota
  recovers it resumes automatically.

  NOTE: this file is UTF-8 with BOM so Windows PowerShell 5.1 parses it.
#>
[CmdletBinding()]
param(
  [switch]$Status,
  [switch]$Stop,
  [switch]$RebuildQueue
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$QaRoot     = Split-Path -Parent $PSScriptRoot
$Config     = Join-Path $QaRoot 'config/local.json'
$StateDir   = Join-Path $QaRoot 'state/overnight'
$Evidence   = Join-Path $QaRoot 'artifacts/overnight'
$Journal    = Join-Path $StateDir 'journal.jsonl'
$PidFile    = Join-Path $StateDir 'supervisor.pid'
$Acceptance = Join-Path $QaRoot 'reports/branches/OVERNIGHT_ACCEPTANCE.json'
$LedgerPath = Join-Path $QaRoot 'reports/branches/T07B_LEDGER.json'
$Supervisor = Join-Path $QaRoot 'tools/overnight-supervisor.cjs'
$SelfCheck  = Join-Path $QaRoot 'scripts/qa.cjs'

function Get-SupervisorProcess {
  if (-not (Test-Path $PidFile)) { return $null }
  $raw = (Get-Content $PidFile -Raw).Trim()
  if (-not $raw) { return $null }
  $p = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  return $p
}

# JSON is read by node: Windows PowerShell 5.1 ConvertFrom-Json chokes on the
# report files. node prints flat KEY=VALUE lines; PowerShell splits on '='.
function Get-Fields([string]$Script, [string[]]$ScriptArgs) {
  $out = @{}
  try {
    $text = & node -e $Script @ScriptArgs 2>$null
    foreach ($line in @($text)) {
      if ($null -eq $line) { continue }
      $s = [string]$line
      if ($s.IndexOf('=') -lt 0) { continue }
      $parts = $s.Split('=', 2)
      $out[$parts[0]] = $parts[1]
    }
  } catch { }
  return $out
}

function Get-StateFields {
  return Get-Fields @'
const fs=require('fs'),path=require('path');
const f=path.join(process.argv[1],'state.json');
if(!fs.existsSync(f)){console.log('phase=NONE');process.exit(0);}
const s=JSON.parse(fs.readFileSync(f,'utf8'));
let cur='',curId='';
for(const id of (s.order||[])){const t=s.tasks[id];if(t&&['DISPATCHING','AGENT_RUNNING','VERIFYING','COMMITTING','CI_PENDING','PAUSED_QUOTA'].indexOf(t.status)>=0){cur=t.status;curId=id;break;}}
let done=0,failed=0,pending=0;
for(const id of (s.order||[])){const t=s.tasks[id];if(!t)continue;if(t.status==='DONE')done++;else if(t.status==='FAILED'||t.status==='BLOCKED_CI')failed++;else pending++;}
const q=s.quota||{};
console.log('phase='+(s.phase||''));
console.log('cur='+cur);
console.log('curId='+curId);
console.log('quotaState='+(s.quotaState||''));
console.log('fiveHour='+(q.fiveHourRemainingPercent===undefined?'?':q.fiveHourRemainingPercent));
console.log('weekly='+(q.weeklyRemainingPercent===undefined?'?':q.weeklyRemainingPercent));
console.log('done='+done);console.log('failed='+failed);console.log('pending='+pending);
'@ @($StateDir)
}

function Get-LedgerFields {
  return Get-Fields @'
const fs=require('fs');
const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const c=j.counts||{};
['COVERED','PARTIAL','NOT_COVERED','BLOCKED'].forEach(k=>console.log(k+'='+(c[k]||0)));
'@ @($LedgerPath)
}

function Get-QueueCount {
  $f = Join-Path $StateDir 'queue.json'
  if (-not (Test-Path $f)) { return 0 }
  $q = Get-Fields @'
const fs=require('fs');
const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
console.log('n='+((j.tasks||[]).length));
'@ @($f)
  if ($q['n']) { return [int]$q['n'] }
  return 0
}

function Get-DevKbFields {
  return Get-Fields @'
const {devKbHealth}=require(process.argv[1]);
const h=devKbHealth();
console.log('ok='+(h.ok?'YES':'NO'));
console.log('passed='+(h.passed||0));
console.log('total='+(h.total||0));
'@ @($Supervisor)
}

function Show-Status {
  $cfg = Get-Content $Config -Raw -Encoding UTF8 | ConvertFrom-Json
  $proc = Get-SupervisorProcess
  $st = Get-StateFields
  $led = Get-LedgerFields
  $qtotal = Get-QueueCount
  $dev = Get-DevKbFields

  $gitSha='n/a'; $gitBranch='n/a'; $remoteSha='n/a'
  try {
    $gitSha = (git -C $cfg.repoRoot rev-parse HEAD).Trim()
    $gitBranch = (git -C $cfg.repoRoot rev-parse --abbrev-ref HEAD).Trim()
    $remoteSha = ((git -C $cfg.repoRoot ls-remote origin "refs/heads/$(if ($cfg.mainBranch) { $cfg.mainBranch } else { 'main' })") -split '\s+')[0]
  } catch { }

  Write-Host ''
  Write-Host '==================== overnight QA Autopilot ===================='
  Write-Host ("  Supervisor      : {0}  (PID {1})" -f $(if ($proc) { 'RUNNING' } else { 'STOPPED' }), $(if ($proc) { $proc.Id } else { '-' }))
  Write-Host ("  Worker          : adapterValidated={0} kind=zcode-cli mode={1} disallowed={2}" -f $cfg.worker.adapterValidated, $cfg.worker.mode, ($cfg.worker.disallowedTools -join ','))
  Write-Host ("  Phase / Test ID : {0} / {1}" -f $(if ($st['cur']) { $st['cur'] } else { $st['phase'] }), $(if ($st['curId']) { $st['curId'] } else { '-' }))
  Write-Host ("  Quota (real)    : five-hour {0}%  weekly {1}%  state {2}" -f $st['fiveHour'], $st['weekly'], $st['quotaState'])
  Write-Host ("  Specs           : covered {0}  partial {1}  not-covered {2}  blocked {3}" -f $led['COVERED'], $led['PARTIAL'], $led['NOT_COVERED'], $led['BLOCKED'])
  Write-Host ("  Tasks           : done {0}  pending {1}  failed {2}  of {3}" -f $st['done'], $st['pending'], $st['failed'], $qtotal)
  Write-Host ("  Git             : {0}  branch {1}  remote {2}" -f $gitSha, $gitBranch, $remoteSha)
  Write-Host ("  Dev KB          : {0} ({1}/{2} checks)" -f $(if ($dev['ok'] -eq 'YES') { 'PROTECTED / RUNNING' } else { 'CHECK FAILED' }), $dev['passed'], $dev['total'])
  Write-Host ("  Log / checkpoint: {0}" -f (Join-Path $Evidence 'supervisor.stdout.log'))
  Write-Host ("                     {0}" -f $Journal)
  Write-Host ''
}

if ($Stop) {
  $proc = Get-SupervisorProcess
  if ($proc) {
    Write-Host ("  Stopping supervisor (PID {0}). The development knowledge base is NOT touched." -f $proc.Id)
    Stop-Process -Id $proc.Id -Force
  } else { Write-Host '  Supervisor is not running.' }
  Show-Status
  exit 0
}

if ($Status) { Show-Status; exit 0 }

# ---- preflight -------------------------------------------------------
$acc = Get-Fields @'
const fs=require('fs');
const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
console.log('verdict='+j.verdict);
console.log('sim='+((j.simulated||[]).filter(x=>x.ok).length)+'/'+((j.simulated||[]).length));
console.log('real='+((j.real||[]).filter(x=>x.ok).length)+'/'+((j.real||[]).length));
'@ @($Acceptance)
if (-not $acc['verdict']) { Write-Host '  No fault-injection acceptance report. Run: node tools/overnight-acceptance.cjs'; exit 2 }
if ($acc['verdict'] -ne 'READY') { Write-Host ("  Fault-injection acceptance is {0}, refusing to start." -f $acc['verdict']); exit 2 }
Write-Host ("  Fault-injection acceptance: READY (simulated {0}, real {1})" -f $acc['sim'], $acc['real'])

$selfOut = & node $SelfCheck self-check 2>$null
$selfStatus = 'FAIL'
foreach ($l in @($selfOut)) { if ($null -ne $l -and ([string]$l).Contains('"status": "PASS"')) { $selfStatus = 'PASS' } }
if ($selfStatus -ne 'PASS') { Write-Host '  Control package self-check failed, refusing to start.'; exit 2 }
Write-Host '  Control package self-check: PASS'

$dev = Get-DevKbFields
if ($dev['ok'] -ne 'YES') { Write-Host '  Development knowledge base health check failed, refusing to start.'; exit 2 }
Write-Host '  Development knowledge base health: OK'

$existing = Get-SupervisorProcess
if ($existing) { Write-Host ("  Supervisor already running (PID {0})." -f $existing.Id); Show-Status; exit 0 }

# ---- queue -----------------------------------------------------------
if ($RebuildQueue -or -not (Test-Path (Join-Path $StateDir 'queue.json'))) {
  & node $Supervisor build-queue $Config | Out-Null
  Write-Host '  Task queue rebuilt from the T07B ledger.'
}

New-Item -ItemType Directory -Force -Path $Evidence | Out-Null
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

# ---- start the independent supervisor -------------------------------
$env:QA_OVERNIGHT_STATE_DIR = $StateDir
$env:QA_OVERNIGHT_EVIDENCE_DIR = $Evidence
$outLog = Join-Path $Evidence 'supervisor.stdout.log'
$errLog = Join-Path $Evidence 'supervisor.stderr.log'
$batFile = Join-Path $StateDir 'run-supervisor.cmd'
# 用 .cmd 启动：完全脱离父 PowerShell 的管道句柄（否则父命令等不到管道 EOF），
# stdin 接 NUL，stdout/stderr 接文件，node 进程不继承任何父句柄。
$batBody = '@echo off
"{0}" "{1}" run "{2}" 1>"{3}" 2>"{4}" <NUL
' -f (Get-Command node).Source, $Supervisor, $Config, $outLog, $errLog
Set-Content -Path $batFile -Value $batBody -Encoding ASCII
Remove-Item -Path $PidFile -ErrorAction SilentlyContinue
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $batFile -WorkingDirectory $QaRoot -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 10
$supPid = '-'
if (Test-Path $PidFile) { $supPid = (Get-Content $PidFile -Raw).Trim() }
Write-Host ('  Supervisor started (node PID {0}).' -f $supPid)
Show-Status
