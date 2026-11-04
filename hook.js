// Agent HQ status hook. Appends one JSON line per Claude Code hook event to
// ~/.agent-hq/events-YYYY-MM.jsonl (monthly rotation). On SessionStart it also
// checks 127.0.0.1:7777 (150 ms budget) and starts the server detached if
// nothing answers. No network beyond localhost, no model calls, never blocks:
// every error is swallowed and the script always exits 0.
//
// PermissionRequest (approvals from the office, off by default, `agent-hq approvals on`):
// asks the local server whether you decided in the office. The request carries the per-install
// secret (~/.agent-hq/secret) and a random id; the server answers once you click Allow once / Deny,
// or with no decision after 60 s (or when the prompt was answered in the terminal). With no decision
// this hook prints nothing and Claude Code's own prompt decides (in Claude Code 2.1 the terminal prompt
// is on screen while this hook waits; the first answer wins). Never "always allow" (no updatedPermissions).
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const HQ = path.join(os.homedir(), '.agent-hq');
const PORT = +process.env.AGENT_HQ_PORT || 7777;
const WAIT_MS = +process.env.AGENT_HQ_APPROVAL_WAIT_MS || 60000;

function norm(p) {
  let s = String(p || '').trim();
  if (s.startsWith('~')) s = os.homedir() + s.slice(1);
  s = s.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  return s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}
function botFor(cwd) {
  const roster = JSON.parse(fs.readFileSync(path.join(HQ, 'roster.json'), 'utf8'));
  const c = norm(cwd); let best = null, len = -1;
  for (const b of roster.bots || []) for (const f of b.folders || []) {
    const n = norm(f);
    const hit = b.match === 'exact' ? c === n : (c === n || c.startsWith(n + '\\'));
    if (hit && n.length > len) { best = b; len = n.length; }
  }
  return best ? best.name : 'Drop-in: ' + (path.basename(String(cwd || '')) || '?');
}
const exit = () => process.exit(0);
let hardStop = setTimeout(exit, 1500);

function ensureServer(cb) {
  let settled = false;
  const finish = up => {
    if (settled) return; settled = true;
    try { sock.destroy(); } catch (e) {}
    if (!up) {
      try {
        const { spawn } = require('child_process');
        const log = fs.openSync(path.join(HQ, 'server.log'), 'a');
        const child = spawn(process.execPath, [path.join(__dirname, 'server.js')],
          { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: process.env });
        child.unref();
      } catch (e) {}
    }
    cb();
  };
  const sock = require('net').connect({ host: '127.0.0.1', port: PORT });
  sock.once('connect', () => finish(true));
  sock.once('error', () => finish(false));
  setTimeout(() => finish(false), 150);
}

// The full command / file path / URL the tool wants, for the kiosk and the Waiting list.
function detailOf(tool, inp) {
  inp = inp || {};
  const v = inp.command ?? inp.file_path ?? inp.notebook_path ?? inp.url ?? inp.pattern ?? inp.query ?? null;
  return String(v != null ? v : JSON.stringify(inp)).slice(0, 4000);
}

function askOffice(i, line) {
  let settings = {}, secret = '';
  try { settings = JSON.parse(fs.readFileSync(path.join(HQ, 'settings.json'), 'utf8')); } catch (e) {}
  if (!settings.approvals || !settings.approvals.enabled) return exit();
  try { secret = fs.readFileSync(path.join(HQ, 'secret'), 'utf8').trim(); } catch (e) {}
  if (!secret) return exit();
  clearTimeout(hardStop); hardStop = setTimeout(exit, WAIT_MS + 3000);
  const body = JSON.stringify({ id: require('crypto').randomUUID(), session_id: i.session_id || null, cwd: i.cwd || null, tool: String(i.tool_name || 'tool'),
    detail: line.detail || '', permission_mode: i.permission_mode || null });
  const req = require('http').request({ host: '127.0.0.1', port: PORT, path: '/api/approvals/request', method: 'POST', timeout: WAIT_MS + 2000,
    headers: { Host: `127.0.0.1:${PORT}`, 'Content-Type': 'application/json', 'X-HQ-Secret': secret, 'Content-Length': Buffer.byteLength(body) } }, res => {
    let b = ''; res.setEncoding('utf8'); res.on('data', d => { b += d; }); res.on('end', () => {
      let d = null; try { d = JSON.parse(b).decision; } catch (e) {}
      if (res.statusCode === 200 && (d === 'allow' || d === 'deny')) {
        const decision = d === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from the Agent HQ office.' };
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }), exit);
      } else exit();      // no decision: Claude Code shows its normal prompt
    });
  });
  req.on('timeout', () => { req.destroy(); exit(); });
  req.on('error', exit);
  req.end(body);
}

let buf = '', started = false;
function done() {
  if (started) return; started = true;
  let event = '', i = {}, line = {};
  try {
    i = JSON.parse(buf || '{}');
    event = i.hook_event_name || process.argv[2] || 'unknown';
    const d = new Date();
    line = {
      time: d.toISOString(), event,
      session_id: i.session_id || null, cwd: i.cwd || null, bot: null,
      transcript_path: i.transcript_path || null,
    };
    try { line.bot = botFor(i.cwd); } catch (e) {}
    if (i.message) line.message = String(i.message).slice(0, 500);
    if (i.notification_type) line.notification_type = String(i.notification_type);
    if (i.last_assistant_message) line.summary = String(i.last_assistant_message).slice(0, 300);
    if (i.reason) line.reason = String(i.reason);
    if (i.agent_id) line.agent_id = String(i.agent_id);
    if (i.agent_type) line.agent_type = String(i.agent_type);
    if (i.agent_transcript_path) line.agent_transcript_path = String(i.agent_transcript_path);
    if (event === 'PermissionRequest') { line.tool_name = String(i.tool_name || 'tool'); line.detail = detailOf(i.tool_name, i.tool_input); }
    fs.mkdirSync(HQ, { recursive: true });
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    fs.appendFileSync(path.join(HQ, `events-${month}.jsonl`), JSON.stringify({ ...line, detail: line.detail && line.detail.slice(0, 300) }) + '\n');
  } catch (e) { /* fail silently */ }
  if (event === 'PermissionRequest') { try { return askOffice(i, line); } catch (e) { return exit(); } }
  if (event === 'SessionStart' && !process.env.AGENT_HQ_NO_AUTOSTART) {
    try { ensureServer(exit); return; } catch (e) {}
  }
  exit();
}
try {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { buf += d; });
  process.stdin.on('end', done);
  process.stdin.on('error', done);
} catch (e) { done(); }
setTimeout(done, 1000);
