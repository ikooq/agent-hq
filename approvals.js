// Agent HQ approvals: Allow once / Deny from the office for Claude Code permission prompts.
// Off by default (`agent-hq approvals on`). The PermissionRequest hook long-polls POST /api/approvals/request
// with the per-install secret; the office decides with POST /api/approvals/decide (same origin + secret).
// A decision applies to that one request id only, and every decision is logged to the event file.
// Codex is never asked: its logs are read-only and nothing is written back to ~/.codex.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

function ensureSecret(hq) {
  const f = path.join(hq, 'secret');
  try { const s = fs.readFileSync(f, 'utf8').trim(); if (/^[0-9a-f]{64}$/.test(s)) return s; } catch (e) {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(hq, { recursive: true });
  fs.writeFileSync(f, s + '\n', { mode: 0o600 });
  return s;
}
const sameSecret = (a, b) => { a = Buffer.from(String(a || '')); b = Buffer.from(String(b || '')); return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b); };

function createApprovals({ hq, waitMs = 60000, onChange = () => {}, log = () => {} }) {
  const pending = new Map();   // id -> { id, session_id, cwd, tool, detail, since, res, timer }
  function appendEvent(e) {
    try {
      const d = new Date(), month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      fs.appendFileSync(path.join(hq, `events-${month}.jsonl`), JSON.stringify({ time: d.toISOString(), ...e }) + '\n');
    } catch (x) { log('could not log approval', x.message); }
  }
  function finish(p, decision, by) {
    if (!pending.has(p.id)) return false;
    pending.delete(p.id); clearTimeout(p.timer);
    appendEvent({ event: 'ApprovalDecision', session_id: p.session_id, cwd: p.cwd, request_id: p.id, tool_name: p.tool, detail: p.detail.slice(0, 300), decision, by });
    if (p.res && !p.res.writableEnded) { try { p.res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); p.res.end(JSON.stringify({ decision: decision === 'allow' || decision === 'deny' ? decision : null })); } catch (e) {} }
    onChange();
    return true;
  }
  // the hook's long poll; res stays open until a decision, 60 s, or the hook goes away (answered in the terminal)
  function request(body, req, res) {
    const id = String(body.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id) || pending.has(id)) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":"bad id"}'); }
    const p = { id, session_id: String(body.session_id || '') || null, cwd: String(body.cwd || ''), tool: String(body.tool || 'tool').slice(0, 120), detail: String(body.detail || '').slice(0, 4000), since: Date.now(), res };
    p.timer = setTimeout(() => finish(p, 'none', 'timeout'), waitMs);
    res.on('close', () => { if (pending.has(id)) finish(p, 'none', 'gone'); });   // hook ended: prompt answered in the terminal, or Claude moved on
    pending.set(id, p);
    onChange();
  }
  function decide(id, decision, by) {
    const p = pending.get(String(id || ''));
    if (!p) return { code: 404, body: { error: 'no such pending request (already decided or expired)' } };
    if (decision !== 'allow' && decision !== 'deny') return { code: 400, body: { error: 'decision must be allow or deny' } };
    finish(p, decision, by);
    return { code: 200, body: { ok: true, id: p.id, decision } };
  }
  const list = () => [...pending.values()].sort((a, b) => a.since - b.since)
    .map(p => ({ id: p.id, session_id: p.session_id, robot: p.session_id ? 'session:' + p.session_id : null, tool: p.tool, detail: p.detail, cwd: p.cwd, since: p.since, until: p.since + waitMs }));
  const cancelAll = by => { for (const p of [...pending.values()]) finish(p, 'none', by || 'off'); };
  // answered in the terminal (or the turn moved on): the session wrote a newer transcript line -> withdraw it from the office
  const withdrawAnswered = lastLineOf => { for (const p of [...pending.values()]) { const l = p.session_id ? lastLineOf(p.session_id) : 0; if (l && l > p.since) finish(p, 'none', 'answered-elsewhere'); } };
  return { request, decide, list, cancelAll, withdrawAnswered, size: () => pending.size };
}

module.exports = { ensureSecret, sameSecret, createApprovals };
