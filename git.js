// Agent HQ: git status of roster folders (branch, uncommitted files, unpushed commits).
// Runs `git status --porcelain=v2 --branch -z` at most once a minute per folder, one folder at a time,
// in the background (async child processes, never inside a tick). Read-only: --no-optional-locks and
// GIT_OPTIONAL_LOCKS=0 so it never takes the index lock or rewrites the index of a repo an agent is using.
'use strict';
const fs = require('fs'), path = require('path');
const { execFile } = require('child_process');

const DIRTY_OLD_MS = 2 * 3600000;

function run(args, cwd, timeout = 10000) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

// porcelain v2 with -z: records separated by NUL; renames ("2 ...") carry one extra NUL-separated original path
function parseStatus(out) {
  const r = { branch: null, oid: null, upstream: null, ahead: null, behind: null, changed: 0, files: [] };
  const recs = out.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const l = recs[i]; if (!l) continue;
    if (l.startsWith('# branch.head ')) r.branch = l.slice(14);
    else if (l.startsWith('# branch.oid ')) r.oid = l.slice(13);
    else if (l.startsWith('# branch.upstream ')) r.upstream = l.slice(18);
    else if (l.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(l); if (m) { r.ahead = +m[1]; r.behind = +m[2]; } }
    else if (l[0] === '1') { r.changed++; r.files.push(l.split(' ').slice(8).join(' ')); }
    else if (l[0] === '2') { r.changed++; r.files.push(l.split(' ').slice(9).join(' ')); i++; }
    else if (l[0] === 'u') { r.changed++; r.files.push(l.split(' ').slice(10).join(' ')); }
    else if (l[0] === '?') { r.changed++; r.files.push(l.slice(2)); }
  }
  return r;
}

async function oldestMtime(dir, files) {
  let oldest = 0;
  for (const f of files.slice(0, 300)) {
    try { const m = (await fs.promises.stat(path.join(dir, f))).mtimeMs; if (!oldest || m < oldest) oldest = m; } catch (e) {}   // deleted files: no mtime
  }
  return oldest || null;
}

async function gitStatus(dir, now = Date.now()) {
  const out = await run(['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], dir);
  if (out == null) return null;                                   // not a repo (or git missing)
  const s = parseStatus(out);
  let unpushed = s.ahead;
  if (s.upstream == null && s.oid && s.oid !== '(initial)') {     // no upstream: commits not on any remote branch
    const n = await run(['--no-optional-locks', 'rev-list', '--count', 'HEAD', '--not', '--remotes'], dir);
    unpushed = n == null ? null : +n.trim() || 0;
  }
  const dirtySince = s.changed ? await oldestMtime(dir, s.files) : null;
  return {
    branch: s.branch === '(detached)' ? 'detached' : s.branch, upstream: s.upstream, changed: s.changed, unpushed, behind: s.behind,
    dirtySince, dirtyOld: !!(dirtySince && now - dirtySince > DIRTY_OLD_MS), checkedAt: now,
  };
}

const gitLabel = g => !g ? '' : [g.branch || '?', g.changed ? `${g.changed} changed` : 'clean', g.unpushed ? `${g.unpushed} unpushed` : null].filter(Boolean).join(' · ');

// Watches the first folder of every roster bot. get(botId) -> info or null. onChange() after a pass that changed something.
function createGitWatcher({ roster, expand, intervalMs = 60000, onChange = () => {}, log = () => {} }) {
  const byDir = new Map();    // dir -> { info, at }
  let busy = false, timer = null, stopped = false;
  const dirOf = b => (b.folders || [])[0] ? path.resolve(expand(b.folders[0])) : null;
  async function pass() {
    if (busy || stopped) return; busy = true;
    let changed = false;
    try {
      const dirs = [...new Set((roster().bots || []).map(dirOf).filter(Boolean))];
      for (const d of byDir.keys()) if (!dirs.includes(d)) { byDir.delete(d); changed = true; }
      for (const dir of dirs) {
        if (stopped) break;
        const c = byDir.get(dir);
        if (c && Date.now() - c.at < intervalMs - 1000) continue;  // at most once a minute per folder
        let info = null;
        try { if (fs.existsSync(dir)) info = await gitStatus(dir); } catch (e) { log('git error', dir, e.message); }
        const was = c ? JSON.stringify({ ...c.info, checkedAt: 0 }) : null;
        byDir.set(dir, { info, at: Date.now() });
        if (was !== JSON.stringify(info ? { ...info, checkedAt: 0 } : null)) changed = true;
      }
    } finally { busy = false; }
    if (changed) onChange();
  }
  return {
    start(delay = 2000) { setTimeout(pass, delay); timer = setInterval(pass, Math.max(5000, intervalMs / 4)); return this; },
    stop() { stopped = true; clearInterval(timer); },
    pass,
    get(botId) { const b = (roster().bots || []).find(x => (x.id || x.name) === botId); const d = b && dirOf(b); const c = d && byDir.get(d); return c ? c.info : null; },
    dirs: () => [...byDir.keys()],
  };
}

module.exports = { gitStatus, parseStatus, gitLabel, createGitWatcher, DIRTY_OLD_MS };
