// Agent HQ v3 — wiring: data (SSE + /state), layout, render loop, idle cap, auto quality, bench mode.
import * as THREE from 'three';
import { Perf } from '/web/perf.js';
import { World, botColor } from '/web/world.js';
import { Actors } from '/web/actors.js';
import { computeLayout, layoutKey } from '/web/layout.js';
import { NavGrid } from '/web/nav.js';
import { UI } from '/web/ui.js';
import { createDemo } from '/web/demo.js';
import { stressState, stressToggle } from '/web/stress.js';
import { Recorder } from '/web/recorder.js';

const params = new URLSearchParams(location.search);
const BENCH = params.has('bench');
const SOAK = params.has('soak');
const DEMO = params.has('demo');          // ?demo=1: scripted 90 s day with fake agents (no real data)          // `agent-hq soak`: render every frame (like bench) but with live server data
const perf = new Perf();
const world = new World(document.getElementById('scene'), { perf, bench: BENCH, onPick: ndc => { const a = actors.pick(ndc); if (a && a.r) select(a.r.key, a.botId); else if (a && a.kind === 'helper' && a.parent) select(a.parent.r.key, a.parent.botId); } });
const actors = new Actors(world);
const colorCss = b => '#' + botColor(b, 0).getHexString();
const ui = new UI({ world, actors, bench: BENCH || DEMO, demo: DEMO, botColorCss: colorCss, onSelect: (key, botId, close) => close ? deselect() : select(key, botId), onHome: () => { deselect(); world.home(); } });
if (params.has('tod')) world.setHourMode(params.get('tod'));
let hoverAt = 0;
world.renderer.domElement.addEventListener('pointermove', e => { if (e.buttons || performance.now() - hoverAt < 80) return; hoverAt = performance.now(); const a = actors.pick(world.ndc(e)); const k = a && a.kind !== 'lead' ? (a.kind === 'helper' && a.parent ? a.parent.key : a.key) : null; if (k !== actors.hovered) { actors.hovered = k; world.lastMove = performance.now(); } world.renderer.domElement.style.cursor = k ? 'pointer' : ''; });
const recorder = new Recorder({ world, getState: () => state, onChange: on => ui.paintRecord(on, recorder) });
ui.recorder = recorder;
window.__hq = { world, actors, ui, recorder, get state() { return state; }, apply: (s, prev) => { const p = state; state = s; apply(s, prev || p); } };

let state = null, layoutSig = '';
const MOBILE = params.has('m') || matchMedia('(max-width: 760px)').matches;
if (MOBILE) { document.documentElement.classList.add('mobile'); document.body.classList.add('mobile'); world.setQualityMode('low'); world.resize(); }
function insets() {
  if (document.body.classList.contains('mobile')) { world.setInsets({ left: 6, right: 6, top: 6, bottom: 6 }); return; }
  const right = document.getElementById('side').getBoundingClientRect();
  world.setInsets({ left: 16, right: innerWidth - right.left + 8, top: document.querySelector('header').getBoundingClientRect().bottom + 6, bottom: innerHeight - document.querySelector('footer').getBoundingClientRect().top + 6 });
}
addEventListener('resize', insets); insets();

function apply(s, prev) {
  const teams = [...s.teams]; for (const b of s.bots) if (!teams.includes(b.team)) teams.push(b.team);
  const bots = s.bots.map(b => ({ id: b.id, team: b.team, seats: Math.max(1, b.robots.filter(r => r.kind !== 'subagent' || true).length) }));
  const sig = layoutKey(teams, bots);
  if (sig !== layoutSig) {
    layoutSig = sig;
    const t0 = performance.now();
    const L = computeLayout(teams, bots);
    world.build(L);
    actors.setLayout(L, new NavGrid(L));
    const c = new THREE.Color();
    L.desks.forEach((d, i) => { const b = s.bots.find(x => x.id === d.botId); world.rugs.setColorAt(i, b ? c.copy(botColor(b, d.index)).lerp(new THREE.Color(0xffffff), .25) : c.set(0xdddddd)); });
    if (world.rugs.instanceColor) world.rugs.instanceColor.needsUpdate = true;   // null when there are no desks yet (empty roster)
    perf.lastBuildMs = performance.now() - t0; soak.rebuilds++;
  }
  actors.sync(s);
  ui.update(s, prev);
}
function select(key, botId) { ui.select(key, botId); const a = key && actors.agentByRobotKey(key); actors.selected = a ? a.key : null; actors.selectedBot = botId || null; world.follow = a || null; }
function deselect() { ui.closeCard(); actors.selected = null; actors.selectedBot = null; world.follow = null; }
addEventListener('keydown', e => { if (e.key === 'Escape') { if (ui.modal.classList.contains('show')) ui.closeInsights(); else if (ui.cardOpen) deselect(); else world.home(); } });

// ---------- data: first load via /state, then Server-Sent Events with only the changes ----------
const conn = document.getElementById('conn');
// one /state request at a time: a reconnect or a burst of out-of-order patches must not stack reloads
let loading = null;
function loadState() {
  if (loading) return loading;
  loading = (async () => {
    const r = await fetch('/state', { cache: 'no-store' }); const s = await r.json();
    const prev = state; state = s; apply(s, prev);
  })().finally(() => { loading = null; });
  return loading;
}
function mergePatch(p) {
  if (!state || p.base !== state.seq) return false;           // missed something: resync
  const byId = new Map(state.bots.map(b => [b.id, b]));
  for (const b of p.bots || []) byId.set(b.id, b);
  for (const id of p.removed || []) byId.delete(id);
  const next = { ...state, bots: [...byId.values()], seq: p.seq, now: p.now };
  for (const k of ['teams', 'counts', 'waiting', 'stuck', 'finished', 'totals', 'feed', 'stuckAfterMin', 'today', 'approvals', 'approvalsOn']) if (k in p) next[k] = p[k];
  const prev = state; state = next; apply(next, prev); return true;
}
function connect() {
  const es = new EventSource('/events');
  es.addEventListener('hello', () => { loadState().catch(() => {}); conn.textContent = 'live'; conn.className = ''; });
  es.onmessage = ev => {
    const t0 = performance.now();
    try { const p = JSON.parse(ev.data); if (!mergePatch(p)) loadState().catch(() => {}); } catch (e) { console.warn(e); }
    perf.lastPatchMs = performance.now() - t0;
    conn.textContent = 'live · ' + new Date().toLocaleTimeString('en-GB', { hour12: false }); conn.className = '';
  };
  es.onerror = () => { conn.textContent = 'reconnecting…'; conn.className = 'bad'; };
}

// ---------- bench: 15 fake agents walking, typing and changing status for 60 s ----------
function benchState() {
  const teams = ['Research', 'Content', 'Visuals', 'Ops', 'Codex'];
  const names = [['LocQA', 'Research'], ['Researcher', 'Research'], ['Scout', 'Research'], ['Tutor', 'Content'], ['Scratch', 'Content'], ['Writer', 'Content'], ['Nexus', 'Visuals'], ['Designer', 'Visuals'], ['Pixel', 'Visuals'],
    ['HQ', 'Ops'], ['Reviewer', 'Ops'], ['Deploy', 'Ops'], ['Moodle', 'Codex'], ['Hackathon', 'Codex'], ['Codex Chats', 'Codex']];
  const steps = ['Edit server.js', 'Bash: npm run build', 'Read roster.json', 'Grep "status"', 'Writing: updating the tests', 'WebSearch "three.js instancing"'];
  const now = Date.now();
  const bots = names.map(([name, team], i) => ({ id: 'b' + i, name, team, source: team === 'Codex' ? 'codex' : 'claude', job: 'Bench agent', model: team === 'Codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5',
    modelLabel: team === 'Codex' ? 'OpenAI · gpt-6.1-sol' : 'Opus 5.5', status: 'working', canOpen: false, lastLine: now, tokens: { in: 1000 * i, out: 400 * i, cw: 0, cr: 0, total: 1400 * i, cost: .1 * i },
    robots: [{ key: 'session:b' + i, id: 'b' + i, kind: 'session', source: 'claude', label: name, status: 'working', statusSince: now, step: steps[i % steps.length], start: now - 600000, lastLine: now, model: 'claude-opus-5-5',
      modelLabel: team === 'Codex' ? 'OpenAI · gpt-6.1-sol' : 'Opus 5.5', tokens: { in: 1000, out: 400, cw: 0, cr: 0, total: 1400, cost: .1 }, helpers: [], actions: [], turn: { requested: now - 60000, working: now - 50000, approval: null, done: null } }] }));
  return { version: 3, seq: 0, now, teams, bots, counts: { working: 15, waiting: 0, stuck: 0, resting: 0, off: 0 }, waiting: [], stuck: [], finished: [], totals: { in: 0, out: 0, cw: 0, cr: 0, total: 0, cost: 0 }, feed: [] };
}
function benchStep(s, k) {
  const ST = ['working', 'running', 'working', 'waiting', 'resting', 'stuck', 'working'];
  const next = structuredClone(s); next.now = Date.now();
  for (const b of next.bots) { const r = b.robots[0]; if (Math.random() < .3) {
    const st = ST[Math.floor(Math.random() * ST.length)];
    if (r.status !== 'resting' && st === 'resting') next.finished.unshift({ time: Date.now(), bot: b.name, botId: b.id, summary: 'Bench task done', session: r.id, sessionId: r.id });
    r.status = st; b.status = st; r.statusSince = Date.now(); r.runningSince = st === 'running' ? Date.now() : null; r.step = st === 'running' ? 'Running Bash: npm test' : `Step ${k}: Edit file${k % 9}.js`;
    r.helpers = st === 'working' && Math.random() < .25 ? [{ id: b.id + 'h1' + k, type: 'researcher', status: 'working', step: 'WebSearch' }, { id: b.id + 'h2' + k, type: 'reviewer', status: 'running', step: 'Bash' }].slice(0, Math.random() < .5 ? 1 : 2) : [];
    b.tokens.total += 500; r.tokens.total += 500; r.lastLine = Date.now(); } }
  next.finished = next.finished.slice(0, 40);
  const c = { working: 0, waiting: 0, stuck: 0, resting: 0, off: 0 };
  for (const b of next.bots) { const st = b.robots[0].status; c[st === 'running' ? 'working' : st]++; }
  next.counts = c; next.waiting = next.bots.filter(b => b.robots[0].status === 'waiting').map(b => ({ bot: b.name, botId: b.id, robot: b.robots[0].key, label: b.name, message: 'Bench approval', since: b.robots[0].statusSince }));
  next.feed = [{ t: Date.now(), botId: 'b0', bot: 'Bench', kind: 'action', text: 'step ' + k }, ...s.feed].slice(0, 40);
  return next;
}
function runBench() {
  const DURATION = +(params.get('seconds') || 60) * 1000;
  const GPU = gpuName();
  const box = document.createElement('pre'); box.id = 'benchbox'; document.body.appendChild(box);
  state = benchState(); apply(state, null);
  const t0 = performance.now(); let k = 0; const frames = []; let lastF = 0, maxCalls = 0, maxTris = 0;
  const heap = () => performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
  const res = { heapStart: null, heapEnd: null };
  perf.longTasks = [];
  const patchTimes = [];
  const patchAt = [];
  const iv = setInterval(() => { const a = performance.now(); patchAt.push(a); const prev = state; state = benchStep(state, ++k); apply(state, prev); patchTimes.push(performance.now() - a); }, 2000);
  function onFrame(now) {
    if (lastF) frames.push([now - t0, now - lastF]); lastF = now;
    maxCalls = Math.max(maxCalls, world.renderer.info.render.calls); maxTris = Math.max(maxTris, world.renderer.info.render.triangles);
    if (!res.heapStart && now - t0 > 5000) res.heapStart = heap();
    const el = now - t0; box.textContent = `BENCH ${Math.min(100, el / DURATION * 100).toFixed(0)}%  fps ${perf.stats().fps.toFixed(1)}  p95 ${perf.stats().p95.toFixed(1)} ms  draws ${world.renderer.info.render.calls}`;
    if (el >= DURATION) { clearInterval(iv); finish(); return false; }
    return true;
  }
  const win = (a, b) => { const xs = frames.filter(f => f[0] >= a && f[0] < b).map(f => f[1]).sort((x, y) => x - y); if (!xs.length) return null; const avg = xs.reduce((s, v) => s + v, 0) / xs.length; return { fps: +(1000 / avg).toFixed(1), avgMs: +avg.toFixed(2), p95Ms: +xs[Math.floor(xs.length * .95)].toFixed(2), frames: xs.length }; };
  function finish() {
    res.heapEnd = heap();
    const lt = perf.longTasks.filter(t => t.t >= t0 + 5000), warm = perf.longTasks.filter(t => t.t < t0 + 5000);
    Object.assign(res, { done: true, seconds: DURATION / 1000, agents: 15, start: win(5000, 15000), end: win(DURATION - 10000, DURATION), all: win(3000, DURATION),
      maxDrawCalls: maxCalls, maxTriangles: maxTris, textures: world.renderer.info.memory.textures, geometries: world.renderer.info.memory.geometries,
      workP95Ms: +(workTimes.slice(200).sort((a, b) => a - b)[Math.floor(Math.max(0, workTimes.length - 200) * .95)] || 0).toFixed(2), workAvgMs: +(workTimes.slice(200).reduce((a, b) => a + b, 0) / Math.max(1, workTimes.length - 200)).toFixed(2), paced: params.has('paced'),
      longTasksDuringRefresh: lt.filter(x => patchAt.some(p => p >= x.t - 2 && p <= x.t + x.ms)).length,
      warmupLongTasks: warm.length, warmupMaxMs: +warm.reduce((m, t) => Math.max(m, t.ms), 0).toFixed(0),
      longTasks: lt.length, maxLongTaskMs: +lt.reduce((m, t) => Math.max(m, t.ms), 0).toFixed(0), maxPatchMs: +Math.max(0, ...patchTimes).toFixed(1), avgPatchMs: +(patchTimes.reduce((a, b) => a + b, 0) / Math.max(1, patchTimes.length)).toFixed(2),
      pixelRatio: world.renderer.getPixelRatio(), quality: world.quality.mode + ':' + world.qualityLevel, gpu: GPU, viewport: `${innerWidth}x${innerHeight}` });
    window.__bench = res;
    box.textContent = 'BENCH DONE\n' + JSON.stringify(res, null, 1);
  }
  return onFrame;
}
function gpuName() { try { const gl = world.renderer.getContext(); const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; } catch (e) { return 'unknown'; } }

// ---------- render loop ----------
const workTimes = [];
// soak sampler: frame stats since the last call (`agent-hq soak` reads this once a minute)
const soak = { dts: [], work: 0, rebuilds: 0, lastF: 0, q: null, qChanges: 0 };
window.__soakTake = () => {
  const xs = soak.dts.filter(x => x > 0).sort((a, b) => a - b), n = xs.length, sum = xs.reduce((a, b) => a + b, 0), r = world.renderer.info;
  const out = { frames: n, fps: n ? +(1000 * n / sum).toFixed(1) : 0, p95: n ? +xs[Math.floor(n * .95)].toFixed(2) : 0, workMs: n ? +(soak.work / n).toFixed(2) : 0,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null, dom: document.getElementsByTagName('*').length, feedNodes: document.getElementById('feed').getElementsByTagName('*').length, teamNodes: document.getElementById('team').getElementsByTagName('*').length,
    geometries: r.memory.geometries, textures: r.memory.textures, programs: r.programs ? r.programs.length : 0, calls: r.render.calls,
    quality: world.qualityLevel, qualityChanges: soak.qChanges, agents: actors.agents.size, bots: state ? state.bots.length : 0, desks: world.L ? world.L.desks.length : 0, rebuilds: soak.rebuilds };
  soak.dts = []; soak.work = 0; soak.rebuilds = 0; soak.qChanges = 0; soak.lastF = 0; return out;
};
let last = performance.now(), lastRender = 0, qualityAt = 0, gcAt = 0, benchFrame = null;
const clock = { t: 0 };
function loop(now) {
  const cbStart = performance.now();
  if (document.hidden) { perf.idle(); return; }                 // paused while the tab is hidden
  requestAnimationFrame(loop);
  const dt = Math.max(0, Math.min(.05, (now - last) / 1000)); last = now; clock.t += dt;
  const walking = actors.update(dt, clock.t, now);
  if (world.follow) {
    const a = world.follow; if (!actors.agents.has(a.key)) world.follow = null;
    else { const t = world.controls.target, dx = (a.pos.x - t.x) * Math.min(1, dt * 4), dz = (a.pos.z - t.z) * Math.min(1, dt * 4); t.x += dx; t.z += dz; world.camera.position.x += dx; world.camera.position.z += dz; if (Math.abs(dx) + Math.abs(dz) > .001) world.lastMove = now; }
  }
  world.controls.update(); world.clampTarget();
  const active = BENCH || SOAK || recorder.active || walking || now - world.lastMove < 400;
  if (!active && now - lastRender < 31) return;                  // idle: ~30 fps
  if (BENCH && params.has('paced') && now - lastRender < 16.2) return;   // optional 60 Hz pacing
  if (!active) perf.idle();
  lastRender = now;
  actors.render(clock.t, now);
  if (world.needsCompile) { world.needsCompile = false; const t0 = performance.now(); world.renderer.compileAsync(world.scene, world.camera).then(() => { perf.compileMs = performance.now() - t0; }).catch(() => {}); }
  world.renderer.render(world.scene, world.camera);
  if (recorder.compG) recorder.frame();
  perf.frame(now, world.renderer);
  perf.work = performance.now() - cbStart; if (benchFrame) workTimes.push(perf.work);
  if (SOAK) { soak.dts.push(now - (soak.lastF || now)); soak.lastF = now; soak.work += perf.work; if (world.qualityLevel !== soak.q) { if (soak.q != null) soak.qChanges++; soak.q = world.qualityLevel; } }
  if (now - qualityAt > 250) { qualityAt = now; world.autoQuality(perf.stats().fps, active, now); if ((world.frame = (world.frame || 0) + 1) % 4 === 0) world.updateSky(false); }
  if (now - gcAt > 5000) { gcAt = now; actors.gcSlots(); }
  if (benchFrame && !benchFrame(now)) benchFrame = null;
  ui.placeKiosk(now);
}
perf.extra = () => `\nquality ${world.quality.mode}:${world.qualityLevel}  pr ${world.renderer.getPixelRatio()}\natlas uploads ${Object.values(world.atlases).reduce((a, x) => a + x.uploads, 0)}\nlast patch ${perf.lastPatchMs ? perf.lastPatchMs.toFixed(1) : '-'} ms  build ${perf.lastBuildMs ? perf.lastBuildMs.toFixed(0) : '-'} ms`;
document.addEventListener('visibilitychange', () => { if (!document.hidden) { last = performance.now(); requestAnimationFrame(loop); } });
let demo = null;
if (BENCH) { benchFrame = runBench(); document.body.classList.add('bench'); }
else if (DEMO) { document.body.classList.add('demo'); demo = createDemo({ apply: (s, prev) => { state = s; apply(s, prev); }, world, ui }); ui.demo = demo; conn.textContent = 'demo · fake agents'; demo.start(); }
else if (params.has('data')) { const s = stressState(params.get('data')); state = s; apply(s, null); conn.textContent = 'stress data · ' + params.get('data'); stressToggle(params.get('data')); }   // dev only: worst-case fixtures
else if (params.has('nolive')) loadState(); else connect();
if (DEMO && params.has('stress')) stressToggle('demo');
requestAnimationFrame(loop);
