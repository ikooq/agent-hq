// Agent HQ v3 engine: turns Claude Code hook events + transcripts and Codex rollout logs into office state.
// Pure local file reading (incremental, by byte offset). No network, no model calls, no dependencies.
// Codex: reads ~/.codex/sessions and ~/.codex/archived_sessions only; never writes into ~/.codex.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib');

const MIN = 60000, DAY = 86400000;
const pad = n => String(n).padStart(2, '0');
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthKey = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const ms = v => (v ? (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : (Date.parse(v) || 0)) : 0);
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const RANK = { waiting: 6, stuck: 5, running: 4, working: 3, resting: 2, off: 1 };

function modelLabel(m, source) {
  const x = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(m || '');
  if (x) return x[1][0].toUpperCase() + x[1].slice(1) + ' ' + x[2] + (x[3] ? '.' + x[3] : '');
  if (source === 'codex' || /^(gpt|o\d|codex)/i.test(m || '')) return 'OpenAI · ' + (m || 'codex');
  return m ? clip(m, 18) : '—';
}
function idxLE(a, t) { let lo = 0, hi = a.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
const lastLE = (a, t) => { const i = idxLE(a, t); return i < 0 ? 0 : a[i]; };
function insertSorted(a, v) { if (!a.length || a[a.length - 1] <= v) a.push(v); else { a.push(v); a.sort((x, y) => x - y); } }

// Read only the bytes appended since the last call; tolerate missing/rotated files.
function tail(file, st) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    st.missing = false;
    if (size < st.offset) { st.offset = 0; st.rest = ''; st.reset = true; }
    if (size === st.offset) return [];
    fd = fs.openSync(file, 'r');
    const len = Math.min(size - st.offset, 64 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.offset);
    st.offset += len;
    const lines = (st.rest + buf.toString('utf8')).split('\n');
    st.rest = lines.pop();
    return lines.filter(l => l.trim());
  } catch (e) { st.missing = true; return []; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {} }
}
const readJSON = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } };
function writeJSONAtomic(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, f);
}

// Short human label for a tool call: "Edit server.js", "Bash: npm run build".
function actionLabel(name, inp) {
  inp = inp || {};
  const base = p => path.basename(String(p || '').replace(/\\/g, '/'));
  const host = u => { try { return new URL(u).host; } catch (e) { return clip(u, 40); } };
  name = String(name || 'tool');
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return clip(`${mcp[2]} (${mcp[1].replace(/^plugin_[^_]+_/, '')})`, 70);
  switch (name) {
    case 'Bash': case 'PowerShell': return clip(`${name}: ${inp.command || inp.description || ''}`, 80);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': return `${name} ${clip(base(inp.file_path), 50)}`;
    case 'NotebookEdit': return `Edit ${clip(base(inp.notebook_path), 50)}`;
    case 'Grep': return clip(`Grep "${inp.pattern || ''}"`, 70);
    case 'Glob': return clip(`Glob ${inp.pattern || ''}`, 70);
    case 'WebFetch': return `WebFetch ${host(inp.url)}`;
    case 'WebSearch': return clip(`WebSearch "${inp.query || ''}"`, 70);
    case 'Task': case 'Agent': return clip(`Agent: ${inp.description || ''}${inp.subagent_type ? ' (' + inp.subagent_type + ')' : ''}`, 80);
    case 'TodoWrite': return 'Update plan';
    case 'AskUserQuestion': return 'Ask you a question';
    case 'Skill': return clip(`Skill ${inp.skill || ''}`, 60);
    default: {
      const v = Object.values(inp).find(x => typeof x === 'string');
      return clip(v ? `${name}: ${v}` : name, 70);
    }
  }
}
// Codex tool calls: shell commands arrive as arrays, patches as text.
function codexActionLabel(name, args, ns) {
  let a = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = { input: a }; } }
  a = a || {};
  const cmd = Array.isArray(a.command) ? a.command.filter(x => !/^(bash|sh|powershell(\.exe)?|pwsh|cmd(\.exe)?|-l?c|-Command|\/c)$/i.test(x)).join(' ') : a.command || a.cmd;
  if (cmd) return clip(`Shell: ${cmd}`, 80);
  if (/apply_patch/.test(name) || /\*\*\* (Update|Add) File: /.test(a.input || '')) { const m = /\*\*\* (?:Update|Add) File: (.+)/.exec(a.input || ''); return `Edit ${m ? path.basename(m[1].trim()) : '(patch)'}`; }
  if (name === 'js' || name === 'exec') {
    const code = String(a.code || a.input || '');
    const sh = /exec_command\(\{\s*cmd:\s*(["'`])((?:\\.|(?!\1).)*)\1/.exec(code);
    if (sh) return clip(`Shell: ${sh[2].replace(/\\(["'\\])/g, '$1')}`, 80);
    const tool = /tools\.(?:mcp__[a-z0-9_]+?__)?([a-z0-9_]+)\(/i.exec(code);
    if (tool) return clip(`${a.title ? a.title + ' · ' : ''}${tool[1].replace(/_/g, ' ')}`, 70);
    return clip(`Run: ${a.title || code.split('\n')[0]}`, 70);
  }
  if (name === 'spawn_agent') return clip(`Agent: ${a.task || a.description || a.name || ''}`, 70);
  const v = Object.values(a).find(x => typeof x === 'string');
  return clip(`${ns ? ns.replace(/^mcp__/, '') + ' ' : ''}${name}${v ? ': ' + v : ''}`, 70);
}
function feedPhrase(label) {
  const m = /^(\w+)(?::)? (.*)$/.exec(label || '');
  if (!m) return String(label || '').toLowerCase();
  const [, verb, rest] = m;
  return ({ Edit: `edited ${rest}`, MultiEdit: `edited ${rest}`, Write: `wrote ${rest}`, Read: `read ${rest}`, Bash: `ran ${rest}`, PowerShell: `ran ${rest}`, Shell: `ran ${rest}`,
    Grep: `searched code for ${rest}`, Glob: `listed ${rest}`, WebFetch: `opened ${rest}`, WebSearch: `searched the web for ${rest}`, Agent: `started a helper: ${rest}`,
    Run: `ran ${rest}`, Skill: `used skill ${rest}` })[verb] || (label[0].toLowerCase() + label.slice(1));
}

function createEngine(opts = {}) {
  const home = opts.home || os.homedir();
  const HQ = opts.hqDir || path.join(home, '.agent-hq');
  const CODEX = opts.codexDir || path.join(home, '.codex');
  const now = opts.now || (() => Date.now());
  const STUCK_MS = opts.stuckMs || 10 * MIN;
  const STALE_MS = opts.staleMs || 12 * 60 * MIN;
  const CODEX_REST_OFF_MS = opts.codexRestOffMs || 30 * MIN;   // Codex has no SessionEnd: idle resting threads walk out after 30 min
  const SUB_STALE_MS = 30 * MIN;
  const F = { roster: path.join(HQ, 'roster.json'), prices: path.join(HQ, 'prices.json'), legacy: path.join(HQ, 'events.jsonl'), stats: path.join(HQ, 'stats') };

  const norm = p => {
    let s = String(p || '').trim();
    if (s.startsWith('~')) s = home + s.slice(1);
    s = s.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
    return s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  };
  const expand = p => String(p || '').replace(/^~(?=$|[\\/])/, home).replace(/\//g, path.sep);

  // ---------- config files (hot reload by mtime) ----------
  const cache = {};
  function hot(file, dflt) {
    try {
      const m = fs.statSync(file).mtimeMs;
      if (!cache[file] || cache[file].m !== m) cache[file] = { m, v: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (e) { if (!cache[file]) cache[file] = { m: 0, v: dflt }; }
    return cache[file].v;
  }
  const roster = () => hot(F.roster, { teams: [], bots: [] });
  const prices = () => hot(F.prices, { models: {} });
  const sourceOf = b => (b.source || 'claude');

  function priceFor(model) {
    const p = prices(), models = p.models || {};
    let best = null;
    for (const k of Object.keys(models)) if ((model === k || String(model).startsWith(k + '-')) && (!best || k.length > best.length)) best = k;
    if (best) return models[best];
    return /^claude-/.test(model || '') ? models[p.default] || null : null;   // default only for Claude models
  }
  function costOf(u) {
    let p = priceFor(u.model); if (!p) return null;
    const prompt = u.in + u.cw5 + u.cw1 + u.cr;
    if (p.long_context && prompt > p.long_context.above_prompt_tokens) p = { ...p, ...p.long_context };
    return (u.in * (p.input || 0) + u.out * (p.output || 0) + u.cw5 * (p.cache_write_5m || 0) +
      u.cw1 * (p.cache_write_1h || p.cache_write_5m || 0) + u.cr * (p.cache_read || 0)) / 1e6;
  }

  function botFor(cwd, source = 'claude') {
    const c = norm(cwd); let best = null, len = -1;
    for (const b of roster().bots || []) if (sourceOf(b) === source) for (const f of b.folders || []) {
      const n = norm(f);
      const hit = b.match === 'exact' ? c === n : (c === n || c.startsWith(n + '\\'));
      if (hit && n.length > len) { best = b; len = n.length; }
    }
    return best ? (best.id || best.name) : `drop:${source}:${c}`;
  }
  const botByAgentType = type => (roster().bots || []).find(b => b.agentType && b.agentType.toLowerCase() === String(type || '').toLowerCase());

  // ---------- Claude hook event log (monthly files) ----------
  const evTails = new Map();
  const sessions = new Map();   // id -> session (claude + codex)
  const subs = new Map();
  const finished = [];

  function migrateLegacy() {
    if (!fs.existsSync(F.legacy)) return;
    try {
      const lines = fs.readFileSync(F.legacy, 'utf8').split('\n').filter(l => l.trim());
      const byMonth = {};
      for (const l of lines) { let t = 0; try { t = ms(JSON.parse(l).time); } catch (e) {} (byMonth[monthKey(t || now())] ||= []).push(l); }
      for (const [m, ls] of Object.entries(byMonth)) {
        const f = path.join(HQ, `events-${m}.jsonl`);
        const existing = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
        const fresh = ls.filter(l => !existing.includes(l));
        if (fresh.length) fs.writeFileSync(f, fresh.join('\n') + '\n' + existing);
      }
      fs.renameSync(F.legacy, path.join(HQ, 'events.v1-migrated.jsonl'));
    } catch (e) {}
  }

  function newSession(id, e, source = 'claude') {
    return { id, source, cwd: e.cwd || '', transcript: null, first: ms(e.time) || now(), starts: [], prompts: [], rests: [], perms: [], ends: [],
      allEv: [], permMsgs: [], tx: { offset: 0, rest: '' }, usage: new Map(), lines: [], pend: [], pending: new Map(),
      lastLine: 0, model: null, modelTime: 0, actions: [], texts: [], step: '', subIds: new Set(),
      restOffMs: source === 'codex' ? CODEX_REST_OFF_MS : 0 };
  }
  function newSub(e) {
    return { id: e.agent_id, type: e.agent_type || 'agent', parent: e.session_id, start: ms(e.time), stop: 0, transcript: e.agent_transcript_path || null,
      tx: { offset: 0, rest: '' }, usage: new Map(), lines: [], pend: [], pending: new Map(), lastLine: 0, model: null, modelTime: 0,
      actions: [], texts: [], step: '', first: ms(e.time), permMsgs: [] };
  }

  function applyEvent(e) {
    const t = ms(e.time); if (!t || !e.session_id) return;
    let s = sessions.get(e.session_id);
    if (!s) { s = newSession(e.session_id, e); sessions.set(e.session_id, s); }
    if (!s.cwd && e.cwd) s.cwd = e.cwd;
    if (e.transcript_path) s.transcript = e.transcript_path;
    s.first = Math.min(s.first, t);
    insertSorted(s.allEv, t);
    switch (e.event) {
      case 'SessionStart': insertSorted(s.starts, t); break;
      case 'UserPromptSubmit': insertSorted(s.prompts, t); break;
      case 'Stop': insertSorted(s.rests, t); finished.push({ t, session: s, summary: e.summary || null }); break;
      case 'SessionEnd': insertSorted(s.ends, t); break;
      case 'Notification': {
        const type = e.notification_type || '';
        if (type === 'permission_prompt' || (!type && /permission/i.test(e.message || ''))) { insertSorted(s.perms, t); s.permMsgs.push([t, e.message || 'Needs your permission']); }
        else if (type === 'idle_prompt' || /waiting for your input/i.test(e.message || '')) insertSorted(s.rests, t);
        break;
      }
      case 'SubagentStart': case 'SubagentStop': {
        if (!e.agent_id) break;
        let a = subs.get(e.agent_id);
        if (!a) { a = newSub(e); subs.set(e.agent_id, a); }
        if (e.agent_type) a.type = e.agent_type;
        if (e.agent_transcript_path) a.transcript = e.agent_transcript_path;
        if (e.event === 'SubagentStart') a.start = Math.min(a.start || t, t); else a.stop = t;
        s.subIds.add(a.id);
        break;
      }
    }
  }
  function readEvents() {
    migrateLegacy();
    const n = now(), d = new Date(n);
    for (const m of [monthKey(new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime()), monthKey(n)]) {
      const f = path.join(HQ, `events-${m}.jsonl`);
      if (!evTails.has(f)) evTails.set(f, { offset: 0, rest: '' });
      for (const l of tail(f, evTails.get(f))) { let e; try { e = JSON.parse(l); } catch (x) { continue; } try { applyEvent(e); } catch (x) {} }
    }
  }

  // ---------- Claude transcripts ----------
  function subTranscriptPath(a) {
    if (a.transcript && fs.existsSync(a.transcript)) return a.transcript;
    const p = sessions.get(a.parent); if (!p || !p.transcript) return a.transcript;
    const dir = path.join(path.dirname(p.transcript), p.id, 'subagents'), name = `agent-${a.id}.jsonl`;
    const direct = path.join(dir, name);
    if (fs.existsSync(direct)) return (a.transcript = direct);
    try { for (const sd of fs.readdirSync(dir)) { const f = path.join(dir, sd, name); if (fs.existsSync(f)) return (a.transcript = f); } } catch (e) {}
    return a.transcript;
  }
  function pushLine(s, t) { if (t >= (s.lines[s.lines.length - 1] || 0)) { s.lines.push(t); s.pend.push(s.pending.size > 0); } s.lastLine = Math.max(s.lastLine, t); }
  function pushAction(s, t, label) { s.actions.push({ t, text: label }); if (s.actions.length > 30) s.actions.shift(); s.step = label; }
  function pushText(s, t, text) { s.step = 'Writing: ' + clip(text, 90); s.texts.push({ t, text: clip(text, 300) }); if (s.texts.length > 40) s.texts.shift(); }
  function addUsageRec(s, key, rec) {
    rec.sum = rec.in + rec.out + rec.cw5 + rec.cw1 + rec.cr;
    const prev = s.usage.get(key);
    if (!prev || rec.sum >= prev.sum) { rec.cost = costOf(rec); s.usage.set(key, rec); }
  }

  function readTranscript(s, file) {
    if (!file) return;
    const lines = tail(file, s.tx);
    if (s.tx.reset) { s.tx.reset = false; s.usage.clear(); s.lines = []; s.pend = []; s.pending.clear(); s.actions = []; s.texts = []; }
    for (const l of lines) {
      let j; try { j = JSON.parse(l); } catch (x) { continue; }
      if ((j.type !== 'assistant' && j.type !== 'user') || !j.message) continue;
      const t = ms(j.timestamp) || s.lastLine || now();
      const m = j.message;
      const content = Array.isArray(m.content) ? m.content : [];
      if (j.type === 'assistant') {
        if (m.model && m.model !== '<synthetic>' && t >= s.modelTime) { s.model = m.model; s.modelTime = t; }
        const u = m.usage;
        if (u && m.model !== '<synthetic>') {
          const cc = u.cache_creation || {};
          const cw1 = cc.ephemeral_1h_input_tokens || 0, cwAll = u.cache_creation_input_tokens || 0;
          addUsageRec(s, m.id || j.uuid || (t + ':' + JSON.stringify(u).length), { day: dayKey(t), model: m.model || s.model || '', in: u.input_tokens || 0, out: u.output_tokens || 0,
            cw5: Math.max(0, cwAll - cw1), cw1, cr: u.cache_read_input_tokens || 0 });
        }
        for (const c of content) {
          if (c.type === 'tool_use') { const label = actionLabel(c.name, c.input); s.pending.set(c.id, { t, label, name: c.name }); pushAction(s, t, label); }
          else if (c.type === 'text' && c.text && c.text.trim()) pushText(s, t, c.text);
          else if (c.type === 'thinking' && !s.pending.size) s.step = 'Thinking…';
        }
      } else {
        const results = content.filter(c => c.type === 'tool_result');
        for (const r of results) s.pending.delete(r.tool_use_id);
        const isPrompt = !j.isMeta && !results.length && (typeof m.content === 'string' || content.some(c => c.type === 'text'));
        if (isPrompt) {
          s.pending.clear();
          const txt = typeof m.content === 'string' ? m.content : (content.find(c => c.type === 'text') || {}).text || '';
          if (!txt.startsWith('<')) s.step = 'Reading prompt: ' + clip(txt, 70);
        } else if (results.length && !s.pending.size) s.step = 'Thinking…';
      }
      pushLine(s, t);
    }
  }

  // ---------- Codex rollout logs (read-only) ----------
  const codexFiles = new Map();   // file -> session
  function codexCandidateFiles(full) {
    const out = [], t = now();
    const sdir = path.join(CODEX, 'sessions');
    for (let k = 0; k < (full ? 8 : 2); k++) {
      const d = new Date(t - k * DAY);
      const dir = path.join(sdir, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
      try { for (const f of fs.readdirSync(dir)) if (/^rollout-.*\.jsonl$/.test(f)) out.push(path.join(dir, f)); } catch (e) {}
    }
    if (full) {
      const adir = path.join(CODEX, 'archived_sessions');
      try { for (const f of fs.readdirSync(adir)) if (/^rollout-.*\.jsonl(\.zst)?$/.test(f)) { const p = path.join(adir, f); try { if (t - fs.statSync(p).mtimeMs < 8 * DAY) out.push(p); } catch (e) {} } } catch (e) {}
    }
    return out;
  }
  function addCodexFile(file) {
    if (codexFiles.has(file) || !/rollout-.*\.jsonl(\.zst)?$/.test(file)) return;
    codexFiles.set(file, { file, tx: { offset: 0, rest: '' }, s: null, zst: file.endsWith('.zst'), done: false });
  }
  let codexScanAt = 0;
  function scanCodex(force) {
    const t = now();
    if (!force && t - codexScanAt < 60000) return;
    const full = !codexScanAt; codexScanAt = t;
    for (const f of codexCandidateFiles(full)) addCodexFile(f);
  }
  function codexLines(cf) {
    if (!cf.zst) return tail(cf.file, cf.tx);
    if (cf.done) return [];
    cf.done = true;   // archived + compressed: finished sessions, read once
    try { return zlib.zstdDecompressSync(fs.readFileSync(cf.file)).toString('utf8').split('\n').filter(l => l.trim()); } catch (e) { return []; }
  }
  function readCodex() {
    for (const cf of codexFiles.values()) {
      const lines = codexLines(cf);
      for (const l of lines) {
        let j; try { j = JSON.parse(l); } catch (x) { continue; }
        try { applyCodex(cf, j); } catch (x) {}
      }
    }
  }
  function applyCodex(cf, j) {
    const t = ms(j.timestamp); const p = j.payload || {};
    if (!cf.s) {
      if (j.type !== 'session_meta') return;
      const id = 'codex:' + (p.id || p.session_id || path.basename(cf.file));
      let s = sessions.get(id);
      if (!s) { s = newSession(id, { cwd: p.cwd, time: p.timestamp || j.timestamp }, 'codex'); s.transcript = cf.file; sessions.set(id, s); }
      cf.s = s; insertSorted(s.starts, s.first); insertSorted(s.allEv, s.first);
      return;
    }
    const s = cf.s;
    if (!t) return;
    switch (j.type) {
      case 'session_meta': if (!s.cwd && p.cwd) s.cwd = p.cwd; return;
      case 'turn_context': if (!s.cwd && p.cwd) s.cwd = p.cwd; if (p.model && t >= s.modelTime) { s.model = p.model; s.modelTime = t; } return;
      case 'event_msg': {
        const ty = p.type || '';
        if (ty === 'thread_settings_applied') { const m = p.thread_settings && p.thread_settings.model; if (m && t >= s.modelTime) { s.model = m; s.modelTime = t; } return; }
        if (ty === 'task_started') { insertSorted(s.prompts, t); insertSorted(s.allEv, t); s.pending.clear(); s.step = 'Reading prompt'; pushLine(s, t); return; }
        if (ty === 'task_complete' || ty === 'turn_aborted') {
          insertSorted(s.rests, t); insertSorted(s.allEv, t); s.pending.clear();
          if (ty === 'task_complete') { finished.push({ t, session: s, summary: p.last_agent_message ? clip(p.last_agent_message, 300) : null }); if (p.last_agent_message) pushText(s, t, p.last_agent_message); }
          pushLine(s, t); return;
        }
        if (/approval_request$|^request_user_input|elicitation_request/.test(ty)) {
          insertSorted(s.perms, t); insertSorted(s.allEv, t);
          const cmd = Array.isArray(p.command) ? p.command.join(' ') : (p.reason || '');
          s.permMsgs.push([t, cmd ? clip(`Codex wants to run: ${cmd}`, 120) : 'Codex needs your approval']);
          return;
        }
        if (ty === 'token_count') {
          const tu = p.info && p.info.total_token_usage; if (!tu) return;
          const cur = { input: tu.input_tokens || 0, cached: tu.cached_input_tokens || 0, cw: tu.cache_write_input_tokens || 0, out: tu.output_tokens || 0 };
          const prev = s.cxPrev || { input: 0, cached: 0, cw: 0, out: 0 };
          if (cur.input < prev.input || cur.out < prev.out) { s.cxPrev = cur; return; }   // counter reset (new thread state): new baseline
          const d = { input: cur.input - prev.input, cached: cur.cached - prev.cached, cw: cur.cw - prev.cw, out: cur.out - prev.out };
          s.cxPrev = cur;
          if (d.input + d.out <= 0) return;   // repeated token_count lines: no new usage
          addUsageRec(s, 'tc:' + t + ':' + cur.input, { day: dayKey(t), model: s.model || '', in: Math.max(0, d.input - d.cached - d.cw), out: d.out, cw5: Math.max(0, d.cw), cw1: 0, cr: Math.max(0, d.cached) });
          return;
        }
        return;
      }
      case 'response_item': {
        const ty = p.type || '';
        if (ty === 'function_call' || ty === 'custom_tool_call' || ty === 'local_shell_call') {
          const label = codexActionLabel(p.name || 'shell', p.arguments ?? p.input ?? (p.action && { command: p.action.command }), p.namespace);
          s.pending.set(p.call_id || p.id, { t, label, name: p.name });
          pushAction(s, t, label);
          if (/^request_user_input/.test(p.name || '')) { insertSorted(s.perms, t); s.permMsgs.push([t, 'Codex asks you a question']); }
        } else if (/_output$/.test(ty)) {
          s.pending.delete(p.call_id);
        } else if (ty === 'message') {
          const txt = (Array.isArray(p.content) ? p.content : []).map(c => c.text || '').join(' ').trim();
          if (p.role === 'assistant' && txt) pushText(s, t, txt);
          else if (p.role === 'user' && txt && !txt.startsWith('<')) s.step = 'Reading prompt: ' + clip(txt, 70);
          else if (p.role !== 'assistant') return;     // developer/system context: not activity
        }
        pushLine(s, t);
        return;
      }
      default: return;
    }
  }

  // ---------- status rules ----------
  function sessionStatusAt(s, t) {
    if (t < s.first) return null;
    const end = lastLE(s.ends, t);
    if (end && Math.max(lastLE(s.starts, t), lastLE(s.prompts, t)) <= end) return 'off';
    const i = idxLE(s.lines, t);
    const lineT = i >= 0 ? s.lines[i] : 0, pend = i >= 0 ? s.pend[i] : false;
    const activity = Math.max(lineT, lastLE(s.allEv, t));
    if (t - activity > STALE_MS) return 'off';
    const prompt = lastLE(s.prompts, t), rest = lastLE(s.rests, t);
    if (!prompt || rest >= prompt) return s.restOffMs && t - Math.max(activity, s.first) > s.restOffMs ? 'off' : 'resting';
    const perm = lastLE(s.perms, t);
    if (perm && perm > prompt && perm >= lineT) return 'waiting';     // clears on next line or prompt
    if (pend) return 'running';                                       // a tool is executing: never stuck
    if (t - Math.max(lineT, prompt) > STUCK_MS) return 'stuck';
    return 'working';
  }
  function subStatusAt(a, t) {
    if (!a.start || t < a.start) return null;
    if (a.stop && t >= a.stop) return null;
    const p = sessions.get(a.parent);
    if (p) { const ps = sessionStatusAt(p, t); if (ps === 'off' || ps === null) return null; }
    const i = idxLE(a.lines, t);
    const lineT = i >= 0 ? a.lines[i] : 0;
    if (t - Math.max(lineT, a.start) > SUB_STALE_MS) return null;
    return i >= 0 && a.pend[i] ? 'running' : 'working';
  }
  function statusSince(fn, x, t, st) {
    // walk back on a fixed 15 s grid (stable between ticks, so the event stream doesn't send noise)
    const g = Math.floor(t / 15000) * 15000; let since = g;
    for (let k = 1; k <= 1440; k++) { const tt = g - k * 15000; if (fn(x, tt) !== st) break; since = tt; }
    return since;
  }
  function turnOf(s, t) {
    const requested = lastLE(s.prompts, t); if (!requested) return null;
    const i = idxLE(s.lines, requested); const working = s.lines[i + 1] || null;
    const perm = lastLE(s.perms, t), rest = lastLE(s.rests, t);
    return { requested, working: working && working > requested ? working : null, approval: perm > requested ? perm : null, done: rest >= requested ? rest : null };
  }

  // ---------- aggregation ----------
  const tokenSum = () => ({ in: 0, out: 0, cw: 0, cr: 0, total: 0, cost: 0, unpriced: false });
  function addUsage(acc, usage, day) {
    for (const u of usage.values()) if (u.day === day) {
      acc.in += u.in; acc.out += u.out; acc.cw += u.cw5 + u.cw1; acc.cr += u.cr;
      if (u.cost == null) acc.unpriced = true; else acc.cost += u.cost;
    }
    acc.total = acc.in + acc.out;
    return acc;
  }
  const deskOfSub = a => { const b = botByAgentType(a.type); if (b) return b.id || b.name; const p = sessions.get(a.parent); return p ? botFor(p.cwd, p.source) : null; };

  let lastState = null, timelineCache = { at: 0, v: null }, lastPersist = 0;
  function tick() {
    readEvents();
    scanCodex(false);
    for (const s of sessions.values()) if (s.source === 'claude') readTranscript(s, s.transcript);
    readCodex();
    for (const a of subs.values()) readTranscript(a, subTranscriptPath(a));
    lastState = build();
    return lastState;
  }

  function botsSkeleton() {
    const r = roster(), bots = new Map(), teams = [...(r.teams || [])];
    const addTeam = t => { if (t && !teams.includes(t)) teams.push(t); };
    for (const b of r.bots || []) {
      addTeam(b.team || 'Ops');
      bots.set(b.id || b.name, { id: b.id || b.name, name: b.name, job: b.job || '', team: b.team || 'Ops', model: b.model || '', source: sourceOf(b),
        agentType: b.agentType || null, folder: (b.folders || [])[0] ? expand(b.folders[0]) : null, dropIn: false, sessions: [], subs: [] });
    }
    const getBot = (id, source) => {
      if (!bots.has(id) && id && id.startsWith('drop:')) {
        const d = (source === 'codex' ? r.dropInCodex : r.dropIn) || {}, folder = id.replace(/^drop:\w+:/, '');
        const team = d.team || (source === 'codex' ? 'Codex' : 'Ops');
        bots.set(id, { id, name: (source === 'codex' ? 'Codex: ' : 'Drop-in: ') + (path.basename(folder) || '?'), job: d.job || 'Folder not on the roster', team,
          model: d.model || '', source, agentType: null, folder: null, dropIn: true, sessions: [], subs: [] });
        addTeam(team);
      }
      return bots.get(id);
    };
    for (const s of sessions.values()) { const b = getBot(botFor(s.cwd, s.source), s.source); if (b) b.sessions.push(s); }
    for (const a of subs.values()) { const b = getBot(deskOfSub(a), 'claude'); if (b) b.subs.push(a); }
    return { bots, teams };
  }

  function build() {
    const t = now(), today = dayKey(t);
    const { bots, teams } = botsSkeleton();
    const out = [], counts = { working: 0, waiting: 0, stuck: 0, resting: 0, off: 0 };
    const waiting = [], stuck = [], totals = tokenSum(), feed = [];
    for (const b of bots.values()) {
      const tokens = tokenSum();
      for (const s of b.sessions) addUsage(tokens, s.usage, today);
      for (const a of b.subs) addUsage(tokens, a.usage, today);
      totals.in += tokens.in; totals.out += tokens.out; totals.cw += tokens.cw; totals.cr += tokens.cr; totals.cost += tokens.cost; totals.unpriced = totals.unpriced || tokens.unpriced;

      const live = [];
      for (const s of b.sessions) { const st = sessionStatusAt(s, t); if (st && st !== 'off') live.push({ kind: 'session', x: s, st }); }
      for (const a of b.subs) { const d = b.agentType && botByAgentType(a.type); if (d && (d.id || d.name) === b.id) { const st = subStatusAt(a, t); if (st) live.push({ kind: 'subagent', x: a, st }); } }
      live.sort((p, q) => p.x.first - q.x.first);
      const robots = live.map((r, i) => {
        const x = r.x, st = r.st;
        const fn = r.kind === 'session' ? sessionStatusAt : subStatusAt;
        const rt = addUsage(tokenSum(), x.usage, today);
        const pend = [...x.pending.values()].sort((p, q) => p.t - q.t)[0];
        let step = x.step || 'Working…', waitingMsg = null;
        if (st === 'waiting') { waitingMsg = ([...x.permMsgs].reverse().find(m => m[0] <= t) || [0, 'Needs your permission'])[1]; step = waitingMsg; }
        else if (st === 'running' && pend) step = 'Running ' + pend.label;
        else if (st === 'resting') step = 'Done: ' + ((x.texts[x.texts.length - 1] || {}).text || 'idle');
        const helpers = r.kind === 'session' && x.subIds ? [...x.subIds].map(id => subs.get(id)).filter(Boolean)
          .map(a => ({ id: a.id, type: a.type, status: subStatusAt(a, t), step: a.step })).filter(h => h.status) : [];
        const model = x.model || b.model;
        return {
          key: r.kind + ':' + x.id, kind: r.kind, id: x.id, source: b.source, label: i ? `${b.name} #${i + 1}` : b.name, status: st,
          statusSince: statusSince(fn, x, t, st), runningSince: st === 'running' && pend ? pend.t : null,
          step: clip(step, 120), waitingMsg, start: x.first, lastLine: x.lastLine || null,
          model, modelLabel: modelLabel(model, b.source), cwd: r.kind === 'session' ? x.cwd : null,
          agentType: r.kind === 'subagent' ? x.type : null, tokens: rt, helpers,
          turn: r.kind === 'session' ? turnOf(x, t) : null,
          actions: x.actions.slice(-15).reverse().map(a => ({ t: a.t, text: a.text })),
        };
      });
      if (b.dropIn && !robots.length && !b.sessions.some(s => dayKey(s.lastLine || s.first) === today)) continue;
      for (const r of robots) {
        counts[r.status === 'running' ? 'working' : r.status]++;
        if (r.status === 'waiting') waiting.push({ bot: b.name, botId: b.id, robot: r.key, label: r.label, message: r.waitingMsg, since: r.statusSince });
        if (r.status === 'stuck') stuck.push({ bot: b.name, botId: b.id, robot: r.key, label: r.label, since: r.statusSince });
      }
      if (!robots.length) counts.off++;
      const status = robots.reduce((acc, r) => (RANK[r.status] > RANK[acc] ? r.status : acc), 'off');
      const recent = [...b.sessions, ...b.subs].filter(x => x.model).sort((p, q) => q.modelTime - p.modelTime)[0];
      const model = (recent && recent.model) || b.model;
      const lastLine = Math.max(0, ...b.sessions.map(s => s.lastLine), ...b.subs.map(a => a.lastLine));
      out.push({ id: b.id, name: b.name, job: b.job, team: b.team, source: b.source, dropIn: b.dropIn, agentType: b.agentType,
        canOpen: !!(b.folder && !b.dropIn), model, modelLabel: modelLabel(model, b.source), status, tokens, lastLine: lastLine || null, robots });

      // activity feed (today): actions, approvals, arrivals/departures
      for (const s of [...b.sessions, ...b.subs]) {
        for (const a of s.actions) if (dayKey(a.t) === today) feed.push({ t: a.t, botId: b.id, bot: b.name, kind: 'action', text: feedPhrase(a.text) });
        for (const [pt, msg] of s.permMsgs || []) if (dayKey(pt) === today) feed.push({ t: pt, botId: b.id, bot: b.name, kind: 'waiting', text: 'needs approval' + (msg && s.source === 'codex' ? ': ' + clip(msg.replace(/^Codex wants to run: /, ''), 50) : '') });
        for (const st of s.starts || []) if (dayKey(st) === today) feed.push({ t: st, botId: b.id, bot: b.name, kind: 'start', text: 'came in' });
        for (const en of s.ends || []) if (dayKey(en) === today) feed.push({ t: en, botId: b.id, bot: b.name, kind: 'end', text: 'left' });
      }
      for (const r of robots) if (r.status === 'stuck') feed.push({ t: r.statusSince, botId: b.id, bot: b.name, kind: 'stuck', text: 'looks stuck' });
    }
    totals.total = totals.in + totals.out;
    const fin = finished.filter(f => dayKey(f.t) === today).map(f => {
      const s = f.session;
      const txt = f.summary || ((s.texts.filter(x => x.t <= f.t + 2000).pop() || {}).text) || '';
      const bid = botFor(s.cwd, s.source), b = bots.get(bid);
      return { time: f.t, bot: b ? b.name : 'Drop-in', botId: bid, summary: clip(txt, 180), session: s.id.replace(/^codex:/, '').slice(0, 8), sessionId: s.id };
    }).sort((a, b) => b.time - a.time).slice(0, 60);
    for (const f of fin) feed.push({ t: f.time, botId: f.botId, bot: f.bot, kind: 'done', text: 'finished: ' + clip(f.summary, 60) });
    feed.sort((a, b) => b.t - a.t);
    return { version: 3, now: t, today, teams, bots: out, counts, waiting, stuck, finished: fin, totals, feed: feed.slice(0, 60), stuckAfterMin: STUCK_MS / MIN };
  }

  // ---------- timeline (sampled with the same status rules) ----------
  function timelineFor(day0, day1, step = 60000) {
    const { bots } = botsSkeleton();
    const rows = [], seconds = {};
    for (const b of bots.values()) {
      const segs = []; let cur = null;
      const secs = { working: 0, waiting: 0, stuck: 0, resting: 0 };
      const ownSubs = b.agentType ? b.subs.filter(a => { const d = botByAgentType(a.type); return d && (d.id || d.name) === b.id; }) : [];
      // skip sessions that never touch this window
      const ss = b.sessions.filter(s => s.first < day1 && Math.max(s.lastLine, s.allEv[s.allEv.length - 1] || 0) + STALE_MS > day0);
      if (!ss.length && !ownSubs.length) { rows.push({ botId: b.id, name: b.name, segments: [] }); seconds[b.id] = secs; continue; }
      for (let t = day0; t < day1; t += step) {
        let best = null;
        for (const s of ss) { const st = sessionStatusAt(s, t); if (st && st !== 'off' && (!best || RANK[st] > RANK[best])) best = st; }
        for (const a of ownSubs) { const st = subStatusAt(a, t); if (st && (!best || RANK[st] > RANK[best])) best = st; }
        const v = best === 'running' ? 'working' : best;
        if (v) secs[v] += step / 1000;
        if (cur && cur[2] === v && cur[1] === t) cur[1] = t + step;
        else { if (cur && cur[2]) segs.push(cur); cur = [t, t + step, v]; }
      }
      if (cur && cur[2]) segs.push(cur);
      rows.push({ botId: b.id, name: b.name, segments: segs });
      seconds[b.id] = secs;
    }
    return { rows, seconds };
  }
  function timeline() {
    const t = now();
    if (timelineCache.v && t - timelineCache.at < 20000) return timelineCache.v;
    const d0 = startOfDay(t);
    const { rows } = timelineFor(d0, t + 1);
    timelineCache = { at: t, v: { dayStart: d0, now: t, rows } };
    return timelineCache.v;
  }

  // ---------- daily stats (survive event-log rotation) ----------
  function dayAggregate(day, d0, d1) {
    const { bots } = botsSkeleton();
    const { seconds } = timelineFor(d0, d1, 60000);
    const res = { date: day, bots: {}, total: {} };
    for (const b of bots.values()) {
      const tk = tokenSum();
      for (const s of b.sessions) addUsage(tk, s.usage, day);
      for (const a of b.subs) addUsage(tk, a.usage, day);
      const secs = seconds[b.id] || {};
      if (!tk.in && !tk.out && !tk.cw && !tk.cr && !Object.values(secs).some(Boolean)) continue;
      res.bots[b.id] = { name: b.name, team: b.team, source: b.source, ...tk, seconds: secs };
    }
    return res;
  }
  function mergeMax(oldAgg, agg) {
    if (!oldAgg || !oldAgg.bots) return agg;
    for (const [id, o] of Object.entries(oldAgg.bots)) {
      const n = agg.bots[id];
      if (!n) { agg.bots[id] = o; continue; }
      for (const k of ['in', 'out', 'cw', 'cr', 'cost']) n[k] = Math.max(n[k] || 0, o[k] || 0);
      n.total = n.in + n.out;
      for (const k of Object.keys(o.seconds || {})) n.seconds[k] = Math.max(n.seconds[k] || 0, o.seconds[k] || 0);
    }
    return agg;
  }
  function persistStats(force) {
    const t = now();
    if (!force && t - lastPersist < 60000) return;
    lastPersist = t;
    const today = dayKey(t);
    const days = new Set([today]);
    for (const x of [...sessions.values(), ...subs.values()]) for (const u of x.usage.values()) days.add(u.day);
    for (const day of days) {
      const f = path.join(F.stats, day + '.json');
      const old = readJSON(f, null);
      if (day !== today && old && old.final) continue;
      const [y, mo, d] = day.split('-').map(Number);
      const d0 = new Date(y, mo - 1, d).getTime(), d1 = day === today ? t : d0 + DAY;
      if (t - d0 > 40 * DAY) continue;
      const agg = mergeMax(old, dayAggregate(day, d0, d1));
      agg.total = Object.values(agg.bots).reduce((a, b) => ({ in: a.in + b.in, out: a.out + b.out, cw: a.cw + b.cw, cr: a.cr + b.cr, cost: a.cost + (b.cost || 0) }),
        { in: 0, out: 0, cw: 0, cr: 0, cost: 0 });
      agg.total.total = agg.total.in + agg.total.out;
      agg.final = day !== today; agg.updated = new Date(t).toISOString();
      agg.note = 'tokens.total = input + output; cost is an estimate from prices.json (Codex models are unpriced unless you add them)';
      try { writeJSONAtomic(f, agg); } catch (e) {}
    }
  }
  function stats(daysBack = 7) {
    persistStats(true);
    const t = now(), days = [];
    for (let i = daysBack - 1; i >= 0; i--) {
      const d = new Date(t); d.setDate(d.getDate() - i);
      const day = dayKey(d.getTime());
      days.push(readJSON(path.join(F.stats, day + '.json'), { date: day, bots: {}, total: { in: 0, out: 0, total: 0, cost: 0 } }));
    }
    const todayAgg = days[days.length - 1];
    const busiest = Object.entries(todayAgg.bots || {}).sort((a, b) => b[1].total - a[1].total)[0];
    return { days, busiestToday: busiest && busiest[1].total ? { botId: busiest[0], name: busiest[1].name, tokens: busiest[1].total, cost: busiest[1].cost } : null };
  }

  return {
    tick, state: () => lastState || tick(), timeline, stats, persistStats, roster, expand, botFor, HQ, CODEX,
    addCodexFile, scanCodex: () => scanCodex(true),
    watchedFiles: () => ({ codex: [...codexFiles.keys()], transcripts: [...sessions.values()].map(s => s.transcript).filter(Boolean) }),
    _internals: { sessions, subs, sessionStatusAt, subStatusAt, costOf, priceFor },
  };
}

module.exports = { createEngine, actionLabel, codexActionLabel, modelLabel, dayKey, monthKey };
