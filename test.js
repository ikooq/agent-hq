// agent-hq test: runs the engine, hook and server against a throwaway home
// directory with synthetic events + transcripts. Prints PASS/FAIL per check.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawnSync, spawn } = require('child_process');
const CODE = __dirname;
const { createEngine, monthKey, dayKey } = require('./core');

const results = [];
function check(name, ok, detail = '') { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  -> ' + detail : ''}`); }
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---------- temp home ----------
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-test-'));
const HQ = path.join(HOME, '.agent-hq');
fs.mkdirSync(HQ, { recursive: true });
fs.copyFileSync(path.join(CODE, 'prices.json'), path.join(HQ, 'prices.json'));
const roster = {
  teams: ['Research', 'Content', 'Visuals', 'Ops'], dropIn: { team: 'Ops' },
  bots: [
    { id: 'hq', name: 'HQ', team: 'Ops', model: 'claude-opus-5-5', folders: ['~'], match: 'exact' },
    { id: 'nexus', name: 'Nexus', team: 'Visuals', model: 'claude-opus-5-5', folders: ['~/proj/nexus'] },
    { id: 'locqa', name: 'LocQA', team: 'Research', model: 'claude-sonnet-5-5', folders: ['~/proj/locqa'] },
    { id: 'tutor', name: 'Tutor', team: 'Content', folders: ['~/proj/tutor'] },
    { id: 'scratch', name: 'Scratch', team: 'Content', folders: ['~/proj/scratch'] },
    { id: 'gone', name: 'Gone', team: 'Ops', folders: ['~/proj/gone'] },
    { id: 'researcher', name: 'Researcher', team: 'Research', agentType: 'researcher', folders: [] },
  ],
};
fs.writeFileSync(path.join(HQ, 'roster.json'), JSON.stringify(roster));
for (const p of ['proj/nexus', 'proj/locqa', 'proj/tutor', 'proj/scratch', 'proj/gone']) fs.mkdirSync(path.join(HOME, p), { recursive: true });
const TX = path.join(HOME, 'transcripts'); fs.mkdirSync(TX);

const NOW = Date.now(), iso = sec => new Date(NOW - sec * 1000).toISOString();
const cwd = p => path.join(HOME, p);
const txp = id => path.join(TX, id + '.jsonl');
const events = [];
const ev = (sec, event, sid, folder, extra = {}) => events.push({ time: iso(sec), event, session_id: sid, cwd: cwd(folder), transcript_path: txp(sid), ...extra });
const lines = {};
const L = (sid, obj) => (lines[sid] ||= []).push(JSON.stringify(obj));
const asst = (sid, sec, id, content, usage, model = 'claude-opus-5-5') => L(sid, { type: 'assistant', timestamp: iso(sec), message: { id, model, content, usage } });
const user = (sid, sec, content) => L(sid, { type: 'user', timestamp: iso(sec), message: { role: 'user', content } });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const toolRes = id => [{ type: 'tool_result', tool_use_id: id, content: 'ok' }];

// A working (LocQA) + token math
ev(120, 'SessionStart', 'loc', 'proj/locqa'); ev(60, 'UserPromptSubmit', 'loc', 'proj/locqa');
user('loc', 60, 'fix the tests');
asst('loc', 50, 'm1', [{ type: 'text', text: 'On it' }], { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000 }, 'claude-sonnet-5-5');
asst('loc', 50, 'm1', [toolUse('t1', 'Edit', { file_path: 'C:/x/server.js' })], { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 1000 }, 'claude-sonnet-5-5');
user('loc', 45, toolRes('t1'));
asst('loc', 5, 'm2', [{ type: 'text', text: 'Tests pass now.' }],
  { input_tokens: 3, output_tokens: 7, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 1000 } }, 'claude-sonnet-5-5');
L('loc', JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - 3 * 86400000).toISOString(), message: { id: 'old', model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 99999, output_tokens: 99999 } } }).slice(0));
L('loc', '{this is not json');
// B running a command (Tutor): tool_use 15 min ago with no result -> running, never stuck
ev(1300, 'SessionStart', 'tut', 'proj/tutor'); ev(1200, 'UserPromptSubmit', 'tut', 'proj/tutor');
user('tut', 1200, 'build it');
asst('tut', 900, 'b1', [toolUse('tb', 'Bash', { command: 'npm run build', description: 'Build' })], { input_tokens: 1, output_tokens: 1 });
// C waiting (Nexus #1): permission prompt after the last line
ev(200, 'SessionStart', 'nx1', 'proj/nexus'); ev(120, 'UserPromptSubmit', 'nx1', 'proj/nexus');
user('nx1', 120, 'clean up');
asst('nx1', 60, 'n1', [toolUse('tn', 'Bash', { command: 'rm -rf build' })], { input_tokens: 1, output_tokens: 1 });
ev(59, 'Notification', 'nx1', 'proj/nexus', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
// J second robot (Nexus #2): working
ev(100, 'SessionStart', 'nx2', 'proj/nexus'); ev(30, 'UserPromptSubmit', 'nx2', 'proj/nexus');
user('nx2', 30, 'style the header'); asst('nx2', 10, 'n2', [{ type: 'text', text: 'Styling' }], { input_tokens: 1, output_tokens: 2 });
// D waiting cleared by a newer transcript line (Scratch #1)
ev(200, 'SessionStart', 'sc1', 'proj/scratch'); ev(90, 'UserPromptSubmit', 'sc1', 'proj/scratch');
asst('sc1', 60, 's1', [toolUse('ts', 'Read', { file_path: 'C:/a/roster.json' })], { input_tokens: 1, output_tokens: 1 });
ev(55, 'Notification', 'sc1', 'proj/scratch', { notification_type: 'permission_prompt', message: 'perm' });
user('sc1', 40, toolRes('ts')); asst('sc1', 39, 's1b', [{ type: 'text', text: 'Read it' }], { input_tokens: 1, output_tokens: 1 });
// E waiting cleared by UserPromptSubmit (Scratch #2) — message-only permission (no type)
ev(400, 'SessionStart', 'sc2', 'proj/scratch'); ev(300, 'UserPromptSubmit', 'sc2', 'proj/scratch');
asst('sc2', 250, 's2', [{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 });
ev(240, 'Notification', 'sc2', 'proj/scratch', { message: 'Claude needs your permission to use Write' });
ev(20, 'UserPromptSubmit', 'sc2', 'proj/scratch'); user('sc2', 20, 'go on');
// F resting: Stop then idle notification (HQ); G stuck (drop-in folder)
ev(700, 'SessionStart', 'hq1', ''); ev(600, 'UserPromptSubmit', 'hq1', '');
asst('hq1', 560, 'h1', [{ type: 'text', text: 'All done, report saved.' }], { input_tokens: 1, output_tokens: 1 });
ev(550, 'Stop', 'hq1', '', { summary: 'All done, report saved.' });
ev(480, 'Notification', 'hq1', '', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
ev(1900, 'SessionStart', 'stk', 'side/thing'); ev(1800, 'UserPromptSubmit', 'stk', 'side/thing');
asst('stk', 720, 'k1', [{ type: 'text', text: 'Thinking hard' }], { input_tokens: 1, output_tokens: 1 });
// F2 idle notification without Stop (interrupted turn) -> resting, not waiting
ev(900, 'SessionStart', 'idl', 'proj/gone'); ev(800, 'UserPromptSubmit', 'idl', 'proj/gone');
asst('idl', 790, 'i1', [{ type: 'text', text: 'hm' }], { input_tokens: 1, output_tokens: 1 });
ev(700, 'Notification', 'idl', 'proj/gone', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
ev(650, 'SessionEnd', 'idl', 'proj/gone', { reason: 'other' });            // I off
// N missing transcript (session survives on events only)
events.push({ time: iso(30), event: 'SessionStart', session_id: 'nofile', cwd: cwd('proj/tutor'), transcript_path: path.join(TX, 'missing.jsonl') });
// O subagent (researcher) started by LocQA
ev(40, 'SubagentStart', 'loc', 'proj/locqa', { agent_id: 'abc123', agent_type: 'researcher' });
const subDir = path.join(TX, 'loc', 'subagents'); fs.mkdirSync(subDir, { recursive: true });
fs.writeFileSync(path.join(subDir, 'agent-abc123.jsonl'), [
  JSON.stringify({ type: 'assistant', timestamp: iso(20), message: { id: 'r1', model: 'claude-sonnet-5-5', content: [toolUse('tw', 'WebSearch', { query: 'three.js shadows' })], usage: { input_tokens: 100, output_tokens: 50 } } }),
].join('\n') + '\n');

for (const [sid, ls] of Object.entries(lines)) fs.writeFileSync(txp(sid), ls.join('\n') + '\n');
// L rotation: v1 legacy events.jsonl + a previous-month file
const prevMonth = (() => { const d = new Date(NOW); return monthKey(new Date(d.getFullYear(), d.getMonth() - 1, 15).getTime()); })();
const half = Math.floor(events.length / 2);
fs.writeFileSync(path.join(HQ, 'events.jsonl'), events.slice(0, half).map(e => JSON.stringify(e)).join('\n') + '\n{broken line\n');
fs.writeFileSync(path.join(HQ, `events-${monthKey(NOW)}.jsonl`), events.slice(half).map(e => JSON.stringify(e)).join('\n') + '\n');
fs.writeFileSync(path.join(HQ, `events-${prevMonth}.jsonl`), JSON.stringify({ time: new Date(NOW - 35 * 86400000).toISOString(), event: 'SessionStart', session_id: 'oldmonth', cwd: cwd('proj/gone') }) + '\n');

// ---------- engine checks ----------
const E = createEngine({ home: HOME, now: () => NOW });
const S = E.tick();
const bot = id => S.bots.find(b => b.id === id);
const robot = (id, i = 0) => (bot(id) || { robots: [] }).robots[i];

check('status: working (LocQA)', robot('locqa') && robot('locqa').status === 'working', JSON.stringify(robot('locqa') && robot('locqa').status));
const tr = robot('tutor');
check('status: running a command (Tutor, 15 min, not stuck)', tr && tr.status === 'running' && Math.abs(tr.runningSince - (NOW - 900000)) < 1000 && /Running Bash: npm run build/.test(tr.step), tr && tr.status + ' ' + tr.step);
check('status: waiting on permission prompt (Nexus)', robot('nexus', 0) && robot('nexus', 0).status === 'waiting' && S.waiting.some(w => w.label === 'Nexus' && /permission to use Bash/.test(w.message)));
const sc = bot('scratch').robots;
check('waiting clears on next transcript line', sc[0] && sc[0].status === 'working', sc[0] && sc[0].status);
check('waiting clears on UserPromptSubmit (message-only permission)', sc[1] && sc[1].status === 'working', sc[1] && sc[1].status);
check('status: resting after Stop + idle notification (HQ)', robot('hq') && robot('hq').status === 'resting' && !S.waiting.some(w => w.bot === 'HQ'));
const stk = S.bots.find(b => b.dropIn && /thing/.test(b.name));
check('status: stuck after 10 min without a line (drop-in)', stk && stk.robots[0] && stk.robots[0].status === 'stuck' && S.stuck.length === 1, stk && JSON.stringify(stk.robots.map(r => r.status)));
check('status: off after SessionEnd (desk empty)', bot('gone') && bot('gone').status === 'off' && bot('gone').robots.length === 0);
check('second robot in same folder is labelled "Nexus #2"', bot('nexus').robots.length === 2 && robot('nexus', 1).label === 'Nexus #2' && robot('nexus', 1).status === 'working');
check('header counts (running counts as working)', S.counts.working === 6 && S.counts.waiting === 1 && S.counts.stuck === 1 && S.counts.resting === 2 && S.counts.off >= 1, JSON.stringify(S.counts));

const tk = bot('locqa').tokens;
// m1 counted once with its largest usage (10 in / 40 out / 1000 cr), m2: 3 in / 7 out / 2000 cw5 / 1000 cw1; 'old' is from another day
const expIn = 13, expOut = 47, expCw = 3000, expCr = 1000;
const expCost = (13 * 2 + 47 * 10 + 2000 * 2.5 + 1000 * 4 + 1000 * 0.2) / 1e6;
check('tokens: input/output/cache kept separate, deduped by message id', tk.in === expIn && tk.out === expOut && tk.cw === expCw && tk.cr === expCr, JSON.stringify(tk));
check('tokens today = input + output (cache only in breakdown)', tk.total === expIn + expOut);
check('cost from prices.json (Sonnet 5.5, 5m vs 1h cache writes)', approx(tk.cost, expCost), `${tk.cost} vs ${expCost}`);
check('model chip follows the transcript (Sonnet 5.5)', bot('locqa').modelLabel === 'Sonnet 5.5');
check('totals = sum of bots', S.totals.total === S.bots.reduce((a, b) => a + b.tokens.total, 0) && approx(S.totals.cost, S.bots.reduce((a, b) => a + b.tokens.cost, 0)));
const res = bot('researcher');
check('subagent: helper robot next to the parent (LocQA)', robot('locqa').helpers.length === 1 && robot('locqa').helpers[0].type === 'researcher');
check('subagent: robot at its own desk + tokens count there', res.robots.length === 1 && res.robots[0].status === 'running' && res.tokens.in === 100 && res.tokens.out === 50, JSON.stringify(res.tokens));
check('last actions parsed ("Edit server.js")', robot('locqa').actions.some(a => a.text === 'Edit server.js'));
check('malformed lines skipped, missing transcript survives', E._internals.sessions.has('nofile') && robot('tutor', 1) && robot('tutor', 1).status === 'resting');
check('rotation: legacy events.jsonl migrated into events-YYYY-MM.jsonl', !fs.existsSync(path.join(HQ, 'events.jsonl')) && fs.existsSync(path.join(HQ, 'events.v1-migrated.jsonl')) && E._internals.sessions.has('hq1'));
check('rotation: previous month file is read', E._internals.sessions.has('oldmonth'));
check('finished today comes from Stop events', S.finished.some(f => f.bot === 'HQ' && /All done/.test(f.summary)));
const TL = E.timeline();
const tlRow = id => TL.rows.find(r => r.botId === id);
check('timeline: bars per bot (Tutor working, Nexus waiting)', tlRow('tutor').segments.some(s => s[2] === 'working') && tlRow('nexus').segments.some(s => s[2] === 'waiting') && tlRow('hq').segments.some(s => s[2] === 'resting'));

// subagent stop + transcript deletion robustness
fs.appendFileSync(path.join(HQ, `events-${monthKey(NOW)}.jsonl`), JSON.stringify({ time: iso(1), event: 'SubagentStop', session_id: 'loc', cwd: cwd('proj/locqa'), agent_id: 'abc123', agent_type: 'researcher', agent_transcript_path: path.join(subDir, 'agent-abc123.jsonl') }) + '\n');
fs.unlinkSync(txp('nx2'));
const S2 = E.tick();
check('subagent: helper disappears after SubagentStop', S2.bots.find(b => b.id === 'locqa').robots[0].helpers.length === 0 && S2.bots.find(b => b.id === 'researcher').robots.length === 0);
check('deleted transcript does not crash, data kept', S2.bots.find(b => b.id === 'nexus').robots.length === 2);

// stats survive rotation
E.persistStats(true);
const statFile = path.join(HQ, 'stats', dayKey(NOW) + '.json');
const old = new Date(NOW); old.setDate(old.getDate() - 3);
fs.writeFileSync(path.join(HQ, 'stats', dayKey(old.getTime()) + '.json'), JSON.stringify({ date: dayKey(old.getTime()), final: true, bots: { locqa: { name: 'LocQA', in: 5, out: 5, total: 10, cost: 1.5 } }, total: { total: 10, cost: 1.5 } }));
for (const f of fs.readdirSync(HQ)) if (/^events/.test(f)) fs.unlinkSync(path.join(HQ, f));
fs.rmSync(TX, { recursive: true, force: true });
const E2 = createEngine({ home: HOME, now: () => NOW });
const ST = E2.stats(7);
const todayAgg = ST.days[ST.days.length - 1];
check('stats: daily file written (stats/YYYY-MM-DD.json)', fs.existsSync(statFile));
check('stats: history survives deleted events + transcripts', todayAgg.bots.locqa && todayAgg.bots.locqa.total === expIn + expOut && ST.days.length === 7 && ST.days[3].bots.locqa && ST.days[3].bots.locqa.cost === 1.5);
check('stats: busiest bot today', ST.busiestToday && ST.busiestToday.botId === 'researcher', JSON.stringify(ST.busiestToday));

// ---------- Codex (read-only rollout logs) ----------
const { writeCodexSession } = require('./fixtures');
const CX = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-codex-'));
fs.mkdirSync(path.join(CX, '.agent-hq'), { recursive: true });
fs.copyFileSync(path.join(CODE, 'prices.json'), path.join(CX, '.agent-hq', 'prices.json'));
fs.writeFileSync(path.join(CX, '.agent-hq', 'roster.json'), JSON.stringify({ teams: ['Ops', 'Codex'], dropInCodex: { team: 'Codex' }, bots: [
  { id: 'cl', name: 'ClaudeHere', team: 'Ops', source: 'claude', folders: ['~/p/shared'] },
  { id: 'cw', name: 'CxWork', team: 'Codex', source: 'codex', folders: ['~/p/work'] },
  { id: 'cr', name: 'CxRun', team: 'Codex', source: 'codex', folders: ['~/p/run'] },
  { id: 'cs', name: 'CxRest', team: 'Codex', source: 'codex', folders: ['~/p/rest'] },
  { id: 'ca', name: 'CxAsk', team: 'Codex', source: 'codex', folders: ['~/p/ask'] },
  { id: 'co', name: 'CxOld', team: 'Codex', source: 'codex', folders: ['~/p/old'] },
  { id: 'csh', name: 'CxShared', team: 'Codex', source: 'codex', folders: ['~/p/shared'] }] }));
const cxNow = Date.now();
for (const [id, dir, state, at] of [['w', 'work', 'working', cxNow], ['r', 'run', 'running', cxNow], ['s', 'rest', 'resting', cxNow], ['a', 'ask', 'waiting', cxNow], ['o', 'old', 'resting', cxNow - 40 * 60000], ['sh', 'shared', 'working', cxNow], ['u', 'unlisted', 'working', cxNow]])
  writeCodexSession(CX, { id: 'cx-' + id, cwd: path.join(CX, 'p', dir), now: at, state });
const snapshot = dir => { const out = []; const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else { const st = fs.statSync(p); out.push(`${p}|${st.size}|${st.mtimeMs}`); } } }; walk(dir); return out.sort().join('\n'); };
const before = snapshot(path.join(CX, '.codex'));
const EC = createEngine({ home: CX, now: () => cxNow });
const SC = EC.tick(); EC.tick();
const cb = id => SC.bots.find(b => b.id === id), cst = id => (cb(id) && cb(id).robots[0] || {}).status || (cb(id) && cb(id).status);
check('codex: working / running a command / resting / waiting', cst('cw') === 'working' && cst('cr') === 'running' && cst('cs') === 'resting' && cst('ca') === 'waiting', ['cw', 'cr', 'cs', 'ca'].map(cst).join(','));
check('codex: idle thread (40 min, no SessionEnd) is off', cb('co') && cb('co').status === 'off' && cb('co').robots.length === 0);
check('codex: approval request shows the command', SC.waiting.some(w => w.botId === 'ca' && /git push/.test(w.message)));
const ct = cb('cw').tokens;   // totals 15000 in (8000 cached) / 500 out; repeated token_count lines must not double count
check('codex: tokens from token_count deltas (in excl. cache, cache read separate, no double count)', ct.in === 7000 && ct.out === 500 && ct.cr === 8000 && ct.total === 7500, JSON.stringify(ct));
check('codex: model chip "OpenAI · gpt-6.1-sol", unpriced', cb('cw').modelLabel === 'OpenAI · gpt-6.1-sol' && ct.unpriced === true && ct.cost === 0);
check('codex: matched by folder + source (same folder as a Claude bot stays Codex)', cb('csh').robots.length === 1 && cb('cl').robots.length === 0);
check('codex: unlisted folder becomes a Codex drop-in in the Codex lab', SC.bots.some(b => b.dropIn && b.source === 'codex' && b.team === 'Codex' && b.robots.length === 1));
check('codex: task_complete lands in "finished today"', SC.finished.some(f => f.botId === 'cs' && f.summary === 'hi'));
check('codex: last actions parsed ("Shell: npm test")', cb('cs').robots[0].actions.some(a => a.text === 'Shell: npm test'));
check('codex: ~/.codex is never written', snapshot(path.join(CX, '.codex')) === before);
fs.rmSync(CX, { recursive: true, force: true });

// ---------- office layout + walking paths (same ES modules the page uses) ----------
async function layoutChecks() {
  const { computeLayout } = await import('file:///' + path.join(CODE, 'web', 'layout.js').replace(/\\/g, '/'));
  const { NavGrid } = await import('file:///' + path.join(CODE, 'web', 'nav.js').replace(/\\/g, '/'));
  const teams = ['Research', 'Content', 'Visuals', 'Ops', 'Codex'];
  const bots = [['a', 'Research', 2], ['b', 'Research', 1], ['c', 'Content', 1], ['d', 'Content', 1], ['e', 'Content', 1], ['f', 'Visuals', 3], ['g', 'Visuals', 1], ['h', 'Ops', 1], ['i', 'Ops', 1], ...'jklmno'.split('').map(x => [x, 'Codex', 1])].map(([id, team, seats]) => ({ id, team, seats }));
  const L = computeLayout(teams, bots); const G = new NavGrid(L);
  const spots = [...L.desks.map(d => d.seat), ...L.queue, ...L.meeting.seats, ...L.lounge.sofaSeats, ...L.lounge.coffeeSpots, L.lounge.armSeat, ...L.lounge.stand, L.lead.reportSpot, L.boardSpot, L.inside];
  let unreachable = 0, clipped = 0, maxMs = 0;
  for (const s of spots) {
    const t0 = Date.now(); const p = G.path(L.spawn, s); maxMs = Math.max(maxMs, Date.now() - t0);
    if (!p) { unreachable++; continue; }
    // every segment of the walk, except stepping into / out of the chair at the ends, must stay on free cells
    for (let i = 0; i + 1 < p.length; i++) for (let k = 0; k <= 20; k++) {
      const x = p[i].x + (p[i + 1].x - p[i].x) * k / 20, z = p[i].z + (p[i + 1].z - p[i].z) * k / 20;
      if (Math.hypot(x - s.x, z - s.z) > 1.0 && Math.hypot(x - L.spawn.x, z - L.spawn.z) > .8 && !G.walkableAt(x, z)) { clipped++; if (!globalThis.__clip) globalThis.__clip = { x: +x.toFixed(2), z: +z.toFixed(2), spot: s, seg: [p[i], p[i + 1]], last: i + 2 === p.length }; }
    }
  }
  check(`walking: all ${spots.length} destinations reachable from the door (A* max ${maxMs} ms)`, unreachable === 0 && maxMs < 50, `unreachable ${unreachable}`);
  check('walking: paths never cross furniture or walls (except the last metre into a chair)', clipped === 0, `${clipped} samples in obstacles ${JSON.stringify(globalThis.__clip)}`);
  let dup = 0; for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) if (Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z) < .4) dup++;
  check('walking: no two destination spots share a place', dup === 0, `${dup} pairs`);
  const zonesOverlap = L.zones.some((a, i) => L.zones.some((b, j) => j > i && a.x0 < b.x1 - .01 && b.x0 < a.x1 - .01 && a.z0 < b.z1 - .01 && b.z0 < a.z1 - .01));
  check('layout: zones do not overlap', !zonesOverlap);
  const L2 = computeLayout(teams, [...bots, { id: 'newbie', team: 'Visuals', seats: 1 }]);
  const nd = L2.desks.find(d => d.botId === 'newbie'), vz = L2.zones.find(z => z.team === 'Visuals');
  check('layout: a new roster bot gets a desk in its team zone', nd && nd.desk.x > vz.x0 && nd.desk.x < vz.x1 && nd.desk.z > vz.z0 && nd.desk.z < vz.z1 && L2.desks.length === L.desks.length + 1);
  const G2 = new NavGrid(L2); check('layout: the new desk is reachable', !!G2.path(L2.spawn, nd.seat));
  const { placeFor } = await import('file:///' + path.join(CODE, 'web', 'behavior.js').replace(/\\/g, '/'));
  check('behaviour: a new session (SessionStart, no prompt yet) walks straight to its desk, not the lounge', placeFor({ status: 'resting', turn: null }) === 'desk');
  check('behaviour: after Stop (prompted, then finished) it rests in the lounge', placeFor({ status: 'resting', turn: { requested: 1, done: 2 } }) === 'lounge');
  check('behaviour: waiting -> kiosk queue, working/running/stuck -> desk, 2+ helpers -> meeting, off -> door',
    placeFor({ status: 'waiting', turn: { requested: 1 } }) === 'queue' && ['working', 'running', 'stuck'].every(s => placeFor({ status: s, turn: { requested: 1 } }) === 'desk')
    && placeFor({ status: 'working', inMeeting: true }) === 'meeting' && placeFor({ status: 'working', leaving: true }) === 'door');
}

// ---------- hook + server (real processes, temp home, test port) ----------
const PORT = 7791;
const env = { ...process.env, USERPROFILE: HOME, HOME, AGENT_HQ_PORT: String(PORT), AGENT_HQ_NO_TOAST: '1', AGENT_HQ_DRYRUN_OPEN: '1' };
const runHook = (input, extra = {}) => { const t0 = Date.now(); const r = spawnSync(process.execPath, [path.join(CODE, 'hook.js')], { input, env: { ...env, ...extra }, timeout: 5000 }); return { ms: Date.now() - t0, code: r.status }; };
const bad = runHook('not json at all');
check('hook: garbage input exits 0', bad.code === 0);
const h1 = runHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'hk', cwd: cwd('proj/nexus'), transcript_path: txp('hk') }), { AGENT_HQ_NO_AUTOSTART: '1' });
const monthFile = path.join(HQ, `events-${monthKey(Date.now())}.jsonl`);
const lastLine = fs.existsSync(monthFile) ? JSON.parse(fs.readFileSync(monthFile, 'utf8').trim().split('\n').pop()) : {};
check('hook: writes to the monthly file with bot name', h1.code === 0 && lastLine.session_id === 'hk' && lastLine.bot === 'Nexus');
const hs = runHook(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'boot', cwd: cwd('proj/locqa') }));
check(`hook: SessionStart with server down returns fast (${hs.ms} ms incl. node startup)`, hs.code === 0 && hs.ms < 1200);

function req(method, p, { headers = {}, body } = {}) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { Host: `127.0.0.1:${PORT}`, ...headers }, timeout: 3000 }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ code: res.statusCode, json: j }); });
    });
    r.on('error', () => resolve({ code: 0 })); r.on('timeout', () => { r.destroy(); resolve({ code: 0 }); });
    if (body) r.write(body); r.end();
  });
}
(async () => {
  try { await layoutChecks(); } catch (e) { check('layout/nav modules load in Node', false, e.message); }
  let health = null;
  for (let i = 0; i < 40 && !(health && health.json); i++) { await new Promise(r => setTimeout(r, 150)); health = await req('GET', '/api/health'); }
  check('autostart: SessionStart hook spawned the server', health && health.json && health.json.ok && path.resolve(health.json.hq) === path.resolve(HQ), JSON.stringify(health && health.json));
  const st = await req('GET', '/state');
  check('server: /state answers (v3)', st.code === 200 && st.json && st.json.version === 3);
  // Server-Sent Events: append a hook event and expect a pushed patch with just that bot
  const sse = await new Promise(resolve => {
    let buf = '', done = false, sent = false; const finish = v => { if (!done) { done = true; try { r.destroy(); } catch (e) {} resolve(v); } };
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/events', headers: { Host: `127.0.0.1:${PORT}` } }, res => {
      res.on('data', d => {
        buf += d;
        if (buf.includes('event: hello') && !sent) {
          sent = true;
          fs.appendFileSync(path.join(HQ, `events-${monthKey(Date.now())}.jsonl`), JSON.stringify({ time: new Date().toISOString(), event: 'UserPromptSubmit', session_id: 'sse-1', cwd: cwd('proj/nexus'), transcript_path: txp('sse-1') }) + '\n');
        }
        for (const m of buf.split('\n\n')) { const line = m.split('\n').find(l => l.startsWith('data: ')); if (!line || /"version":3/.test(line)) continue; try { const p = JSON.parse(line.slice(6)); if ((p.bots || []).some(b => b.id === 'nexus')) finish(p); } catch (e) {} }
      });
    });
    r.on('error', e => finish({ err: e.message })); setTimeout(() => finish({ timeout: true, got: buf.slice(0, 300) }), 9000);
  });
  check('events stream (SSE): pushes only the changed bot after a new hook event', sse && sse.bots && sse.bots.length <= 2 && sse.bots.some(b => b.id === 'nexus') && typeof sse.seq === 'number' && sse.base === sse.seq - 1, JSON.stringify(sse).slice(0, 400));
  const h2 = await req('GET', '/api/health');
  check('server: idle CPU and memory reported', h2.json && typeof h2.json.cpuPercentSinceStart === 'number' && h2.json.watchers >= 1, JSON.stringify(h2.json));
  const evil = await req('GET', '/state', { headers: { Host: 'evil.example' } });
  check('server: foreign Host header refused', evil.code === 403);
  const json = { 'Content-Type': 'application/json' };
  const o1 = await req('POST', '/api/open', { headers: { ...json, Origin: 'http://evil.example' }, body: '{"botId":"nexus"}' });
  check('open-folder: cross-origin POST refused', o1.code === 403);
  const o2 = await req('POST', '/api/open', { headers: { ...json, Origin: `http://127.0.0.1:${PORT}` }, body: '{"botId":"../../windows"}' });
  check('open-folder: unknown bot refused', o2.code === 404);
  const o3 = await req('POST', '/api/open', { headers: { ...json, Origin: `http://127.0.0.1:${PORT}` }, body: '{"botId":"nexus"}' });
  check('open-folder: roster folder allowed (dry run)', o3.code === 200 && o3.json && path.resolve(o3.json.opened) === path.resolve(cwd('proj/nexus')));
  const pidFile = path.join(HQ, `server-${PORT}.pid`);
  check('server: PID file written', fs.existsSync(pidFile) && +fs.readFileSync(pidFile, 'utf8') === health.json.pid);
  const stop = spawnSync(process.execPath, [path.join(CODE, 'cli.js'), 'stop'], { env, encoding: 'utf8', timeout: 10000 });
  const after = await req('GET', '/api/health');
  check('cli stop: kills the server and removes the PID file', after.code === 0 && !fs.existsSync(pidFile), stop.stdout + stop.stderr);

  const pass = results.filter(r => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed${pass === results.length ? '' : '  <-- FAILURES'}`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) {}
  process.exitCode = pass === results.length ? 0 : 1;
})();
