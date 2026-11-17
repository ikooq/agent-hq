// Agent HQ stress data (dev only): ?data=worst | empty | one | huge, with a toggle at the bottom.
// Same state shape the server sends; every value is one real sessions produce (names, paths, prompts
// from this machine's logs), not random junk. It is a regression fixture for the panels and tags.
const TEAMS = ['Research', 'Content', 'Visuals', 'Ops', 'Codex'];
const LONG_CMD = "Bash: & 'C:\\Users\\alex\\AppData\\Roaming\\npm\\codex.cmd' exec --sandbox read-only --cd 'C:\\Users\\alex\\Documents\\Projects\\english-practice\\habit-tracker' \"summarize the last three commits and list every file that changed\"";
const ROWS = [
  // name, team, source, modelLabel, status, step, task
  ['Codex: introduction_claudecode', 'Codex', 'codex', 'OpenAI · codex-auto-review', 'running', LONG_CMD, 'проверь че по чем все сделано или нет'],
  ['Drop-in: Hackathon_2026-final-submission', 'Ops', 'claude', 'claude-fable-5-1-20261101-preview', 'waiting', 'Wants to use mcp__plugin_claude-for-financial-advisors_google-drive__download_file_content', 'Давай улучшить вот этот проект и визуал и все сделаем получше чтобы все было соска'],
  ['Q', 'Research', 'claude', 'Haiku 5.5', 'working', 'Read C:\\Users\\alex\\Documents\\Projects\\Hackathon_2026\\app-localization-qa\\data\\terms-glossary-v3-final-FINAL.json', 'Fix login bug'],
  ['Қазақша локализация QA', 'Research', 'claude', 'Sonnet 5.5', 'stuck', 'Writing: Барлық 1 284 жолды тексердім, 37 қате таптым; енді глоссарийді жаңартамын', 'Тексер: аударма сапасы'],
  ['🚀 Launch', 'Content', 'claude', 'Opus 5.5', 'working', 'WebSearch "three.js InstancedMesh per-instance color with onBeforeCompile shader chunks r160"', '🎬 Make the launch video'],
  ['Tutor·Codex', 'Codex', 'codex', 'OpenAI · gpt-6.1-sol', 'resting', 'Done: <b>Both</b> forms created & checked — **all** questions answered', null],
  ['Nexus', 'Visuals', 'claude', 'Opus 5.5', 'working', 'Edit web/world.js', 'Сделай, чтобы роботы двигались живее и были видны даже в маленьком окне браузера'],
  ['Designer', 'Visuals', 'claude', 'Opus 5.5', 'off', 'No session yet', null],
];

const now = () => Date.now();
const tok = (i, big) => big ? { in: 1234567890, out: 98765432, cw: 4567890, cr: 987654321, total: 1333333322, cost: 12345.67 } : { in: 1200 * i, out: 300 * i, cw: 0, cr: 0, total: 1500 * i, cost: i === 0 ? 0 : 0.37 * i, unpriced: i % 4 === 1 };

function bot(i, row, t) {
  const [name, team, source, modelLabel, status, step, task] = row;
  const id = 'w' + i, helpers = i === 6 ? ['researcher', 'reviewer', 'writer', 'designer', 'researcher', 'reviewer'].map((type, k) => ({ id: id + 'h' + k, type, status: k % 2 ? 'running' : 'working', step: 'WebSearch' })) : [];
  const robot = (k, extra = {}) => ({ key: `session:${id}-${k}`, id: `${id}-${k}`, kind: 'session', source, label: k ? `${name} #${k + 1}` : name, status, statusSince: t - 3600e3 * (i + 1), runningSince: status === 'running' ? t - 5400e3 : null,
    step, task, start: t - 7200e3, lastLine: t - 60e3, model: modelLabel, modelLabel, tokens: tok(i, i === 0), helpers: k ? [] : helpers, waitingMsg: status === 'waiting' ? step : null,
    actions: Array.from({ length: 15 }, (_, a) => ({ t: t - a * 61e3, text: a % 3 ? LONG_CMD : `Edit ${['core.js', 'Қазақша-глоссарий.json', 'README.md'][a % 3]}` })),
    turn: { requested: t - 600e3, working: t - 590e3, approval: status === 'waiting' ? t - 30e3 : null, done: status === 'resting' ? t - 10e3 : null }, ...extra });
  return { id, name, team, source, job: i === 1 ? 'Folder not on the roster: C:\\Users\\alex\\Documents\\Projects\\Hackathon_2026\\final-submission-with-video-and-slides' : 'Stress agent', model: modelLabel, modelLabel, status,
    canOpen: i % 2 === 0, lastLine: status === 'off' ? null : t - 60e3, tokens: tok(i, i === 0), git: i === 2 ? { branch: 'feature/app-localization-glossary-v3-with-very-long-branch-name', changed: 1284, unpushed: 1, behind: 37, dirtyOld: true, dirtySince: t - 26 * 3600e3 } : i === 3 ? { branch: 'main', changed: 0 } : null,
    robots: status === 'off' ? [] : i === 4 ? [robot(0), robot(1), robot(2)] : [robot(0)] };
}

function counts(bots) { const c = { working: 0, waiting: 0, stuck: 0, resting: 0, off: 0 }; for (const b of bots) c[b.status === 'running' ? 'working' : b.status]++; return c; }

export function stressState(kind) {
  const t = now();
  if (kind === 'empty') return { version: 3, seq: 1, now: t, today: '', teams: [], bots: [], counts: counts([]), waiting: [], stuck: [], finished: [], totals: { in: 0, out: 0, cw: 0, cr: 0, total: 0, cost: 0 }, feed: [], approvals: [], approvalsOn: false };
  let rows = ROWS;
  if (kind === 'one') rows = [['Q', 'Research', 'claude', 'Opus 5.5', 'waiting', 'Wants to use Bash: git push', 'Fix login bug']];
  if (kind === 'huge') rows = Array.from({ length: 60 }, (_, i) => { const r = ROWS[i % ROWS.length].slice(); r[0] = `${r[0]} ${i + 1}`; r[4] = ['working', 'running', 'waiting', 'stuck', 'resting'][i % 5]; return r; });
  const bots = rows.map((r, i) => bot(i, r, t));
  const live = bots.flatMap(b => b.robots.map(r => ({ b, r })));
  const waiting = live.filter(x => x.r.status === 'waiting').map(x => ({ bot: x.b.name, botId: x.b.id, robot: x.r.key, label: x.r.label, message: x.r.step, since: x.r.statusSince }));
  const approvals = live.filter(x => x.r.status === 'waiting' && x.b.source === 'claude').map((x, k) => ({ id: `0000000${k}-aaaa-bbbb-cccc-000000000000`, session_id: x.r.id, robot: x.r.key, tool: 'mcp__plugin_claude-for-financial-advisors_google-drive__download_file_content',
    detail: LONG_CMD + ' ' + 'C:\\Users\\alex\\Documents\\Projects\\Hackathon_2026\\'.repeat(40), cwd: 'C:\\Users\\alex\\Documents\\Projects\\Hackathon_2026', since: t - 20e3, until: t + 40e3 }));
  const feed = kind === 'one' ? [{ t, botId: bots[0].id, bot: 'Q', kind: 'action', text: 'ran git push' }]
    : Array.from({ length: 60 }, (_, k) => { const b = bots[k % bots.length]; return { t: t - k * 37e3, botId: b.id, bot: b.name, kind: ['action', 'waiting', 'done', 'stuck', 'start'][k % 5], text: k % 2 ? 'ran ' + LONG_CMD.slice(6) : 'finished: <b>Both</b> forms created & **checked** — 1 284 rows, 37 errors' }; });
  const finished = kind === 'one' ? [{ time: t, bot: 'Q', botId: bots[0].id, summary: 'Fixed the login bug' }]
    : Array.from({ length: 40 }, (_, k) => ({ time: t - k * 900e3, bot: bots[k % bots.length].name, botId: bots[k % bots.length].id, summary: 'Обе формы созданы, все вопросы проверены. **Done** — see `core.js:412` & <README>' }));
  const totals = bots.reduce((a, b) => ({ in: a.in + b.tokens.in, out: a.out + b.tokens.out, cw: a.cw + b.tokens.cw, cr: a.cr + b.tokens.cr, total: a.total + b.tokens.total, cost: a.cost + b.tokens.cost, unpriced: a.unpriced || !!b.tokens.unpriced }), { in: 0, out: 0, cw: 0, cr: 0, total: 0, cost: 0, unpriced: false });
  const teams = kind === 'worst' ? [...TEAMS, 'Research & Development (Almaty)'] : TEAMS;
  if (kind === 'worst') bots.push(bot(bots.length, ['Ассистент по исследованиям и разработке', 'Research & Development (Almaty)', 'claude', 'Opus 5.5', 'working', 'Grep "TODO|FIXME"', null], t));
  return { version: 3, seq: 1, now: t, today: '', teams, bots, counts: counts(bots), waiting, stuck: live.filter(x => x.r.status === 'stuck').map(x => ({ bot: x.b.name, botId: x.b.id, robot: x.r.key })),
    finished, totals, feed, approvals, approvalsOn: true };
}

// The dev-only toggle: bottom-center, plain chrome, switches by reloading with ?data=…
export function stressToggle(current) {
  const bar = document.createElement('div');
  bar.id = 'stressbar';
  bar.style.cssText = 'position:fixed;left:50%;bottom:86px;transform:translateX(-50%);z-index:9999;display:flex;gap:2px;padding:3px;background:#d9d9de;border-radius:10px;font:12px system-ui,sans-serif';
  for (const k of ['demo', 'worst', 'empty', 'one', 'huge']) {
    const b = document.createElement('button');
    b.textContent = { demo: 'Demo data', worst: 'Worst case', empty: 'Empty', one: 'One', huge: '60 agents' }[k];
    b.style.cssText = `border:0;border-radius:8px;padding:5px 10px;cursor:pointer;font:inherit;background:${k === current ? '#fff' : 'transparent'};color:#222`;
    b.onclick = () => { const p = new URLSearchParams(location.search); p.delete('data'); p.delete('demo'); if (k === 'demo') { p.set('demo', '1'); p.set('stress', '1'); } else { p.delete('stress'); p.set('data', k); } location.search = p.toString(); };
    bar.appendChild(b);
  }
  document.body.appendChild(bar);
}
