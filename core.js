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
// First real line of a prompt ("Fix login bug"): skips system/tool text (lines starting with "<") and interruption markers.
function taskLine(txt) {
  txt = String(txt || '');
  const req = /## My request for Codex:\s*/.exec(txt); if (req) txt = txt.slice(req.index + req[0].length);   // Codex IDE context block
  else if (/^\s*# (Files mentioned by the user|Context from my IDE)/.test(txt)) return null;
  for (const l of txt.split(/\r?\n/)) { const x = l.trim(); if (!x || x.startsWith('<') || /^\[Request interrupted/.test(x) || /^Caveat: /.test(x)) continue; return clip(x, 40); }
  return null;
}
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

// Open files are kept for files that keep growing: on Windows each open costs 1-2 ms (more under load), and
// live transcripts + the event log grow on almost every tick. A handle is closed after 20 s without new
// bytes, or when the path now points to another file (inode changed). Node opens with FILE_SHARE_DELETE,
// so a held handle never stops Claude Code / Codex from writing, renaming or deleting the file.
const FD_IDLE_MS = 20000, FD_MAX = 64, fdCache = new Map();   // file -> { fd, ino, used }
function dropFd(file) { const e = fdCache.get(file); if (e) { fdCache.delete(file); try { fs.closeSync(e.fd); } catch (x) {} } }
function fdFor(file, ino) {
  let e = fdCache.get(file);
  if (e && e.ino !== ino) { dropFd(file); e = null; }
  if (!e) {
    if (fdCache.size >= FD_MAX) { let old = null; for (const [f, x] of fdCache) if (!old || x.used < old[1].used) old = [f, x]; dropFd(old[0]); }
    e = { fd: fs.openSync(file, 'r'), ino, used: 0 }; fdCache.set(file, e);
  }
  e.used = Date.now();
  return e.fd;
}
function closeIdleFds(all) { const t = Date.now(); for (const [f, e] of [...fdCache]) if (all || t - e.used > FD_IDLE_MS) dropFd(f); }
// Read only the bytes appended since the last call; tolerate missing/rotated files.
function tail(file, st) {
  try {
    const s = fs.statSync(file), size = s.size;
    st.missing = false;
    if (size < st.offset) { st.offset = 0; st.rest = ''; st.reset = true; }
    if (size === st.offset) return [];
    const fd = fdFor(file, s.ino);
    const len = Math.min(size - st.offset, 64 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, st.offset);
    st.offset += n;
    const lines = (st.rest + buf.toString('utf8', 0, n)).split('\n');
    st.rest = lines.pop();
    return lines.filter(l => l.trim());
  } catch (e) { dropFd(file); st.missing = true; return []; }
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

  // ---------- config files (hot reload by mtime, checked once per tick) ----------
  // roster()/prices() are called per session, per subagent and per usage record: one stat per file per tick, not per call.
  const cache = {};
  let epoch = 0;
  function hot(file, dflt) {
    const c = cache[file];
    if (c && c.epoch === epoch) return c.v;
    try {
      const m = fs.statSync(file).mtimeMs;
      if (!c || c.m !== m) cache[file] = { m, v: JSON.parse(fs.readFileSync(file, 'utf8')), epoch }; else c.epoch = epoch;
    } catch (e) { if (!c) cache[file] = { m: 0, v: dflt, epoch }; else c.epoch = epoch; }
    return cache[file].v;
  }
  const roster = () => hot(F.roster, { teams: [], bots: [] });
  const prices = () => hot(F.prices, { models: {} });
  const sourceOf = b => (b.source || 'claude');
  // memo tables that live as long as the roster / prices object they were built from
  const memo = (src, fn) => { let key = null, m = new Map(); return x => { const s = src(); if (s !== key) { key = s; m = new Map(); } if (!m.has(x)) m.set(x, fn(x)); return m.get(x); }; };

  const priceFor = memo(prices, model => {
    const p = prices(), models = p.models || {};
    let best = null;
    for (const k of Object.keys(models)) if ((model === k || String(model).startsWith(k + '-')) && (!best || k.length > best.length)) best = k;
    if (best) return models[best];
    return /^claude-/.test(model || '') ? models[p.default] || null : null;   // default only for Claude models
  });
  function costOf(u) {
    let p = priceFor(u.model); if (!p) return null;
    const prompt = u.in + u.cw5 + u.cw1 + u.cr;
    if (p.long_context && prompt > p.long_context.above_prompt_tokens) p = { ...p, ...p.long_context };
    return (u.in * (p.input || 0) + u.out * (p.output || 0) + u.cw5 * (p.cache_write_5m || 0) +
      u.cw1 * (p.cache_write_1h || p.cache_write_5m || 0) + u.cr * (p.cache_read || 0)) / 1e6;
  }

  const botForKey = memo(roster, key => {
    const i = key.indexOf('|'), source = key.slice(0, i), c = norm(key.slice(i + 1)); let best = null, len = -1;
    for (const b of roster().bots || []) if (sourceOf(b) === source) for (const f of b.folders || []) {
      const n = norm(f);
      const hit = b.match === 'exact' ? c === n : (c === n || c.startsWith(n + '\\'));
      if (hit && n.length > len) { best = b; len = n.length; }
    }
    return best ? (best.id || best.name) : `drop:${source}:${c}`;
  });
  const botFor = (cwd, source = 'claude') => botForKey(source + '|' + (cwd || ''));
  const botByAgentType = memo(roster, type => (roster().bots || []).find(b => b.agentType && b.agentType.toLowerCase() === String(type || '').toLowerCase()));

  // ---------- Claude hook event log (monthly files) ----------
  const evTails = new Map();
  const sessions = new Map();   // id -> session (claude + codex)
  const subs = new Map();
  const finished = [];
  const byFile = new Map();     // transcript path (lowercase) -> session, for watcher hints
  const fileKey = f => path.resolve(String(f)).toLowerCase();

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
      allEv: [], permMsgs: [], tx: { offset: 0, rest: '' }, usage: new Map(), usageDays: new Map(), lines: [], pend: [], pending: new Map(),
      lastLine: 0, model: null, modelTime: 0, actions: [], texts: [], step: '', task: null, subIds: new Set(), daily: new Map(),
      restOffMs: source === 'codex' ? CODEX_REST_OFF_MS : 0 };
  }
  function newSub(e) {
    return { id: e.agent_id, type: e.agent_type || 'agent', parent: e.session_id, start: ms(e.time), stop: 0, transcript: e.agent_transcript_path || null,
      tx: { offset: 0, rest: '' }, usage: new Map(), usageDays: new Map(), lines: [], pend: [], pending: new Map(), lastLine: 0, model: null, modelTime: 0,
      actions: [], texts: [], step: '', task: null, first: ms(e.time), permMsgs: [], daily: new Map() };
  }

  function applyEvent(e) {
    const t = ms(e.time); if (!t || !e.session_id) return;
    let s = sessions.get(e.session_id);
    if (!s) { s = newSession(e.session_id, e); sessions.set(e.session_id, s); }
    if (!s.cwd && e.cwd) s.cwd = e.cwd;
    if (e.transcript_path && s.transcript !== e.transcript_path) { s.transcript = e.transcript_path; byFile.set(fileKey(e.transcript_path), s); }
    s._dirty = true;
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
        a._dirty = true;
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
  // per-day activity for the daily report: distinct files edited, commands run
  function bumpDaily(s, t, files, cmd) {
    const day = dayKey(t); let d = s.daily.get(day);
    if (!d) s.daily.set(day, d = { files: new Set(), cmds: 0 });
    for (const f of files || []) if (f) d.files.add(String(f).replace(/\\/g, '/').toLowerCase());
    if (cmd) d.cmds++;
  }
  function pushText(s, t, text) { s.step = 'Writing: ' + clip(text, 90); s.texts.push({ t, text: clip(text, 300) }); if (s.texts.length > 40) s.texts.shift(); }
  function addUsageRec(s, key, rec) {
    rec.sum = rec.in + rec.out + rec.cw5 + rec.cw1 + rec.cr;
    const prev = s.usage.get(key);
    if (!prev || rec.sum >= prev.sum) { rec.cost = costOf(rec); s.usage.set(key, rec); }
  }

  function readTranscript(s, file) {
    if (!file) return;
    const lines = tail(file, s.tx);
    if (s.tx.reset) { s.tx.reset = false; s.usage.clear(); s.usageDays.clear(); s.lines = []; s.pend = []; s.pending.clear(); s.actions = []; s.texts = []; s.daily.clear(); }
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
          if (c.type === 'tool_use') {
            const label = actionLabel(c.name, c.input); s.pending.set(c.id, { t, label, name: c.name }); pushAction(s, t, label);
            const inp = c.input || {};
            if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name)) bumpDaily(s, t, [inp.file_path || inp.notebook_path], false);
            else if (c.name === 'Bash' || c.name === 'PowerShell') bumpDaily(s, t, null, true);
          }
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
          if (!j.isCompactSummary) for (const p of typeof m.content === 'string' ? [m.content] : content.filter(c => c.type === 'text').map(c => c.text)) { const task = taskLine(p); if (task) { s.task = task; break; } }
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
    const cf = codexFiles.get(file);
    if (cf) { cf.dirty = true; return; }               // watcher hint: read it on the next tick
    if (!/rollout-.*\.jsonl(\.zst)?$/.test(file)) return;
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
  function readCodexFile(cf) {
    for (const l of codexLines(cf)) {
      let j; try { j = JSON.parse(l); } catch (x) { continue; }
      try { applyCodex(cf, j); } catch (x) {}
    }
  }
  function applyCodex(cf, j) {
    const t = ms(j.timestamp); const p = j.payload || {};
    if (!cf.s && cf.meta) {   // pruned earlier (old thread) and it got new lines: bring the session back
      let s = sessions.get(cf.meta.id);
      if (!s) { s = newSession(cf.meta.id, { cwd: cf.meta.cwd, time: cf.meta.first }, 'codex'); Object.assign(s, { transcript: cf.file, cxPrev: cf.meta.cxPrev, model: cf.meta.model, modelTime: cf.meta.modelTime || 0 }); sessions.set(s.id, s); }
      cf.s = s; cf.meta = null;
    }
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
          if (/^Shell: /.test(label)) bumpDaily(s, t, null, true);
          else {
            const raw = p.arguments ?? p.input ?? '', txt = typeof raw === 'string' ? raw : JSON.stringify(raw);
            const files = [...txt.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n"\\]+)/g)].map(m => m[1].trim());
            if (files.length) bumpDaily(s, t, files, false);
          }
          if (/^request_user_input/.test(p.name || '')) { insertSorted(s.perms, t); s.permMsgs.push([t, 'Codex asks you a question']); }
        } else if (/_output$/.test(ty)) {
          s.pending.delete(p.call_id);
        } else if (ty === 'message') {
          const parts = Array.isArray(p.content) ? p.content : [], txt = parts.map(c => c.text || '').join(' ').trim();
          if (p.role === 'assistant' && txt) pushText(s, t, txt);
          else if (p.role === 'user' && txt && !txt.startsWith('<')) { s.step = 'Reading prompt: ' + clip(txt, 70); for (const c of parts) { const task = taskLine(c.text); if (task) { s.task = task; break; } } }
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
  // the walk above only runs when a robot's status changes; while it stays the same, "since" does not move.
  // An entry not confirmed for a minute (robot was off the floor in between) is recomputed.
  function statusSinceCached(fn, x, t, st) {
    const c = x._since;
    if (c && c.st === st && t - c.at <= 60000 && t >= c.at) { c.at = t; return c.since; }
    const since = statusSince(fn, x, t, st);
    x._since = { st, since, at: t };
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
  // usage of one session/subagent on one day: live records (still deduped by message id) + records already folded per day
  function addUsage(acc, x, day) {
    for (const u of x.usage.values()) if (u.day === day) {
      acc.in += u.in; acc.out += u.out; acc.cw += u.cw5 + u.cw1; acc.cr += u.cr;
      if (u.cost == null) acc.unpriced = true; else acc.cost += u.cost;
    }
    const f = x.usageDays && x.usageDays.get(day);
    if (f) { acc.in += f.in; acc.out += f.out; acc.cw += f.cw5 + f.cw1; acc.cr += f.cr; acc.cost += f.cost; if (f.unpriced) acc.unpriced = true; }
    acc.total = acc.in + acc.out;
    return acc;
  }
  const usageDaysOf = x => { const d = new Set(x.usageDays ? x.usageDays.keys() : []); for (const u of x.usage.values()) d.add(u.day); return d; };
  const deskOfSub = a => { const b = botByAgentType(a.type); if (b) return b.id || b.name; const p = sessions.get(a.parent); return p ? botFor(p.cwd, p.source) : null; };

  let lastState = null, timelineCache = { at: 0, v: null }, lastPersist = 0;
  // Reading: live sessions every tick; sessions that are off (and stopped subagents) only on a watcher hint
  // or every 30 s. Each tick reads for at most READ_BUDGET_MS; the rest waits for the next tick (`backlog`),
  // so a cold start with days of history never blocks the server in one long tick (opts.readBudgetMs; default: no limit).
  const READ_BUDGET_MS = opts.readBudgetMs || Infinity, IDLE_READ_MS = 30000;   // the server passes 60
  let backlog = 0, warm = false, tickParts = { readMs: 0, buildMs: 0 };
  const dueSession = (s, t) => !s._readAt || s._dirty || s._st !== 'off' || t - s._readAt > IDLE_READ_MS;
  const dueSub = (a, t) => !a._readAt || a._dirty || t - a._readAt > IDLE_READ_MS || (a.stop ? t - a.stop < 60000 : t - Math.max(a.lastLine || 0, a.start || 0) < SUB_STALE_MS);
  const dueCodex = (cf, t) => !cf._readAt || cf.dirty || (!cf.s && !cf.meta) || (cf.s && cf.s._st !== 'off') || t - cf._readAt > IDLE_READ_MS;
  function tick() {
    epoch++;
    const t = now(), deadline = Date.now() + READ_BUDGET_MS;
    const t0 = Date.now();
    readEvents();
    scanCodex(false);
    let left = 0;
    const read = (x, fn) => { if (Date.now() > deadline) { left++; return; } fn(); x._readAt = t; x._dirty = false; x.dirty = false; };
    for (const s of sessions.values()) if (s.source === 'claude' && dueSession(s, t)) read(s, () => readTranscript(s, s.transcript));
    for (const cf of codexFiles.values()) if (dueCodex(cf, t)) read(cf, () => readCodexFile(cf));
    for (const a of subs.values()) if (dueSub(a, t)) read(a, () => { const f = subTranscriptPath(a); if (f && a._fk !== f) { a._fk = f; byFile.set(fileKey(f), a); } readTranscript(a, f); });
    backlog = left; if (!left) warm = true;
    closeIdleFds(false);
    const t1 = Date.now();
    lastState = build();
    tickParts = { readMs: t1 - t0, buildMs: Date.now() - t1 };
    return lastState;
  }
  // watcher hint: this file changed, read it on the next tick even if its session is off
  function hint(file) {
    const x = byFile.get(fileKey(file)); if (x) x._dirty = true;
    else if (/subagents[\\/]agent-/.test(file)) for (const a of subs.values()) if (!a._fk && file.includes(a.id)) a._dirty = true;
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
      for (const s of b.sessions) addUsage(tokens, s, today);
      for (const a of b.subs) addUsage(tokens, a, today);
      totals.in += tokens.in; totals.out += tokens.out; totals.cw += tokens.cw; totals.cr += tokens.cr; totals.cost += tokens.cost; totals.unpriced = totals.unpriced || tokens.unpriced;

      const live = [];
      for (const s of b.sessions) { const st = sessionStatusAt(s, t); s._st = st || 'off'; if (st && st !== 'off') live.push({ kind: 'session', x: s, st }); }
      for (const a of b.subs) { const d = b.agentType && botByAgentType(a.type); if (d && (d.id || d.name) === b.id) { const st = subStatusAt(a, t); if (st) live.push({ kind: 'subagent', x: a, st }); } }
      live.sort((p, q) => p.x.first - q.x.first);
      const robots = live.map((r, i) => {
        const x = r.x, st = r.st;
        const fn = r.kind === 'session' ? sessionStatusAt : subStatusAt;
        const rt = addUsage(tokenSum(), x, today);
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
          statusSince: statusSinceCached(fn, x, t, st), runningSince: st === 'running' && pend ? pend.t : null,
          step: clip(step, 120), task: x.task || null, waitingMsg, start: x.first, lastLine: x.lastLine || null,
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
        canOpen: !!(b.folder && !b.dropIn), git: !b.dropIn && opts.gitInfo ? opts.gitInfo(b.id) || null : null, model, modelLabel: modelLabel(model, b.source), status, tokens, lastLine: lastLine || null, robots });

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
  const ownSubsOf = b => b.agentType ? b.subs.filter(a => { const d = botByAgentType(a.type); return d && (d.id || d.name) === b.id; }) : [];
  const lastData = s => Math.max(s.lastLine || 0, s.allEv[s.allEv.length - 1] || 0, s.first || 0);
  const touches = (s, day0, day1) => s.first < day1 && lastData(s) + STALE_MS > day0;
  const emptySecs = () => ({ working: 0, waiting: 0, stuck: 0, resting: 0 });
  // samples [from, to) every `step` ms for one bot; appends to segs (extending the last one) and secs
  function sampleBot(ss, own, from, to, step, segs, secs) {
    let cur = segs.length ? segs[segs.length - 1] : null;
    for (let t = from; t < to; t += step) {
      let best = null;
      for (const s of ss) { const st = sessionStatusAt(s, t); if (st && st !== 'off' && (!best || RANK[st] > RANK[best])) best = st; }
      for (const a of own) { const st = subStatusAt(a, t); if (st && (!best || RANK[st] > RANK[best])) best = st; }
      const v = best === 'running' ? 'working' : best;
      if (!v) { cur = null; continue; }
      secs[v] += step / 1000;
      if (cur && cur[2] === v && cur[1] === t) cur[1] = t + step;
      else { cur = [t, t + step, v]; segs.push(cur); }
    }
  }
  function timelineForBot(b, day0, day1, step = 60000) {
    const ss = b.sessions.filter(s => touches(s, day0, day1)), own = ownSubsOf(b), segs = [], secs = emptySecs();
    if (ss.length || own.length) sampleBot(ss, own, day0, day1, step, segs, secs);
    return { segs, secs };
  }
  function timelineFor(day0, day1, step = 60000) {
    const { bots } = botsSkeleton(), rows = [], seconds = {};
    for (const b of bots.values()) { const r = timelineForBot(b, day0, day1, step); rows.push({ botId: b.id, name: b.name, segments: r.segs }); seconds[b.id] = r.secs; }
    return { rows, seconds };
  }
  // Today, incrementally: minutes older than 2 min are settled and cached per bot, so each call only samples
  // the new minutes (not 1440 x sessions). A bot is resampled from midnight when one of its sessions or
  // subagents shows up with data older than its cached part (e.g. a Codex file found by the 60 s scan).
  let tlc = { d0: 0, bots: new Map() };
  function todayTimeline(t) {
    const d0 = startOfDay(t); if (tlc.d0 !== d0) tlc = { d0, bots: new Map() };
    const settled = Math.max(d0, d0 + Math.floor((t - 2 * MIN - d0) / 60000) * 60000);
    const { bots } = botsSkeleton(), rows = [], seconds = {};
    for (const b of bots.values()) {
      const ss = b.sessions.filter(s => touches(s, d0, t + 1)), own = ownSubsOf(b), any = ss.length || own.length;
      let c = tlc.bots.get(b.id);
      if (c) for (const x of [...ss, ...own]) if (!c.ids.has(x.id) && x.first < c.upTo) { c = null; break; }
      if (!c) c = { upTo: d0, segs: [], secs: emptySecs(), ids: new Set() };
      if (any && settled > c.upTo) sampleBot(ss, own, c.upTo, settled, 60000, c.segs, c.secs);
      c.upTo = Math.max(c.upTo, settled);
      for (const x of ss) c.ids.add(x.id);
      for (const a of own) c.ids.add(a.id);
      tlc.bots.set(b.id, c);
      const segs = c.segs.map(s => s.slice()), secs = { ...c.secs };   // the unsettled tail is sampled fresh, on copies
      if (any) sampleBot(ss, own, c.upTo, t + 1, 60000, segs, secs);
      rows.push({ botId: b.id, name: b.name, segments: segs }); seconds[b.id] = secs;
    }
    return { rows, seconds };
  }
  function timeline() {
    const t = now();
    if (timelineCache.v && t - timelineCache.at < 20000) return timelineCache.v;
    const { rows } = todayTimeline(t);
    timelineCache = { at: t, v: { dayStart: startOfDay(t), now: t, rows } };
    return timelineCache.v;
  }

  // ---------- daily stats (survive event-log rotation) ----------
  // Past days are written once, final, by a backfill that does one bot per step (the server runs the steps
  // in setImmediate chunks, never inside a tick). Today is rewritten once a minute from the incremental timeline.
  const statFile = day => path.join(F.stats, day + '.json');
  const dayStart = day => { const [y, mo, d] = day.split('-').map(Number); return new Date(y, mo - 1, d).getTime(); };
  const finalDays = new Set();
  function botStat(b, day, secs) {
    const tk = tokenSum();
    for (const s of b.sessions) addUsage(tk, s, day);
    for (const a of b.subs) addUsage(tk, a, day);
    if (!tk.in && !tk.out && !tk.cw && !tk.cr && !Object.values(secs).some(Boolean)) return null;
    return { name: b.name, team: b.team, source: b.source, ...tk, seconds: secs };
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
  function writeDay(day, res, final) {
    const t = now(), f = statFile(day);
    const agg = mergeMax(readJSON(f, null), res);
    agg.total = Object.values(agg.bots).reduce((a, b) => ({ in: a.in + b.in, out: a.out + b.out, cw: a.cw + b.cw, cr: a.cr + b.cr, cost: a.cost + (b.cost || 0) }),
      { in: 0, out: 0, cw: 0, cr: 0, cost: 0 });
    agg.total.total = agg.total.in + agg.total.out;
    agg.final = final; agg.updated = new Date(t).toISOString();
    agg.note = 'tokens.total = input + output; cost is an estimate from prices.json (Codex models are unpriced unless you add them)';
    try { writeJSONAtomic(f, agg); } catch (e) {}
    if (final) finalDays.add(day);
  }
  // past days with usage in memory that have no final stats file yet
  function pendingDays() {
    const t = now(), today = dayKey(t), days = new Set(), out = [];
    for (const x of sessions.values()) for (const d of usageDaysOf(x)) days.add(d);
    for (const x of subs.values()) for (const d of usageDaysOf(x)) days.add(d);
    for (const day of days) {
      if (day === today || finalDays.has(day)) continue;
      const d0 = dayStart(day);
      if (t - d0 > 40 * DAY || d0 > t) { finalDays.add(day); continue; }   // too old to keep / clock skew
      const old = readJSON(statFile(day), null);
      if (old && old.final) { finalDays.add(day); continue; }
      out.push(day);
    }
    return out.sort();
  }
  let job = null;
  function backfillStep() {   // one small unit of work; false when there is nothing left
    if (!job) {
      const days = pendingDays(); if (!days.length) return false;
      const day = days[0], d0 = dayStart(day);
      job = { day, d0, d1: d0 + DAY, bots: [...botsSkeleton().bots.values()], i: 0, res: { date: day, bots: {}, total: {} } };
      return true;
    }
    if (job.i < job.bots.length) {
      const b = job.bots[job.i++], st = botStat(b, job.day, timelineForBot(b, job.d0, job.d1).secs);
      if (st) job.res.bots[b.id] = st;
      return true;
    }
    writeDay(job.day, job.res, true); job = null;
    return true;
  }
  function persistToday() {
    const t = now(), day = dayKey(t), { seconds } = todayTimeline(t), { bots } = botsSkeleton(), res = { date: day, bots: {}, total: {} };
    for (const b of bots.values()) { const st = botStat(b, day, seconds[b.id] || emptySecs()); if (st) res.bots[b.id] = st; }
    writeDay(day, res, false);
  }
  function persistStats(force) {   // everything at once (tests, CLI); the server uses backfillStep + persistToday
    const t = now();
    if (!force && t - lastPersist < 60000) return;
    lastPersist = t;
    for (let n = 0; backfillStep() && n < 1e6; n++);
    persistToday();
  }
  function stats(daysBack = 7) {
    persistToday();
    const t = now(), days = [];
    for (let i = daysBack - 1; i >= 0; i--) {
      const d = new Date(t); d.setDate(d.getDate() - i);
      const day = dayKey(d.getTime());
      days.push(readJSON(statFile(day), { date: day, bots: {}, total: { in: 0, out: 0, total: 0, cost: 0 } }));
    }
    const todayAgg = days[days.length - 1];
    const busiest = Object.entries(todayAgg.bots || {}).sort((a, b) => b[1].total - a[1].total)[0];
    return { days, busiestToday: busiest && busiest[1].total ? { botId: busiest[0], name: busiest[1].name, tokens: busiest[1].total, cost: busiest[1].cost } : null };
  }

  // ---------- daily report (built by report.js in a child process from a fresh engine: logs + transcripts) ----------
  function report(day) {
    const d0 = dayStart(day), d1 = d0 + DAY, t = now(), until = Math.min(d1, t + 1);
    const { bots } = botsSkeleton(), rows = [], fin = [];
    for (const f of finished) if (f.t >= d0 && f.t < d1) {
      const s = f.session, bid = botFor(s.cwd, s.source), b = bots.get(bid);
      fin.push({ t: f.t, botId: bid, bot: b ? b.name : 'Drop-in', summary: clip(f.summary || ((s.texts.filter(x => x.t <= f.t + 2000).pop() || {}).text) || '', 200) });
    }
    for (const b of bots.values()) {
      const all = [...b.sessions, ...b.subs];
      const tl = timelineForBot(b, d0, until);
      const tokens = tokenSum(); for (const x of all) addUsage(tokens, x, day); tokens.total = tokens.in + tokens.out;
      const files = new Set(); let commands = 0;
      for (const x of all) { const d = x.daily && x.daily.get(day); if (d) { d.files.forEach(f => files.add(f)); commands += d.cmds; } }
      // each permission prompt = one wait, from the prompt until the next transcript line, prompt, stop or end
      let perms = 0, permSec = 0;
      const after = (a, p) => { const i = idxLE(a, p) + 1; return i < a.length ? a[i] : Infinity; };
      for (const s of b.sessions) for (const p of s.perms) if (p >= d0 && p < d1) {
        perms++;
        permSec += Math.max(0, Math.min(after(s.lines, p), after(s.prompts, p), after(s.rests, p), after(s.ends, p), until) - p) / 1000;
      }
      // episodes: segments of one status, merged across gaps of up to 2 minutes (a sample of another status in between)
      const segs = tl.segs, count = st => { let n = 0, last = -Infinity; for (const x of segs) if (x[2] === st) { if (x[0] - last > 120000) n++; last = x[1]; } return n; };
      const finishedN = fin.filter(f => f.botId === b.id).length;
      const active = tl.secs.working + tl.secs.waiting + tl.secs.stuck;
      if (!active && !tl.secs.resting && !tokens.in && !tokens.out && !tokens.cr && !finishedN && !files.size && !commands) continue;
      rows.push({ id: b.id, name: b.name, team: b.team, source: b.source, dropIn: b.dropIn, activeSec: active, workingSec: tl.secs.working, restingSec: tl.secs.resting,
        finished: finishedN, files: files.size, commands, tokens, waits: Math.max(perms, count("waiting")), waitSec: Math.max(tl.secs.waiting, Math.round(permSec)), stuck: count('stuck'), stuckSec: tl.secs.stuck,
        segments: segs.map(x => [x[0], Math.min(x[1], until), x[2]]) });
    }
    rows.sort((a, b) => b.activeSec - a.activeSec || b.tokens.total - a.tokens.total);
    const sum = k => rows.reduce((a, r) => a + r[k], 0);
    const totals = { activeSec: sum('activeSec'), finished: fin.length, files: sum('files'), commands: sum('commands'), waits: sum('waits'), waitSec: sum('waitSec'), stuck: sum('stuck'),
      tokens: rows.reduce((a, r) => { for (const k of ['in', 'out', 'cw', 'cr', 'total', 'cost']) a[k] += r.tokens[k]; a.unpriced = a.unpriced || r.tokens.unpriced; return a; }, tokenSum()) };
    return { date: day, dayStart: d0, until, partial: until < d1, generated: t, bots: rows, totals, finished: fin.sort((a, b) => a.t - b.t) };
  }

  // ---------- memory: prune what today no longer needs, compact what stays ----------
  // Status, timeline and stats for today need: sessions with data today (or still on at midnight), the last
  // entry before midnight of each time list, and per-minute detail of today. Everything older is already in
  // stats/YYYY-MM-DD.json (pruning waits until the backfill has written those files).
  const RECENT_MS = 20 * MIN, COMPACT_MIN = 32, MAX_LIVE_USAGE = 16, MAX_PERM_MSGS = 60, MAX_FINISHED = 200;
  // keep: everything since exactFrom; between cutoff and exactFrom the first + last entry of each minute
  // (the timeline samples on whole minutes, so its answers stay the same); before cutoff only the last entry.
  function keepMask(a, cutoff, exactFrom) {
    const n = a.length, keep = new Uint8Array(n); let lastBefore = -1;
    for (let i = 0; i < n; i++) {
      const v = a[i];
      if (v < cutoff) { lastBefore = i; continue; }
      if (v >= exactFrom) { keep[i] = 1; continue; }
      const b = Math.floor(v / 60000);
      if (i === 0 || a[i - 1] < cutoff || Math.floor(a[i - 1] / 60000) !== b || i === n - 1 || Math.floor(a[i + 1] / 60000) !== b) keep[i] = 1;
    }
    if (lastBefore >= 0) keep[lastBefore] = 1;
    return keep;
  }
  function compactTimes(x, k, cutoff, exactFrom) {
    const a = x[k]; if (!a || a.length < COMPACT_MIN) return;
    const m = keepMask(a, cutoff, exactFrom); x[k] = a.filter((_, i) => m[i]);
  }
  function foldUsage(x, cutoffDay) {
    for (const [key, u] of x.usage) if (u.day < cutoffDay && finalDays.has(u.day)) x.usage.delete(key);   // already final in stats/
    for (const d of x.usageDays.keys()) if (d < cutoffDay && finalDays.has(d)) x.usageDays.delete(d);
    let extra = x.usage.size - MAX_LIVE_USAGE;
    for (const [key, u] of x.usage) {   // oldest first: their message ids do not come back
      if (extra-- <= 0) break;
      let d = x.usageDays.get(u.day);
      if (!d) x.usageDays.set(u.day, d = { in: 0, out: 0, cw5: 0, cw1: 0, cr: 0, cost: 0, unpriced: false });
      d.in += u.in; d.out += u.out; d.cw5 += u.cw5; d.cw1 += u.cw1; d.cr += u.cr;
      if (u.cost == null) d.unpriced = true; else d.cost += u.cost;
      x.usage.delete(key);
    }
  }
  function compactLines(x, cutoff, exactFrom, forceIdx = -1) {
    if (x.lines.length >= COMPACT_MIN) {
      const m = keepMask(x.lines, cutoff, exactFrom);
      if (forceIdx >= 0 && forceIdx < m.length) m[forceIdx] = 1;
      x.lines = x.lines.filter((_, i) => m[i]); x.pend = x.pend.filter((_, i) => m[i]);
    }
    foldUsage(x, dayKey(cutoff));
    if (x.daily) for (const d of [...x.daily.keys()]) if (d < dayKey(cutoff)) x.daily.delete(d);   // past days: in reports/ already
  }
  function compactSession(s, cutoff, exactFrom) {
    for (const k of ['starts', 'prompts', 'rests', 'perms', 'ends', 'allEv']) compactTimes(s, k, cutoff, exactFrom);
    const lp = s.prompts[s.prompts.length - 1];
    compactLines(s, cutoff, exactFrom, lp ? idxLE(s.lines, lp) + 1 : -1);   // keeps "working since" of the current turn exact
    if (s.permMsgs.length > MAX_PERM_MSGS) s.permMsgs = s.permMsgs.slice(-MAX_PERM_MSGS);
  }
  function maintain() {
    const t = now(), d0 = startOfDay(t), today = dayKey(t);
    const pend = pendingDays();
    const cutoff = pend.length ? Math.min(d0, dayStart(pend[0])) : d0;   // never compact a day whose final stats are not written yet
    const hasToday = x => { for (const d of usageDaysOf(x)) if (d >= today) return true; return false; };
    const subLast = a => Math.max(a.lastLine || 0, a.stop || 0, a.start || 0);
    let pruned = 0;
    if (warm && !pend.length && !job) {
      for (const [id, s] of sessions) {
        if (lastData(s) >= d0 || hasToday(s)) continue;
        const st = sessionStatusAt(s, d0); if (st && st !== 'off') continue;          // still on at midnight: today's timeline needs it
        if ([...s.subIds].some(aid => { const a = subs.get(aid); return a && (subLast(a) >= d0 || hasToday(a)); })) continue;
        sessions.delete(id); pruned++;
        if (s.transcript && byFile.get(fileKey(s.transcript)) === s) byFile.delete(fileKey(s.transcript));
        for (const aid of s.subIds) { const a = subs.get(aid); if (a) { subs.delete(aid); if (a._fk) byFile.delete(fileKey(a._fk)); } }
      }
      for (const [id, a] of subs) if (!sessions.has(a.parent) && subLast(a) < d0 && !hasToday(a)) { subs.delete(id); if (a._fk) byFile.delete(fileKey(a._fk)); pruned++; }
      for (const cf of codexFiles.values()) if (cf.s && !sessions.has(cf.s.id)) {
        cf.meta = { id: cf.s.id, cwd: cf.s.cwd, first: cf.s.first, cxPrev: cf.s.cxPrev, model: cf.s.model, modelTime: cf.s.modelTime }; cf.s = null;
      }
      const scanned = new Set(codexCandidateFiles(false));   // rollout files that are no longer scanned (older than yesterday) can go too
      for (const [f, cf] of codexFiles) if (!cf.s && cf.meta && !scanned.has(f)) codexFiles.delete(f);
    }
    const keepFin = finished.filter(f => f.t >= d0 && sessions.has(f.session.id)).sort((a, b) => a.t - b.t).slice(-MAX_FINISHED);
    finished.length = 0; finished.push(...keepFin);
    for (const s of sessions.values()) { compactSession(s, cutoff, t - RECENT_MS); for (const aid of s.subIds) if (!subs.has(aid)) s.subIds.delete(aid); }
    for (const a of subs.values()) compactLines(a, cutoff, t - RECENT_MS);
    timelineCache = { at: 0, v: null };
    return { pruned, pendingDays: pend.length };
  }

  // what the engine holds in memory (for /api/health and `agent-hq soak`)
  function memStats() {
    let items = 0, usage = 0;
    const len = a => (a ? (a.length ?? a.size ?? 0) : 0);
    for (const x of [...sessions.values(), ...subs.values()]) {
      for (const k of ['lines', 'pend', 'allEv', 'prompts', 'rests', 'perms', 'permMsgs', 'starts', 'ends', 'actions', 'texts']) items += len(x[k]);
      usage += len(x.usage) + len(x.usageDays);
    }
    return { sessions: sessions.size, subs: subs.size, finished: finished.length, arrayItems: items, usageRecords: usage, codexFiles: codexFiles.size, warm, backlog, backfilling: !!job };
  }

  return {
    tick, state: () => lastState || tick(), timeline, stats, report, persistStats, persistToday, backfillStep, maintain, hint, roster, expand, botFor, HQ, CODEX,
    addCodexFile, scanCodex: () => scanCodex(true), memStats, tickParts: () => tickParts, close: () => closeIdleFds(true), openFiles: () => fdCache.size, isWarm: () => warm, backlog: () => backlog,
    watchedFiles: () => ({ codex: [...codexFiles.keys()], transcripts: [...sessions.values()].map(s => s.transcript).filter(Boolean) }),
    _internals: { sessions, subs, finished, sessionStatusAt, subStatusAt, costOf, priceFor, timelineFor, todayTimeline, pendingDays },
  };
}

module.exports = { createEngine, taskLine, actionLabel, codexActionLabel, modelLabel, dayKey, monthKey };
