#!/usr/bin/env node
// agent-hq soak --minutes=60: long-run leak / slowdown test through the real server.
// Builds a throwaway home (8 days of Claude + Codex history), starts server.js on a spare port against it,
// opens the page in Chrome (?soak=1: renders every frame) and drives a busy fake day: 15 agents,
// one hook event or transcript line every ~300 ms, sessions starting and ending, drop-ins appearing,
// subagents, Codex threads finishing. Once a minute it records page + server numbers to
// ~/.agent-hq/soak-<date>-<time>[-tag].csv and prints minute 1 vs the last minute at the end.
// Never touches your real ~/.agent-hq data, ~/.claude or ~/.codex. --no-page: server only (no Chrome).
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const MINUTES = +arg('minutes', 60), PORT = +arg('port', 7795), INTERVAL = +arg('interval', 300), TAG = arg('tag', '');
const KEEP = process.argv.includes('--keep'), HEADFUL = process.argv.includes('--headful'), NOPAGE = process.argv.includes('--no-page');
const OUT_DIR = path.join(os.homedir(), '.agent-hq');
const pad = n => String(n).padStart(2, '0');
const dayDir = t => { const d = new Date(t); return [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())]; };
const monthKey = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const iso = t => new Date(t).toISOString();
const sleep = n => new Promise(r => setTimeout(r, n));
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = a => a[Math.floor(rnd() * a.length)];
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

// ---------- throwaway home ----------
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-soak-'));
const HQ = path.join(HOME, '.agent-hq'); fs.mkdirSync(HQ, { recursive: true });
const PROJ = path.join(HOME, '.claude', 'projects');
const CODEX = path.join(HOME, '.codex', 'sessions');
const CLAUDE_BOTS = ['hq', 'nexus', 'locqa', 'tutor', 'scratch', 'pixel', 'deploy', 'scout'];
const TEAM = { hq: 'Ops', nexus: 'Visuals', locqa: 'Research', tutor: 'Content', scratch: 'Content', pixel: 'Visuals', deploy: 'Ops', scout: 'Research' };
const SUB_TYPES = ['researcher', 'writer', 'designer', 'reviewer'];
const CODEX_BOTS = ['cxchats', 'moodle', 'hack'];
const roster = {
  teams: ['Research', 'Content', 'Visuals', 'Ops', 'Codex'], dropIn: { team: 'Ops' }, dropInCodex: { team: 'Codex' },
  bots: [
    ...CLAUDE_BOTS.map(id => ({ id, name: id[0].toUpperCase() + id.slice(1), team: TEAM[id], model: 'claude-opus-5-5', folders: [`~/p/${id}`] })),
    { id: 'researcher', name: 'Researcher', team: 'Research', agentType: 'researcher', folders: [] },
    { id: 'writer', name: 'Writer', team: 'Content', agentType: 'writer', folders: [] },
    { id: 'designer', name: 'Designer', team: 'Visuals', agentType: 'designer', folders: [] },
    { id: 'reviewer', name: 'Reviewer', team: 'Ops', agentType: 'reviewer', folders: [] },
    ...CODEX_BOTS.map(id => ({ id: 'cx-' + id, name: id, team: 'Codex', source: 'codex', model: 'gpt-6.1-sol', folders: [`~/p/${id}`] })),
  ],
};
fs.writeFileSync(path.join(HQ, 'roster.json'), JSON.stringify(roster, null, 1));
fs.copyFileSync(path.join(__dirname, 'prices.json'), path.join(HQ, 'prices.json'));

let written = 0;
const appendEvent = (t, event, s, extra = {}) => {
  fs.appendFileSync(path.join(HQ, `events-${monthKey(t)}.jsonl`), JSON.stringify({ time: iso(t), event, session_id: s.id, cwd: s.cwd, bot: null, transcript_path: s.tx, ...extra }) + '\n');
  written++;
};
const appendLine = (file, obj) => { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); written++; };
const usage = () => ({ input_tokens: ri(5, 4000), output_tokens: ri(20, 1500), cache_read_input_tokens: ri(0, 60000), cache_creation_input_tokens: ri(0, 3000) });
const TOOLS = [['Edit', () => ({ file_path: `C:/p/src/file${ri(1, 40)}.js` })], ['Read', () => ({ file_path: `C:/p/src/mod${ri(1, 40)}.ts` })],
  ['Bash', () => ({ command: pick(['npm test', 'npm run build', 'git status', 'node cli.js test']) })], ['Grep', () => ({ pattern: pick(['status', 'tick', 'dispose']) })],
  ['WebSearch', () => ({ query: 'three.js instancing ' + ri(1, 99) })]];

// ---------- simulated sessions ----------
let nextId = 0;
function claudeSession(folder, t) {
  const id = `soak-${nextId++}`, cwd = path.join(HOME, 'p', folder), enc = cwd.replace(/[:\\/]/g, '-');
  const dir = path.join(PROJ, enc); fs.mkdirSync(dir, { recursive: true });
  return { kind: 'claude', id, cwd, tx: path.join(dir, id + '.jsonl'), dir, phase: 'new', pend: null, steps: 0, turnLen: ri(6, 22), msg: 0, sub: null, dies: t + ri(4, 12) * 60000 };
}
function claudeStep(s, t) {
  const A = (content, sameMsg) => appendLine(s.tx, { type: 'assistant', timestamp: iso(t), message: { id: sameMsg ? `${s.id}-m${s.msg}` : `${s.id}-m${++s.msg}`, model: 'claude-opus-5-5', content, usage: usage() } });
  if (s.phase === 'new') { appendEvent(t, 'SessionStart', s); s.phase = 'idle'; return; }
  if (s.phase === 'idle') {
    if (t > s.dies) { appendEvent(t, 'SessionEnd', s, { reason: 'other' }); s.phase = 'gone'; return; }
    appendEvent(t, 'UserPromptSubmit', s); appendLine(s.tx, { type: 'user', timestamp: iso(t), message: { role: 'user', content: 'task ' + ri(1, 999) } });
    s.phase = 'turn'; s.steps = 0; s.turnLen = ri(6, 22); return;
  }
  if (s.phase === 'perm') { appendLine(s.tx, { type: 'user', timestamp: iso(t), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: s.pend, content: 'ok' }] } }); s.pend = null; s.phase = 'turn'; return; }
  // turn
  if (s.sub && rnd() < .45) {   // subagent transcript line / stop
    const a = s.sub;
    if (++a.n > a.len) { appendEvent(t, 'SubagentStop', s, { agent_id: a.id, agent_type: a.type, agent_transcript_path: a.tx }); s.sub = null; return; }
    const [name, inp] = pick(TOOLS);
    appendLine(a.tx, { type: 'assistant', timestamp: iso(t), message: { id: `${a.id}-${a.n}`, model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: `${a.id}-t${a.n}`, name, input: inp() }], usage: usage() } });
    return;
  }
  if (s.pend) { appendLine(s.tx, { type: 'user', timestamp: iso(t), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: s.pend, content: 'ok' }] } }); s.pend = null; return; }
  if (++s.steps > s.turnLen && !s.sub) {
    const txt = 'Done: finished task step ' + ri(1, 999);
    A([{ type: 'text', text: txt }]); appendEvent(t, 'Stop', s, { summary: txt }); s.phase = 'idle';
    if (rnd() < .4) appendEvent(t + 1, 'Notification', s, { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    return;
  }
  const r = rnd();
  if (r < .5) {
    const [name, inp] = pick(TOOLS); s.pend = `${s.id}-t${s.msg}-${s.steps}`;
    A([{ type: 'tool_use', id: s.pend, name, input: inp() }], rnd() < .2);
    if (rnd() < .07) { appendEvent(t + 1, 'Notification', s, { notification_type: 'permission_prompt', message: `Claude needs your permission to use ${name}` }); s.phase = 'perm'; }
  } else if (r < .9) A([{ type: 'text', text: 'Working on part ' + ri(1, 99) + ' of the change, updating tests and docs.' }]);
  else if (r < .96 && !s.sub) {
    const aid = 'a' + (nextId++).toString(16), type = pick(SUB_TYPES), dir = path.join(s.dir, s.id, 'subagents'); fs.mkdirSync(dir, { recursive: true });
    s.sub = { id: aid, type, tx: path.join(dir, `agent-${aid}.jsonl`), n: 0, len: ri(3, 12) };
    appendEvent(t, 'SubagentStart', s, { agent_id: aid, agent_type: type });
  } else A([{ type: 'thinking', thinking: 'hmm' }]);
}
function codexThread(folder, t) {
  const id = `cxsoak-${nextId++}`, cwd = path.join(HOME, 'p', folder), [y, m, d] = dayDir(t);
  const dir = path.join(CODEX, y, m, d); fs.mkdirSync(dir, { recursive: true });
  return { kind: 'codex', id, cwd, file: path.join(dir, `rollout-${iso(t).slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`), phase: 'new', turns: ri(2, 4), steps: 0, turnLen: ri(5, 16), tot: { i: 0, c: 0, o: 0 }, call: 0 };
}
function codexStep(s, t) {
  const R = (type, payload) => appendLine(s.file, { timestamp: iso(t), type, payload });
  if (s.phase === 'new') { R('session_meta', { id: s.id, session_id: s.id, timestamp: iso(t), cwd: s.cwd }); R('turn_context', { cwd: s.cwd, model: 'gpt-6.1-sol' }); s.phase = 'idle'; return; }
  if (s.phase === 'idle') {
    if (s.turns-- <= 0) { s.phase = 'gone'; return; }   // Codex has no SessionEnd: the thread just stops
    R('event_msg', { type: 'task_started' }); R('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'task ' + ri(1, 99) }] });
    s.phase = 'turn'; s.steps = 0; s.turnLen = ri(5, 16); return;
  }
  if (s.pendCall) { R('response_item', { type: 'function_call_output', call_id: s.pendCall, output: 'ok' }); s.pendCall = null; return; }
  if (++s.steps > s.turnLen) { R('event_msg', { type: 'task_complete', last_agent_message: 'Codex finished task ' + ri(1, 999) }); s.phase = 'idle'; return; }
  const r = rnd();
  if (r < .45) { s.pendCall = `c${++s.call}`; R('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['npm', pick(['test', 'run', 'ci'])] }), call_id: s.pendCall }); }
  else if (r < .75) { s.tot.i += ri(500, 8000); s.tot.c += ri(0, 400); s.tot.o += ri(50, 900); R('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: s.tot.i, cached_input_tokens: Math.min(s.tot.c, s.tot.i), cache_write_input_tokens: 0, output_tokens: s.tot.o } } }); }
  else if (r < .97) R('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Patched module ' + ri(1, 50) }] });
  else R('event_msg', { type: 'exec_approval_request', call_id: 'x' + s.call, command: ['git', 'push'] });
}

// ---------- 8 days of history (finished sessions), so the server starts like a real install ----------
function seedHistory(now) {
  const t0 = Date.now();
  for (let day = 7; day >= 0; day--) {
    const d = new Date(now); d.setDate(d.getDate() - day); d.setHours(8, 0, 0, 0);
    const start = d.getTime(), end = day === 0 ? Math.min(now - 30 * 60000, start + 6 * 3600000) : start + 10 * 3600000;
    if (end <= start) continue;
    const n = day === 0 ? 20 : 30;
    for (let k = 0; k < n; k++) {
      let t = start + rnd() * (end - start - 40 * 60000);
      const s = claudeSession(pick(CLAUDE_BOTS), t); s.dies = t + ri(10, 30) * 60000;
      while (s.phase !== 'gone' && t < end) { claudeStep(s, t); t += ri(5, 40) * 1000; }
      if (s.phase !== 'gone') appendEvent(t, 'SessionEnd', s, { reason: 'other' });
    }
    for (let k = 0; k < 12; k++) {
      let t = start + rnd() * (end - start - 40 * 60000);
      const s = codexThread(pick(CODEX_BOTS), t);
      while (s.phase !== 'gone') { codexStep(s, t); t += ri(5, 40) * 1000; }
    }
  }
  return Date.now() - t0;
}

// ---------- server + page ----------
function get(p, timeout = 5000) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout, headers: { Host: `127.0.0.1:${PORT}` } }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); }); req.on('error', () => resolve(null));
  });
}

const COLS = ['minute', 'fps', 'p95_ms', 'frame_work_ms', 'js_heap_mb', 'dom_nodes', 'feed_nodes', 'team_nodes', 'geometries', 'textures', 'programs', 'draw_calls', 'quality', 'quality_changes', 'layout_rebuilds',
  'page_agents', 'page_bots', 'srv_ticks', 'srv_tick_avg_ms', 'srv_tick_max_ms', 'srv_read_max_ms', 'srv_build_max_ms', 'srv_diff_max_ms', 'srv_heap_mb', 'srv_rss_mb', 'srv_sessions', 'srv_subs', 'srv_finished', 'srv_array_items', 'srv_usage_records',
  'sse_patches', 'sse_avg_bytes', 'sse_max_bytes', 'lines_written'];

async function main() {
  const now0 = Date.now();
  console.log(`Soak: ${MINUTES} min, 15 agents, one event every ~${INTERVAL} ms, port ${PORT}${TAG ? ', tag ' + TAG : ''}`);
  console.log(`  temp home ${HOME}`);
  const seedMs = seedHistory(now0);
  console.log(`  seeded 8 days of history: ${written.toLocaleString('en-US')} lines in ${seedMs} ms`);
  const env = { ...process.env, USERPROFILE: HOME, HOME, AGENT_HQ_PORT: String(PORT), AGENT_HQ_NO_TOAST: '1', AGENT_HQ_DRYRUN_OPEN: '1' };
  const log = fs.openSync(path.join(HOME, 'server.log'), 'a');
  const srv = spawn(process.execPath, ['--expose-gc', path.join(__dirname, 'server.js')], { env, stdio: ['ignore', log, log], windowsHide: true });
  let h = null; for (let i = 0; i < 300 && !(h && h.ok); i++) { await sleep(200); h = await get('/api/health', 1000); }
  if (!h) { console.error('server did not start, see ' + path.join(HOME, 'server.log')); srv.kill(); process.exit(1); }
  const startup = { maxTickMs: h.maxTickMs, ticks: h.ticks };
  console.log(`  server up (pid ${h.pid}); startup ticks ${h.ticks}, slowest ${h.maxTickMs} ms`);

  const { launch, openPage } = require('./cdp');
  let b = null, p = null, gpu = 'none (--no-page)';
  if (!NOPAGE) {
  const W = 1920, H = 1080;
  b = await launch({ width: W, height: H, headless: !HEADFUL });
  p = await openPage(b, 'about:blank');
  await p.send('Page.enable');
  await p.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await p.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?soak=1` });
  for (let i = 0; i < 60; i++) { await sleep(500); try { if (await p.evaluate('!!(window.__hq && window.__hq.state && window.__soakTake)')) break; } catch (e) {} }
  gpu = await p.evaluate(`(() => { try { const gl = __hq.world.renderer.getContext(), e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; } catch (e) { return 'unknown'; } })()`).catch(() => 'unknown');
  console.log(`  page open (GPU: ${gpu})`);
  await p.evaluate('window.__soakTake()');   // reset counters: minute 1 starts now
  }

  // simulated day: keep ~11 Claude sessions + ~4 Codex threads live
  const live = [];
  let lastDrop = Date.now(), drops = 0, stepping = true;
  const top = () => {
    const t = Date.now();
    for (let i = live.length - 1; i >= 0; i--) if (live[i].phase === 'gone') live.splice(i, 1);
    const nC = live.filter(s => s.kind === 'claude').length, nX = live.filter(s => s.kind === 'codex').length;
    if (nC < 11) live.push(claudeSession(pick(CLAUDE_BOTS), t));
    if (nX < 4) live.push(codexThread(pick(CODEX_BOTS), t));
    if (t - lastDrop > 6 * 60000) {   // a drop-in folder that is not on the roster walks in
      lastDrop = t; drops++;
      live.push(drops % 3 === 0 ? codexThread('cx-side-' + drops, t) : claudeSession('side-project-' + drops, t));
    }
  };
  for (let i = 0; i < 15; i++) top();
  const step = () => {
    if (!stepping) return;
    try { top(); const s = pick(live); const t = Date.now(); (s.kind === 'claude' ? claudeStep : codexStep)(s, t); } catch (e) { console.error('driver', e.message); }
    setTimeout(step, INTERVAL * (0.5 + rnd()));
  };
  step();

  const stamp = (() => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`; })();
  const csv = path.join(OUT_DIR, `soak-${stamp}${TAG ? '-' + TAG : ''}.csv`);
  fs.writeFileSync(csv, COLS.join(',') + '\n');
  const rows = [];
  const t0 = Date.now();
  for (let m = 1; m <= MINUTES; m++) {
    await sleep(Math.max(0, t0 + m * 60000 - Date.now()));
    let pg = {};
    if (p) try { await p.send('HeapProfiler.collectGarbage'); pg = await p.evaluate('window.__soakTake()'); } catch (e) { console.error('page sample failed', e.message); }
    const sh = (await get('/api/health?gc=1')) || {};
    const lm = sh.lastMinute || { ticks: {}, patchBytes: {} }, en = sh.engine || {};
    const row = { minute: m, fps: pg.fps, p95_ms: pg.p95, frame_work_ms: pg.workMs, js_heap_mb: pg.heapMB, dom_nodes: pg.dom, feed_nodes: pg.feedNodes, team_nodes: pg.teamNodes, geometries: pg.geometries, textures: pg.textures, programs: pg.programs,
      draw_calls: pg.calls, quality: pg.quality, quality_changes: pg.qualityChanges, layout_rebuilds: pg.rebuilds, page_agents: pg.agents, page_bots: pg.bots,
      srv_ticks: lm.ticks.n, srv_tick_avg_ms: lm.ticks.avg, srv_tick_max_ms: lm.ticks.max, srv_read_max_ms: (lm.read || {}).max, srv_build_max_ms: (lm.build || {}).max, srv_diff_max_ms: (lm.diff || {}).max, srv_heap_mb: sh.heapMB, srv_rss_mb: sh.rssMB,
      srv_sessions: en.sessions, srv_subs: en.subs, srv_finished: en.finished, srv_array_items: en.arrayItems, srv_usage_records: en.usageRecords,
      sse_patches: lm.patchBytes.n, sse_avg_bytes: lm.patchBytes.avg, sse_max_bytes: lm.patchBytes.max, lines_written: written };
    rows.push(row);
    fs.appendFileSync(csv, COLS.map(k => row[k] ?? '').join(',') + '\n');
    console.log(`  min ${String(m).padStart(2)}  fps ${row.fps}  p95 ${row.p95_ms} ms  heap ${row.js_heap_mb} MB  dom ${row.dom_nodes}  geo/tex/prog ${row.geometries}/${row.textures}/${row.programs}  q${row.quality}`
      + `  | srv tick avg ${row.srv_tick_avg_ms} max ${row.srv_tick_max_ms} ms  heap ${row.srv_heap_mb} MB  rss ${row.srv_rss_mb} MB  sessions ${row.srv_sessions}  items ${row.srv_array_items}  sse ${row.sse_avg_bytes} B`);
  }
  stepping = false;
  if (p) { try { p.close(); } catch (e) {} b.close(); }
  try { srv.kill(); } catch (e) {}
  await sleep(500);
  if (!KEEP) setTimeout(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) {} }, 1500);

  // summary: minute 1 vs last minute
  const a = rows[0], z = rows[rows.length - 1];
  const fmt = v => v == null ? '—' : String(v);
  const lines = [['metric', 'minute 1', `minute ${z.minute}`, 'change']];
  const show = ['fps', 'p95_ms', 'frame_work_ms', 'js_heap_mb', 'dom_nodes', 'feed_nodes', 'team_nodes', 'geometries', 'textures', 'programs', 'draw_calls', 'quality', 'page_bots', 'srv_tick_avg_ms', 'srv_tick_max_ms',
    'srv_heap_mb', 'srv_rss_mb', 'srv_sessions', 'srv_subs', 'srv_finished', 'srv_array_items', 'srv_usage_records', 'sse_avg_bytes'];
  for (const k of show) {
    const d = typeof a[k] === 'number' && typeof z[k] === 'number' ? z[k] - a[k] : null;
    const pct = d != null && a[k] ? ` (${d >= 0 ? '+' : ''}${(100 * d / a[k]).toFixed(0)}%)` : '';
    lines.push([k, fmt(a[k]), fmt(z[k]), d == null ? '' : (d >= 0 ? '+' : '') + +d.toFixed(2) + pct]);
  }
  const maxTick = Math.max(...rows.map(r => r.srv_tick_max_ms || 0));
  const w = [0, 1, 2, 3].map(i => Math.max(...lines.map(l => l[i].length)));
  console.log('\n' + lines.map(l => l.map((c, i) => c.padEnd(w[i])).join('  ')).join('\n'));
  console.log(`\nslowest server tick during the run: ${maxTick} ms · startup: ${startup.ticks} ticks, slowest ${startup.maxTickMs} ms · ${written.toLocaleString('en-US')} lines written · GPU ${gpu}`);
  console.log(`CSV: ${csv}`);
  const t = (ok, s) => `${ok ? 'PASS' : 'FAIL'}  ${s}`;
  const within = (k, f) => a[k] != null && z[k] != null && f(a[k], z[k]);
  const checks = [
    t(within('fps', (x, y) => Math.abs(y - x) <= x * .05), 'page fps within 5%'),
    t(within('js_heap_mb', (x, y) => Math.abs(y - x) <= 15), 'page heap within ±15 MB'),
    t(['geometries', 'textures', 'programs', 'feed_nodes'].every(k => within(k, (x, y) => x === y)) && within('dom_nodes', (x, y) => y - z.team_nodes === x - a.team_nodes) && within('team_nodes', (x, y) => y / z.page_bots === x / a.page_bots), 'geometries, textures, programs constant; DOM constant (team list: same nodes per bot)'),
    t(rows.slice(1).every(r => (r.srv_tick_avg_ms || 0) < 15), 'server avg tick < 15 ms every minute'),
    t(rows.every(r => (r.srv_tick_max_ms || 0) <= 200), 'no server tick over 200 ms'),
  ];
  console.log(checks.join('\n'));
  return { rows, csv, startup, gpu };
}

module.exports = { main, seedHistory, HOME, claudeSession, claudeStep, codexThread, codexStep, CLAUDE_BOTS, CODEX_BOTS };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
