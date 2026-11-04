#!/usr/bin/env node
// agent-hq start | stop | restart | status | test | bench | soak | report | open | install
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');

const HQ = path.join(os.homedir(), '.agent-hq');
const PORT = +process.env.AGENT_HQ_PORT || 7777;
const URL_ = `http://127.0.0.1:${PORT}/`;
const PID_FILE = path.join(HQ, process.env.AGENT_HQ_PORT ? `server-${PORT}.pid` : 'server.pid');
const quiet = process.argv.includes('--quiet');
const say = (...a) => { if (!quiet) console.log(...a); };
const sleep = n => new Promise(r => setTimeout(r, n));

function get(p, timeout = 800) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout, headers: { Host: `127.0.0.1:${PORT}` } }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}
const health = () => get('/api/health');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readPid = () => { try { return +fs.readFileSync(PID_FILE, 'utf8').trim() || null; } catch (e) { return null; } };

async function start() {
  const h = await health();
  if (h && h.ok) { say(`Agent HQ is already running (pid ${h.pid}): ${URL_}`); return true; }
  const out = fs.openSync(path.join(HQ, 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(HQ, 'server.js')], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const h2 = await health();
    if (h2 && h2.ok) { say(`Agent HQ started (pid ${h2.pid}): ${URL_}`); return true; }
  }
  console.error(`Agent HQ did not come up. See ${path.join(HQ, 'server.log')}`);
  process.exitCode = 1; return false;
}

async function stop() {
  const h = await health();
  const pids = new Set([readPid(), h && h.pid].filter(Boolean));
  if (!pids.size) { say('Agent HQ is not running.'); return true; }
  for (const pid of pids) {
    if (!alive(pid)) continue;
    try { process.kill(pid); } catch (e) {
      if (process.platform === 'win32') try { execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' }); } catch (x) {}
    }
  }
  for (let i = 0; i < 30; i++) {
    if (![...pids].some(alive) && !(await health())) break;
    await sleep(100);
  }
  try { fs.unlinkSync(PID_FILE); } catch (e) {}
  const still = await health();
  if (still) { console.error(`Could not stop pid ${still.pid}`); process.exitCode = 1; return false; }
  say(`Agent HQ stopped (pid ${[...pids].join(', ')}).`);
  return true;
}

async function status() {
  const h = await health();
  if (!h) { say(`Agent HQ: stopped${readPid() ? ' (stale pid file)' : ''}`); process.exitCode = 3; return; }
  const s = await get('/state', 3000);
  say(`Agent HQ: running, pid ${h.pid}, ${URL_}`);
  if (!s) return;
  const c = s.counts;
  say(`  working ${c.working} · waiting ${c.waiting} · stuck ${c.stuck} · resting ${c.resting} · off ${c.off}`);
  say(`  today: ${s.totals.total.toLocaleString('en-US')} tokens (in+out), ~$${s.totals.cost.toFixed(2)} estimated`);
  for (const b of s.bots) {
    const rs = b.robots.map(r => `${r.label}=${r.status}`).join(', ') || 'off';
    say(`  ${b.name.padEnd(20)} ${b.team.padEnd(9)} ${b.modelLabel.padEnd(11)} ${String(b.tokens.total).padStart(9)} tok  ${rs}`);
  }
}

function openBrowser() {
  if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', URL_], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [URL_], { detached: true, stdio: 'ignore' }).unref();
}

function install() {
  // 1) hooks in ~/.claude/settings.json (keeps existing hooks)
  const sf = path.join(os.homedir(), '.claude', 'settings.json');
  const s = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : {};
  const cmd = `node "${path.join(HQ, 'hook.js').replace(/\\/g, '/')}"`;
  s.hooks = s.hooks || {};
  const events = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PermissionRequest'];
  for (const ev of events) {
    const list = s.hooks[ev] = s.hooks[ev] || [];
    const timeout = ev === 'PermissionRequest' ? 75 : 5;   // PermissionRequest waits up to 60 s for a decision from the office
    if (!list.some(g => (g.hooks || []).some(h => String(h.command || '').includes('.agent-hq/hook.js'))))
      list.push({ hooks: [{ type: 'command', command: cmd, timeout }] });
  }
  try { require('./approvals').ensureSecret(HQ); } catch (e) {}
  fs.writeFileSync(sf, JSON.stringify(s, null, 2) + '\n');
  say(`hooks: ${events.join(', ')} -> ${sf}`);
  if (process.platform !== 'win32') return;
  // 2) hidden autostart at login: Startup shortcut -> wscript -> start-hidden.vbs
  const vbs = path.join(HQ, 'start-hidden.vbs');
  fs.writeFileSync(vbs, [
    "' Agent HQ: start the server at login with no console window.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${process.execPath}"" ""${path.join(HQ, 'cli.js')}"" start --quiet", 0, False`, ''].join('\r\n'));
  const startup = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Agent HQ.lnk');
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:HQ_LNK);$s.TargetPath="$env:WINDIR\\System32\\wscript.exe";$s.Arguments='"'+$env:HQ_VBS+'"';$s.WorkingDirectory=$env:HQ_DIR;$s.WindowStyle=7;$s.Description='Agent HQ server (hidden)';$s.Save()`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, HQ_LNK: startup, HQ_VBS: vbs, HQ_DIR: HQ }, stdio: 'inherit' });
  say(`autostart: ${startup}`);
  // 3) `agent-hq` on PATH via the npm global bin folder (already on PATH for npm users)
  try {
    const bin = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['prefix', '-g'], { encoding: 'utf8', shell: true }).trim();
    fs.writeFileSync(path.join(bin, 'agent-hq.cmd'), `@echo off\r\nnode "%USERPROFILE%\\.agent-hq\\cli.js" %*\r\n`);
    fs.writeFileSync(path.join(bin, 'agent-hq'), `#!/bin/sh\nexec node "$HOME/.agent-hq/cli.js" "$@"\n`);
    say(`command: ${path.join(bin, 'agent-hq.cmd')} (+ sh shim)`);
  } catch (e) { say('could not install the PATH shim:', e.message); }
}

// approvals from the office: off by default. `approvals on --lan` also allows deciding from the phone (Phase 5 LAN mode).
function setSettings(fn) {
  const f = path.join(HQ, 'settings.json');
  let s = {}; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
  fn(s); fs.writeFileSync(f, JSON.stringify(s, null, 2));
  return s;
}
function approvalsCmd(arg) {
  const sf = path.join(os.homedir(), '.claude', 'settings.json');
  let hooked = false; try { hooked = JSON.stringify(JSON.parse(fs.readFileSync(sf, 'utf8')).hooks.PermissionRequest || []).includes('.agent-hq/hook.js'); } catch (e) {}
  if (arg === 'on') {
    require('./approvals').ensureSecret(HQ);
    const lan = process.argv.includes('--lan');
    setSettings(s => { s.approvals = { enabled: true, lan }; });
    say(`Approvals from the office: ON${lan ? ' (also from the phone over LAN)' : ' (this computer only; add --lan to allow the phone)'}`);
    say('  Allow once / Deny apply to that single request only. The terminal prompt still works: whichever answer comes first wins;');
    say('  the office stops offering a request after 60 s or as soon as it was answered in the terminal.');
    if (!hooked) say('  Note: the PermissionRequest hook is not installed yet. Run: agent-hq install');
  } else if (arg === 'off') {
    setSettings(s => { s.approvals = { enabled: false, lan: false }; });
    say('Approvals from the office: OFF (Claude Code asks in the terminal as usual).');
  } else {
    let s = {}; try { s = JSON.parse(fs.readFileSync(path.join(HQ, 'settings.json'), 'utf8')); } catch (e) {}
    const a = s.approvals || {};
    say(`Approvals from the office: ${a.enabled ? 'ON' + (a.lan ? ' (+ phone over LAN)' : '') : 'OFF'}${hooked ? '' : ' · PermissionRequest hook not installed (agent-hq install)'}`);
    say('usage: agent-hq approvals on [--lan] | off');
  }
}

async function bench() {
  const secs = +(process.argv.find(a => /^--seconds=/.test(a)) || '--seconds=60').split('=')[1];
  if (!(await start())) return;
  const { launch, openPage, sleep } = require('./cdp');
  const W = 1920, H = 1080;
  say(`Benchmark: 15 fake agents for ${secs} s at ${W}x${H} (headless Chrome)…`);
  const b = await launch({ width: W, height: H });
  try {
    const p = await openPage(b, 'about:blank');
    await p.send('Page.enable');
    await p.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await p.send('Page.navigate', { url: `${URL_}?bench=1&seconds=${secs}${process.argv.includes('--paced') ? '&paced=1' : ''}` });
    let r = null;
    for (let i = 0; i < secs + 40 && !r; i++) { await sleep(1000); try { r = await p.evaluate('window.__bench && window.__bench.done ? window.__bench : null'); } catch (e) {} }
    if (!r) { console.error('Benchmark did not finish (page error?)'); process.exitCode = 1; return; }
    const soft = /swiftshader|llvmpipe|software|basic render/i.test(r.gpu || '');
    const f = x => x ? `${x.fps} fps · avg ${x.avgMs} ms · p95 ${x.p95Ms} ms (${x.frames} frames)` : 'n/a';
    say(`GPU:            ${r.gpu}${soft ? '   <-- software rendering: numbers are NOT real' : ''}`);
    say(`viewport:       ${r.viewport} · pixel ratio ${r.pixelRatio} · quality ${r.quality}`);
    say(`start (5-15 s): ${f(r.start)}`);
    say(`end (last 10s): ${f(r.end)}`);
    say(`whole run:      ${f(r.all)}`);
    say(`draw calls:     ${r.maxDrawCalls} max · triangles ${r.maxTriangles.toLocaleString('en-US')} · textures ${r.textures} · geometries ${r.geometries}`);
    say(`JS heap:        ${r.heapStart} MB at start -> ${r.heapEnd} MB at end`);
    say(`frame work:     avg ${r.workAvgMs} ms · p95 ${r.workP95Ms} ms of CPU+GPU-submit time per frame (headroom vs 16.7 ms)${r.paced ? ' · paced 60 Hz' : ' · uncapped (headless has no vsync)'}`);
    say(`data refresh:   avg ${r.avgPatchMs} ms · max ${r.maxPatchMs} ms per state update`);
    say(`refresh tasks:  ${r.longTasksDuringRefresh} long tasks (>50 ms) overlapping a data refresh`);
    say(`long tasks:     ${r.longTasks} over 50 ms after warm-up (max ${r.maxLongTaskMs} ms; GL driver waits when rendering uncapped) · warm-up (first 5 s: shader linking, first uploads): ${r.warmupLongTasks} (max ${r.warmupMaxMs} ms)`);
    const ok = r.all && r.all.fps >= 58 && r.all.p95Ms < 20 && r.maxDrawCalls < 150 && r.longTasksDuringRefresh === 0;
    say(`budget (60 fps, p95 < 20 ms, < 150 draws, no long task during data refresh): ${ok ? 'PASS' : 'FAIL'}`);
    if (soft) say(`Headless Chrome is not using your GPU. Open ${URL_}?bench=1 in your normal Chrome and read the result box on the page.`);
    process.exitCode = ok ? 0 : 1;
    p.close();
  } finally { b.close(); }
}

const usage = `Agent HQ v3
usage: agent-hq <command>
  start     start the server in the background (no-op if running)
  stop      stop the server (PID in ~/.agent-hq/server.pid)
  restart   stop + start
  status    is it running? live counts per bot
  open      start if needed, then open ${URL_}
  test      run the self-test against a temp home (synthetic data)
  bench     60 s browser benchmark with 15 fake agents (fps, p95, draw calls, heap)
  report    daily report from local logs: ~/.agent-hq/reports/YYYY-MM-DD.html (--date=YYYY-MM-DD, default today)
  soak      long run through a real server on a temp home (--minutes=60): leaks + slowdown, CSV in ~/.agent-hq
  approvals on [--lan] | off   Allow once / Deny for Claude Code permission prompts from the office (off by default)
  install   (re)install hooks, hidden autostart and the agent-hq command`;

(async () => {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'start': await start(); break;
    case 'stop': await stop(); break;
    case 'restart': await stop(); await start(); break;
    case 'status': await status(); break;
    case 'open': if (await start()) openBrowser(); break;
    case 'test': {
      const r = require('child_process').spawnSync(process.execPath, [path.join(HQ, 'test.js'), ...process.argv.slice(3)], { stdio: 'inherit' });
      process.exitCode = r.status; break;
    }
    case 'install': install(); break;
    case 'bench': await bench(); break;
    case 'soak': await require('./soak').main(); break;
    case 'report': require('./report').main(process.argv.slice(3)); break;
    case 'approvals': approvalsCmd(process.argv[3]); break;
    default: console.log(usage); if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 2;
  }
})();
