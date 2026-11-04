// Agent HQ demo mode (?demo=1): a scripted 90-second day with fake agents. No real data, no server calls.
// Agents arrive, work, run commands, one asks for approval at the kiosk, one gets stuck, they report to the
// lead office, pin cards on the Done board and rest in the lounge, while the day turns into night. Loops.
const DAY_S = 90, LOOP_PAUSE_S = 6;
const TEAMS = ['Research', 'Content', 'Visuals', 'Ops', 'Codex'];
const BOTS = [
  { id: 'atlas', name: 'Atlas', team: 'Research', job: 'Market research and competitor notes', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', git: { branch: 'main', changed: 0, unpushed: 0 } },
  { id: 'quill', name: 'Quill', team: 'Content', job: 'Release notes, docs and blog posts', model: 'claude-opus-5-5', label: 'Opus 5.5', git: { branch: 'docs/v2', changed: 3, unpushed: 1 } },
  { id: 'pixel', name: 'Pixel', team: 'Visuals', job: 'Landing page and design system', model: 'claude-opus-5-5', label: 'Opus 5.5', git: { branch: 'feat/hero', changed: 5, unpushed: 2, dirtyOld: true } },
  { id: 'forge', name: 'Forge', team: 'Ops', job: 'Backend, auth and deploys', model: 'claude-opus-5-5', label: 'Opus 5.5', git: { branch: 'fix/login', changed: 2, unpushed: 0 } },
  { id: 'relay', name: 'Relay', team: 'Codex', job: 'API client refactor (Codex)', model: 'gpt-6.1-sol', label: 'OpenAI · gpt-6.1-sol', source: 'codex', git: { branch: 'main', changed: 1, unpushed: 0 } },
  { id: 'scout', name: 'Scout', team: 'Research', job: 'User interviews and survey analysis', model: 'claude-haiku-5-5', label: 'Haiku 5.5', git: null },
];
// [second, bot, what, ...args]   what: in | work(task, step) | step(step) | run(step) | wait(tool, detail) | stuck | done(summary) | helpers(n) | out
const SCRIPT = [
  [1, 'forge', 'in'], [2, 'atlas', 'in'], [3, 'forge', 'work', 'Fix login bug', 'Read src/auth/session.ts'],
  [4, 'quill', 'in'], [5, 'atlas', 'work', 'Compare pricing pages', 'WebSearch "agent dashboard pricing"'],
  [6, 'pixel', 'in'], [7, 'quill', 'work', 'Write the v2 release notes', 'Read CHANGELOG.md'],
  [9, 'pixel', 'work', 'Polish the landing hero', 'Edit Hero.tsx'], [10, 'forge', 'step', 'Edit src/auth/session.ts'],
  [11, 'relay', 'in'], [12, 'atlas', 'helpers', 2], [13, 'relay', 'work', 'Refactor the API client', 'Shell: rg "fetchJson" src'],
  [15, 'quill', 'step', 'Writing: what changed in v2…'], [16, 'scout', 'in'], [17, 'pixel', 'run', 'Bash: npm run build'],
  [18, 'scout', 'work', 'Tag 40 survey answers', 'Read survey/answers.csv'], [19, 'forge', 'stuck'],
  [21, 'quill', 'wait', 'Write', 'docs/CHANGELOG.md'], [23, 'atlas', 'helpers', 0], [24, 'relay', 'run', 'Shell: pytest -q tests/api'],
  [26, 'pixel', 'step', 'Edit tailwind.config.js'], [27, 'atlas', 'step', 'Writing: pricing table for 6 tools'],
  [30, 'quill', 'step', 'Write docs/CHANGELOG.md'], [31, 'scout', 'step', 'Writing: top 5 themes'],
  [33, 'atlas', 'done', 'Pricing comparison saved to notes/pricing.md'], [34, 'relay', 'step', 'Edit src/api/client.ts'],
  [36, 'forge', 'work', 'Fix login bug', 'Edit src/auth/cookies.ts'], [38, 'pixel', 'done', 'Hero polished: new gradient, 40% smaller image'],
  [40, 'scout', 'run', 'Bash: python tag_answers.py'], [42, 'quill', 'done', 'Release notes for v2 are in docs/CHANGELOG.md'],
  [44, 'forge', 'run', 'Bash: npm test -- auth'], [47, 'relay', 'done', 'API client now uses one fetch wrapper; tests pass'],
  [49, 'scout', 'step', 'Writing: survey summary'], [50, 'forge', 'step', 'Edit tests/auth.spec.ts'],
  [52, 'atlas', 'work', 'Summarize the interviews', 'Read interviews/notes-1.md'], [54, 'scout', 'done', '40 answers tagged, 5 themes'],
  [56, 'pixel', 'work', 'Dark mode for the hero', 'Edit Hero.tsx'], [58, 'forge', 'done', 'Login bug fixed: cookie path was wrong'],
  [60, 'quill', 'work', 'Blog post: what is new in v2', 'Writing: intro paragraph'], [63, 'atlas', 'helpers', 2],
  [64, 'pixel', 'run', 'Bash: npm run build'], [68, 'atlas', 'helpers', 0], [70, 'atlas', 'step', 'Writing: 3 key insights'],
  [72, 'pixel', 'done', 'Dark mode hero ready for review'], [75, 'atlas', 'done', 'Interview summary in notes/interviews.md'],
  [79, 'quill', 'done', 'Blog post draft saved to blog/v2.md'],
];
const DEMO_HOUR = s => 8 + Math.min(1, s / DAY_S) * 15;   // 08:00 -> 23:00

export function createDemo({ apply, world, ui }) {
  let t0 = performance.now(), sim = null, k = 0, timer = null;
  const now = () => Date.now();
  function reset() {
    sim = { bots: new Map(), finished: [], feed: [], approvals: [], seq: 0 };
    for (const b of BOTS) sim.bots.set(b.id, { ...b, robot: null, tokens: { in: 0, out: 0, cw: 0, cr: 0, total: 0, cost: 0, unpriced: b.source === 'codex' } });
    k = 0;
  }
  const feed = (b, kind, text) => { sim.feed.unshift({ t: now(), botId: b.id, bot: b.name, kind, text }); sim.feed.length = Math.min(sim.feed.length, 40); };
  function robotOf(b) {
    return b.robot || (b.robot = { key: 'session:demo-' + b.id, id: 'demo-' + b.id, kind: 'session', source: b.source || 'claude', label: b.name, status: 'resting', statusSince: now(), runningSince: null,
      step: 'Starting…', task: null, waitingMsg: null, start: now(), lastLine: now(), model: b.model, modelLabel: b.label, cwd: '~/projects/' + b.id, agentType: null,
      tokens: { in: 0, out: 0, cw: 0, cr: 0, total: 0, cost: 0 }, helpers: [], turn: null, actions: [] });
  }
  function set(r, status, step) { if (r.status !== status) r.statusSince = now(); r.status = status; if (step != null) r.step = step; r.lastLine = now(); r.actions.unshift({ t: now(), text: step || status }); r.actions.length = Math.min(r.actions.length, 15); }
  function run(ev) {
    const [, id, what, a1, a2] = ev, b = sim.bots.get(id), r = robotOf(b);
    switch (what) {
      case 'in': r.start = now(); feed(b, 'start', 'came in'); break;
      case 'work': r.task = a1; r.turn = { requested: now(), working: now() + 800, approval: null, done: null }; r.runningSince = null; set(r, 'working', a2); feed(b, 'action', a2.toLowerCase()); break;
      case 'step': r.runningSince = null; set(r, 'working', a1); feed(b, 'action', a1.replace(/^Writing: /, 'is writing ').toLowerCase()); break;
      case 'run': r.runningSince = now(); set(r, 'running', 'Running ' + a1); feed(b, 'action', 'ran ' + a1.replace(/^\w+: /, '')); break;
      case 'stuck': set(r, 'stuck'); feed(b, 'stuck', 'looks stuck'); break;
      case 'wait': {
        r.waitingMsg = `Wants to use ${a1}: ${a2}`; r.turn.approval = now(); set(r, 'waiting', r.waitingMsg); feed(b, 'waiting', 'needs approval');
        sim.approvals.push({ id: 'demo-approval', session_id: r.id, robot: r.key, tool: a1, detail: a2, cwd: r.cwd, since: now(), until: now() + 9000 });
        break;
      }
      case 'helpers': r.helpers = a1 ? [{ id: id + '-h1', type: 'researcher', status: 'working', step: 'WebSearch' }, { id: id + '-h2', type: 'reviewer', status: 'running', step: 'Read notes' }].slice(0, a1) : []; break;
      case 'done': r.turn.done = now(); set(r, 'resting', 'Done: ' + a1); r.waitingMsg = null;
        sim.finished.unshift({ time: now(), bot: b.name, botId: b.id, summary: a1, session: r.id.slice(5, 13), sessionId: r.id }); feed(b, 'done', 'finished: ' + a1); break;
    }
    if (what !== 'wait') sim.approvals = sim.approvals.filter(x => x.robot !== r.key);
  }
  function build() {
    const bots = [], counts = { working: 0, waiting: 0, stuck: 0, resting: 0, off: 0 }, waiting = [], stuck = [], totals = { in: 0, out: 0, cw: 0, cr: 0, total: 0, cost: 0, unpriced: true };
    for (const b of sim.bots.values()) {
      const r = b.robot;
      if (r && (r.status === 'working' || r.status === 'running')) { const add = 900 + (b.id.length * 137) % 700; b.tokens.in += 40; b.tokens.out += add; b.tokens.cr += add * 12; b.tokens.total = b.tokens.in + b.tokens.out; if (b.source !== 'codex') b.tokens.cost += add * 15 / 1e6 + add * 12 * .3 / 1e6; }
      if (r) { r.tokens = { ...b.tokens }; counts[r.status === 'running' ? 'working' : r.status]++; } else counts.off++;
      if (r && r.status === 'waiting') waiting.push({ bot: b.name, botId: b.id, robot: r.key, label: r.label, message: r.waitingMsg, since: r.statusSince });
      if (r && r.status === 'stuck') stuck.push({ bot: b.name, botId: b.id, robot: r.key, label: r.label, since: r.statusSince });
      for (const k2 of ['in', 'out', 'cw', 'cr', 'total', 'cost']) totals[k2] += b.tokens[k2];
      bots.push({ id: b.id, name: b.name, job: b.job, team: b.team, source: b.source || 'claude', dropIn: false, agentType: null, canOpen: false, model: b.model, modelLabel: b.label,
        git: b.git ? { ...b.git, dirtyOld: !!b.git.dirtyOld, dirtySince: b.git.dirtyOld ? now() - 3 * 3600000 : null } : null,
        status: r ? r.status : 'off', tokens: { ...b.tokens }, lastLine: r ? r.lastLine : null, robots: r ? [structuredClone(r)] : [] });
    }
    return { version: 3, demo: true, seq: ++sim.seq, now: now(), today: new Date().toISOString().slice(0, 10), teams: TEAMS, bots, counts, waiting, stuck, finished: sim.finished.slice(0, 40), totals,
      feed: sim.feed.slice(0, 40), stuckAfterMin: 10, approvals: sim.approvals.slice(), approvalsOn: true, muted: true, viewer: { lan: false, canControl: false, canApprove: true, demo: true } };
  }
  let prev = null;
  function step() {
    const s = (performance.now() - t0) / 1000;
    if (s > DAY_S + LOOP_PAUSE_S) {   // loop: everybody walks out, then a new day starts
      t0 = performance.now(); reset(); world.hourOverride = DEMO_HOUR(0);
    }
    while (k < SCRIPT.length && SCRIPT[k][0] <= s) run(SCRIPT[k++]);
    if (s > 21 + 8 && sim.approvals.length) {   // nobody clicked: the demo approves after 8 s
      const a = sim.approvals[0], b = sim.bots.get(a.robot.replace('session:demo-', '')); sim.approvals = [];
      if (b && b.robot && b.robot.status === 'waiting') { set(b.robot, 'working', 'Write docs/CHANGELOG.md'); feed(b, 'action', 'approval granted, writing CHANGELOG.md'); }
    }
    world.hourOverride = DEMO_HOUR(s);
    const st = build(); apply(st, prev); prev = st;
    if (ui) ui.demoClock = DEMO_HOUR(s);
  }
  // Allow once / Deny in the demo: resolved locally
  const decide = (id, decision) => {
    const a = sim.approvals.find(x => x.id === id); if (!a) return false;
    const b = sim.bots.get(a.robot.replace('session:demo-', '')); sim.approvals = sim.approvals.filter(x => x !== a);
    if (b && b.robot) { if (decision === 'allow') { set(b.robot, 'working', 'Write docs/CHANGELOG.md'); feed(b, 'action', 'approval granted'); } else { set(b.robot, 'working', 'Writing: asked for another way'); feed(b, 'action', 'approval denied'); } }
    step(); return true;
  };
  reset();
  return { start() { step(); timer = setInterval(step, 500); }, stop() { clearInterval(timer); }, tick: step, decide, seconds: () => (performance.now() - t0) / 1000, DAY_S };
}
