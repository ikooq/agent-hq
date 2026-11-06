<#
  Agent HQ installer for Windows.
    powershell -ExecutionPolicy Bypass -File install.ps1            (from a clone or a downloaded copy)
  What it does, in order:
    1. puts the code in ~/.agent-hq (copies this folder there, or clones the repo when run on its own)
    2. backs up ~/.claude/settings.json, then adds the Agent HQ hooks next to your existing hooks (nothing is removed)
    3. copies claude/agents/*.md to ~/.claude/agents, asking before it overwrites a file that differs
    4. creates ~/.agent-hq/roster.json from roster.example.json (an existing roster.json is kept)
    5. adds the hidden Startup shortcut and the agent-hq command, then starts the server on http://127.0.0.1:7777/
  Everything stays on this computer. Re-running it is safe.
#>
[CmdletBinding()]
param(
  [string]$Repo = 'https://github.com/ikooq/agent-hq.git',
  [switch]$Yes,            # overwrite changed agent files without asking
  [switch]$NoAgents,       # do not touch ~/.claude/agents
  [switch]$NoAutostart,    # no Startup shortcut
  [switch]$NoShim,         # no agent-hq command in the npm global bin folder
  [switch]$NoStart         # do not start the server at the end
)
$ErrorActionPreference = 'Stop'
function Say($m) { Write-Host $m }
function CanAsk { [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not ([Environment]::GetCommandLineArgs() -match '^-NonI') }
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

$UserHome = $env:USERPROFILE
$HQ = Join-Path $UserHome '.agent-hq'
$Claude = Join-Path $UserHome '.claude'

# ---------- 0. Node.js ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js is not installed. Install Node 22 LTS from https://nodejs.org and run this again.' }
$major = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($major -lt 20) { throw "Node $major found; Agent HQ needs Node 20 or newer (22 recommended)." }
Say "Node $(& node -v) at $($node.Source)"

# ---------- 1. code in ~/.agent-hq ----------
Step "1/5 Code in $HQ"
$src = $PSScriptRoot
$here = $src -and (Test-Path (Join-Path $src 'server.js'))
if ($here -and ((Resolve-Path $src).Path.TrimEnd('\') -ieq $HQ.TrimEnd('\'))) {
  Say 'Already running from ~/.agent-hq.'
} elseif ($here) {
  New-Item -ItemType Directory -Force $HQ | Out-Null
  $files = $null
  if ((Get-Command git -ErrorAction SilentlyContinue) -and (Test-Path (Join-Path $src '.git'))) { $files = & git -C $src ls-files }
  if (-not $files) {   # not a git checkout: every file except personal data
    $files = Get-ChildItem -Path $src -Recurse -File | Where-Object { $_.FullName -notmatch '\\\.git\\' } |
      ForEach-Object { $_.FullName.Substring($src.Length + 1) } |
      Where-Object { $_ -notmatch '^(events[-.]|stats\\|reports\\|screenshots\\|screenshot-|soak-|server(-\d+)?\.(log|pid)$|settings\.json$|secret$|roster\.json$|start-hidden\.vbs$|.*\.bak-)' }
  }
  foreach ($f in $files) {
    $to = Join-Path $HQ $f; New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
    Copy-Item -Force (Join-Path $src $f) $to
  }
  Say "Copied $(@($files).Count) files from $src."
} else {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is needed to download Agent HQ (or run install.ps1 from a downloaded copy).' }
  if (Test-Path (Join-Path $HQ '.git')) { & git -C $HQ pull --ff-only; Say 'Updated the existing clone.' }
  else { & git clone $Repo $HQ; if ($LASTEXITCODE) { throw "git clone $Repo failed" } }
}
$cli = Join-Path $HQ 'cli.js'

# ---------- 2. hooks (backup first, merge, keep existing) ----------
Step '2/5 Claude Code hooks'
New-Item -ItemType Directory -Force $Claude | Out-Null
$settings = Join-Path $Claude 'settings.json'
if (Test-Path $settings) {
  $bak = "$settings.bak-agent-hq-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $settings $bak; Say "Backup: $bak"
}
$args2 = @('install')
if ($NoAutostart) { $args2 += '--no-autostart' }
if ($NoShim) { $args2 += '--no-shim' }
& node $cli @args2
if ($LASTEXITCODE) { throw 'agent-hq install failed (your settings.json backup is next to it)' }

# ---------- 3. subagents ----------
Step '3/5 Subagents in ~/.claude/agents'
if ($NoAgents) { Say 'Skipped (-NoAgents).' } else {
  $agents = Join-Path $Claude 'agents'; New-Item -ItemType Directory -Force $agents | Out-Null
  foreach ($a in Get-ChildItem (Join-Path $HQ 'claude\agents') -Filter *.md) {
    $to = Join-Path $agents $a.Name
    if (-not (Test-Path $to)) { Copy-Item $a.FullName $to; Say "added   $($a.Name)"; continue }
    if ((Get-FileHash $to).Hash -eq (Get-FileHash $a.FullName).Hash) { Say "same    $($a.Name)"; continue }
    $ok = $Yes
    if (-not $Yes) {
      if (CanAsk) { $ok = (Read-Host "~/.claude/agents/$($a.Name) differs from Agent HQ's copy. Overwrite? [y/N]") -match '^(y|yes)$' }
      else { $ok = $false }
    }
    if ($ok) { Copy-Item $to "$to.bak-agent-hq"; Copy-Item -Force $a.FullName $to; Say "updated $($a.Name) (old copy: $($a.Name).bak-agent-hq)" }
    else { Say "kept    $($a.Name) (yours)" }
  }
}

# ---------- 4. roster ----------
Step '4/5 Roster'
$roster = Join-Path $HQ 'roster.json'
if (Test-Path $roster) { Say "Kept your $roster." }
else { Copy-Item (Join-Path $HQ 'roster.example.json') $roster; Say "Created $roster from roster.example.json. Edit the folders so each bot matches a project." }

# ---------- 5. start ----------
Step '5/5 Start'
if ($NoStart) { Say 'Skipped (-NoStart). Start later with: agent-hq start' }
else {
  # Start-Process, not `& node`: a server started directly inherits this script's stdout, so anything capturing
  # the installer's output (a pipe, a log wrapper, CI) would wait for as long as the server runs.
  $p = Start-Process -FilePath $node.Source -ArgumentList @("`"$cli`"", 'start', '--quiet') -WindowStyle Hidden -PassThru
  $null = $p.Handle; $p.WaitForExit()
  if ($p.ExitCode) { throw "The server did not start. See $(Join-Path $HQ 'server.log')" }
  Say "`nOpen http://127.0.0.1:7777/  (or http://127.0.0.1:7777/?demo=1 for the demo)"
}
Say "`nDone. Useful next steps:`n  agent-hq status      live counts`n  agent-hq report      today's report`n  agent-hq approvals on   Allow once / Deny from the office (off by default)`n  agent-hq lan on      the office on your phone (opt-in)"
