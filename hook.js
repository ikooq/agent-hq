// Agent HQ v2 status hook. Appends one JSON line per Claude Code hook event to
// ~/.agent-hq/events-YYYY-MM.jsonl (monthly rotation). On SessionStart it also
// checks 127.0.0.1:7777 (150 ms budget) and starts the server detached if
// nothing answers. No network beyond localhost, no model calls, never blocks:
// every error is swallowed and the script always exits 0 within ~1.5 s.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const HQ = path.join(os.homedir(), '.agent-hq');
const PORT = +process.env.AGENT_HQ_PORT || 7777;

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

let buf = '', started = false;
function done() {
  if (started) return; started = true;
  let event = '';
  try {
    const i = JSON.parse(buf || '{}');
    event = i.hook_event_name || process.argv[2] || 'unknown';
    const d = new Date();
    const line = {
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
    fs.mkdirSync(HQ, { recursive: true });
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    fs.appendFileSync(path.join(HQ, `events-${month}.jsonl`), JSON.stringify(line) + '\n');
  } catch (e) { /* fail silently */ }
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
setTimeout(exit, 1500);
