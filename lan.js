// Agent HQ LAN mode helpers: pick the home-network IPv4 address, random token, read-only firewall check.
// LAN mode is opt-in (`agent-hq lan on`). Agent HQ never changes Windows Firewall; it only reads the rules.
'use strict';
const os = require('os'), crypto = require('crypto');
const { execFileSync } = require('child_process');

const PRIVATE = ip => /^192\.168\./.test(ip) ? 3 : /^10\./.test(ip) ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 1 : 0;
const VIRTUAL = /vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|radmin|hamachi|zerotier|tailscale|vpn|tap|tun/i;

// Best guess for "this PC on my home Wi-Fi": a private IPv4 on a physical-looking adapter (192.168 > 10 > 172.16-31).
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) for (const a of addrs || []) {
    if (a.family !== 'IPv4' && a.family !== 4) continue;
    if (a.internal) continue;
    const rank = PRIVATE(a.address); if (!rank) continue;
    out.push({ name, ip: a.address, rank: rank + (VIRTUAL.test(name) ? -10 : 0) });
  }
  return out.sort((a, b) => b.rank - a.rank);
}
function pickLanIp(preferred) {
  const all = lanAddresses();
  if (preferred && all.some(a => a.ip === preferred)) return preferred;
  return all.length && all[0].rank > 0 ? all[0].ip : null;
}
const newToken = () => crypto.randomBytes(16).toString('hex');

// Read-only: is there an enabled inbound allow rule for the port, and is the network Private? (Windows only)
function firewallInfo(port, ip) {
  if (process.platform !== 'win32') return null;
  const ps = `$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$r = Get-NetFirewallPortFilter -Protocol TCP | Where-Object { $_.LocalPort -eq '${+port}' } | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }
$a = (Get-NetIPAddress -IPAddress '${String(ip || '').replace(/[^0-9.]/g, '')}' | Select-Object -First 1).InterfaceAlias
$p = if ($a) { (Get-NetConnectionProfile -InterfaceAlias $a | Select-Object -First 1).NetworkCategory } else { (Get-NetConnectionProfile | Select-Object -First 1).NetworkCategory }
"$([bool]$r)|$p|$a"`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim().split('|');
    return { rule: out[0] === 'True', profile: out[1] || 'unknown', alias: out[2] || null };
  } catch (e) { return null; }
}
const firewallCommand = port => `New-NetFirewallRule -DisplayName "Agent HQ (LAN)" -Direction Inbound -Protocol TCP -LocalPort ${+port} -Action Allow -Profile Private`;

const privateCommand = alias => `Set-NetConnectionProfile -InterfaceAlias "${String(alias).replace(/"/g, '')}" -NetworkCategory Private`;
module.exports = { privateCommand, lanAddresses, pickLanIp, newToken, firewallInfo, firewallCommand };
