#!/usr/bin/env node
// Agent HQ daily report: ~/.agent-hq/reports/YYYY-MM-DD.html
// Built only from local files: the hook event log, Claude Code transcripts, Codex rollout logs (read-only)
// and prices.json. A fresh engine reads them in this process (the server starts it as a child, so a long
// read never blocks the live office). No network, no model calls.
//   node report.js [--date=YYYY-MM-DD] [--out=file.html] [--quiet] [--json]
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { createEngine, dayKey } = require('./core');

const DAY = 86400000;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Math.round(n || 0).toLocaleString('en-US');
const tok = n => { n = n || 0; return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)); };
const dur = s => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${m} min` : m ? `${m} min` : s ? `${s} s` : '—'; };
const hhmm = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const usd = t => t.unpriced && !t.cost ? 'n/a' : '$' + (t.cost || 0).toFixed(2) + (t.unpriced ? '+' : '');
const COL = { working: '#3fae7c', waiting: '#e39a2d', stuck: '#e0565f', resting: '#7d98df' };
const LBL = { working: 'Working', waiting: 'Waiting on me', stuck: 'Stuck', resting: 'Resting' };

const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !isNaN(new Date(d + 'T12:00').getTime());
const startOf = day => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

function buildReport(day, opts = {}) {
  const d0 = startOf(day), end = d0 + DAY - 1;
  const fixed = Math.min(end, Date.now());
  const E = createEngine({ home: opts.home, now: () => fixed });
  for (let i = 0; i < 1000; i++) { E.tick(); if (!E.backlog()) break; }
  E.scanCodex(); E.tick();
  const r = E.report(day);
  E.close();
  return r;
}

function renderHTML(r) {
  const span = DAY, pct = t => ((t - r.dayStart) / span * 100).toFixed(3);
  const T = r.totals, title = new Date(r.dayStart + 43200000).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const tiles = [['Active time', dur(T.activeSec), 'working + waiting + stuck'], ['Tasks finished', num(T.finished), ''], ['Files edited', num(T.files), 'distinct files'],
    ['Commands run', num(T.commands), ''], ['Tokens (in + out)', tok(T.tokens.total), `${usd(T.tokens)} est.`], ['Waited on me', `${num(T.waits)}×`, dur(T.waitSec)], ['Got stuck', `${num(T.stuck)}×`, '']];
  const rows = r.bots.map(b => `<tr><td class="b">${esc(b.name)}<small>${esc(b.team)}${b.source === 'codex' ? ' · Codex' : ''}</small></td>
    <td>${dur(b.activeSec)}</td><td>${num(b.finished)}</td><td>${num(b.files)}</td><td>${num(b.commands)}</td>
    <td>${num(b.tokens.in)}</td><td>${num(b.tokens.out)}</td><td>${num(b.tokens.cw)} / ${num(b.tokens.cr)}</td><td>${usd(b.tokens)}</td>
    <td>${b.waits ? `${b.waits}× · ${dur(b.waitSec)}` : '—'}</td><td>${b.stuck ? `${b.stuck}× · ${dur(b.stuckSec)}` : '—'}</td></tr>`).join('');
  const tl = r.bots.map(b => `<div class="tl-row"><div class="tl-lab">${esc(b.name)}</div><div class="tl-track">${b.segments.map(([a, z, st]) =>
    `<b title="${esc(b.name)} · ${LBL[st]} ${hhmm(a)}–${hhmm(z)} (${dur((z - a) / 1000)})" style="left:${pct(a)}%;width:calc(${((z - a) / span * 100).toFixed(3)}% + 1px);background:${COL[st]}"></b>`).join('')}</div></div>`).join('');
  const fin = r.finished.map(f => `<li><time>${hhmm(f.t)}</time><b>${esc(f.bot)}</b><span>${esc(f.summary || '—')}</span></li>`).join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent HQ report · ${esc(r.date)}</title>
<style>
:root { --ink: #3a3346; --ink2: #6b6377; --hair: #e7e1d8; --bg: #faf7f2; }
* { box-sizing: border-box; } body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 "Segoe UI", system-ui, sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 28px 24px 48px; }
h1 { font-size: 24px; margin: 0; } h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink2); margin: 30px 0 10px; }
.sub { color: var(--ink2); margin: 4px 0 18px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.tile { background: #fff; border: 1px solid var(--hair); border-radius: 12px; padding: 10px 12px; } .tile span { color: var(--ink2); font-size: 12px; display: block; } .tile b { font-size: 21px; } .tile em { color: var(--ink2); font-style: normal; font-size: 12px; display: block; }
table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--hair); border-radius: 12px; overflow: hidden; }
th, td { padding: 7px 10px; text-align: right; border-bottom: 1px solid var(--hair); white-space: nowrap; font-variant-numeric: tabular-nums; } th { background: #f3eee6; font-size: 12px; color: var(--ink2); font-weight: 600; }
td.b, th.b { text-align: left; } td.b small { display: block; color: var(--ink2); font-size: 11.5px; } tr:last-child td { border-bottom: 0; }
.tbl { overflow-x: auto; }
.legend span { margin-right: 14px; font-size: 12.5px; color: var(--ink2); } .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
.tl { background: #fff; border: 1px solid var(--hair); border-radius: 12px; padding: 10px 12px; }
.tl-row { display: flex; align-items: center; height: 24px; } .tl-lab { width: 130px; flex: none; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tl-track { position: relative; flex: 1; height: 14px; background: #f3eee6; border-radius: 4px; } .tl-track b { position: absolute; top: 0; height: 100%; border-radius: 2px; }
.ticks { position: relative; height: 16px; margin-left: 130px; font-size: 11px; color: var(--ink2); } .ticks span { position: absolute; transform: translateX(-50%); }
ol { list-style: none; padding: 0; margin: 0; background: #fff; border: 1px solid var(--hair); border-radius: 12px; }
ol li { display: grid; grid-template-columns: 52px 130px 1fr; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--hair); } ol li:last-child { border-bottom: 0; } ol time { color: var(--ink2); font-variant-numeric: tabular-nums; }
.empty { color: var(--ink2); padding: 12px; background: #fff; border: 1px solid var(--hair); border-radius: 12px; }
footer { margin-top: 28px; color: var(--ink2); font-size: 12px; }
</style></head><body><main>
<h1>Agent HQ · ${esc(title)}</h1>
<p class="sub">${r.partial ? `So far today (until ${hhmm(r.until)})` : 'Whole day'} · generated ${esc(new Date(r.generated).toLocaleString('en-GB'))} · tokens = input + output · $ are estimates from prices.json</p>
<div class="tiles">${tiles.map(([a, b, c]) => `<div class="tile"><span>${a}</span><b>${b}</b>${c ? `<em>${c}</em>` : ''}</div>`).join('')}</div>
<h2>Per bot</h2>
${r.bots.length ? `<div class="tbl"><table><thead><tr><th class="b">Bot</th><th>Active</th><th>Tasks done</th><th>Files edited</th><th>Commands</th><th>Input</th><th>Output</th><th>Cache write / read</th><th>Cost</th><th>Waited on me</th><th>Stuck</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No agent activity on this day.</div>'}
<h2>Timeline</h2>
<div class="legend">${Object.keys(COL).map(k => `<span><i style="background:${COL[k]}"></i>${LBL[k]}</span>`).join('')}</div>
<div class="tl"><div class="ticks">${[0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => `<span style="left:${h / 24 * 100}%">${String(h).padStart(2, '0')}:00</span>`).join('')}</div>${tl || '<div class="empty">Nothing on the timeline.</div>'}</div>
<h2>Finished tasks</h2>
${fin ? `<ol>${fin}</ol>` : '<div class="empty">No finished tasks.</div>'}
<footer>Built on this computer from ~/.agent-hq/events-*.jsonl, Claude Code transcripts and Codex logs (read-only). Nothing was sent anywhere.</footer>
</main></body></html>
`;
}

function writeReport(day, opts = {}) {
  const home = opts.home || os.homedir();
  const r = buildReport(day, { home });
  const out = opts.out || path.join(home, '.agent-hq', 'reports', `${day}.html`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + '.tmp' + process.pid;
  fs.writeFileSync(tmp, renderHTML(r)); fs.renameSync(tmp, out);
  return { report: r, file: out };
}

function main(argv = process.argv.slice(2)) {
  const arg = k => { const a = argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
  const day = arg('date') || dayKey(Date.now());
  if (!validDate(day)) { console.error('use --date=YYYY-MM-DD'); process.exitCode = 2; return; }
  const t0 = Date.now();
  const { report: r, file } = writeReport(day, { out: arg('out') });
  if (argv.includes('--json')) { console.log(JSON.stringify(r)); return; }
  if (argv.includes('--quiet')) return;
  const T = r.totals;
  console.log(`Agent HQ report ${day}${r.partial ? ' (so far)' : ''}: ${file}  (${Date.now() - t0} ms)`);
  console.log(`  active ${dur(T.activeSec)} · ${T.finished} tasks finished · ${T.files} files edited · ${T.commands} commands · ${tok(T.tokens.total)} tokens (${usd(T.tokens)}) · waited on you ${T.waits}× (${dur(T.waitSec)}) · stuck ${T.stuck}×`);
  for (const b of r.bots) console.log(`  ${b.name.padEnd(20)} active ${dur(b.activeSec).padEnd(12)} done ${String(b.finished).padStart(3)}  files ${String(b.files).padStart(3)}  cmds ${String(b.commands).padStart(4)}  ${tok(b.tokens.total).padStart(7)} tok  ${usd(b.tokens)}`);
}

module.exports = { buildReport, renderHTML, writeReport, validDate, main };
if (require.main === module) main();
