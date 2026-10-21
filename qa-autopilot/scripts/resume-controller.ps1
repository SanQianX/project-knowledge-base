param([Parameter(Mandatory=$true)][string]$NodeExe,[Parameter(Mandatory=$true)][string]$QaRoot)
$ErrorActionPreference = 'Stop'
$Config = Join-Path $QaRoot 'config\local.json'
if (!(Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw 'Node executable not found.' }
if (!(Test-Path -LiteralPath $Config -PathType Leaf)) { throw 'Local config missing.' }
# Run under the reviewed controller account. Never fetch keys from worker files.
& $NodeExe (Join-Path $QaRoot 'scripts\qa.cjs') recover-state --config $Config
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $NodeExe (Join-Path $QaRoot 'tools\supervisor.cjs') $Config
exit $LASTEXITCODE
