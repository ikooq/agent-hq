<#
  Agent HQ uninstaller for Windows.
    powershell -ExecutionPolicy Bypass -File $HOME\.agent-hq\uninstall.ps1
  Stops the server, backs up ~/.claude/settings.json and removes only the Agent HQ hook entries (your other hooks
  stay), removes the Startup shortcut and the agent-hq command. Asks before removing the subagents it installed
  and before deleting ~/.agent-hq (your event log, stats and reports live there).
#>
[CmdletBinding()]
param(
  [switch]$Yes,          # answer yes to every question (removes agents and data)
  [switch]$KeepAgents,   # never remove ~/.claude/agents files
  [switch]$KeepData,     # never delete ~/.agent-hq
  [switch]$NoShim
)
$ErrorActionPreference = 'Stop'
function Say($m) { Write-Host $m }
function CanAsk { [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not ([Environment]::GetCommandLineArgs() -match '^-NonI') }
function Ask($q) {
  if ($Yes) { return $true }
  if (-not (CanAsk)) { return $false }
  return (Read-Host "$q [y/N]") -match '^(y|yes)$'
}
$UserHome = $env:USERPROFILE
$HQ = Join-Path $UserHome '.agent-hq'
$Claude = Join-Path $UserHome '.claude'
$cli = Join-Path $HQ 'cli.js'

$settings = Join-Path $Claude 'settings.json'
if (Test-Path $settings) { $bak = "$settings.bak-agent-hq-$(Get-Date -Format 'yyyyMMdd-HHmmss')"; Copy-Item $settings $bak; Say "Backup: $bak" }
if (Test-Path $cli) {
  $a = @('uninstall'); if ($NoShim) { $a += '--no-shim' }
  & node $cli @a
} else { Say "No $cli found: nothing to unhook." }

if (-not $KeepAgents) {
  $src = Join-Path $HQ 'claude\agents'
  if (Test-Path $src) {
    foreach ($f in Get-ChildItem $src -Filter *.md) {
      $to = Join-Path (Join-Path $Claude 'agents') $f.Name
      if ((Test-Path $to) -and ((Get-FileHash $to).Hash -eq (Get-FileHash $f.FullName).Hash) -and (Ask "Remove ~/.claude/agents/$($f.Name) (installed by Agent HQ, unchanged)?")) { Remove-Item $to; Say "removed $($f.Name)" }
    }
  }
}
if (-not $KeepData -and (Test-Path $HQ) -and (Ask "Delete $HQ (code, event log, stats, reports)?")) {
  Set-Location $UserHome; Remove-Item -Recurse -Force $HQ; Say "Deleted $HQ"
} else { Say "Kept $HQ" }
Say 'Agent HQ is uninstalled.'
