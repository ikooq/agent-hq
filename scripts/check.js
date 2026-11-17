#!/usr/bin/env node
// Agent HQ constraint checks (see CONSTRAINTS.md). Built-ins only. Exit 0 = pass, 1 = a constraint failed.
//   node scripts/check.js            fast: dependencies, network, loopback, private files, guard on the diff
//   node scripts/check.js --full     also runs the self-test and the test-count ratchet
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FULL = process.argv.includes('--full');
const builtins = new Set(require('module').builtinModules);
let failed = 0;
const pass = msg => console.log(`PASS  ${msg}`);
const fail = (msg, detail) => { failed++; console.log(`FAIL  ${msg}${detail ? '\n      ' + detail : ''}`); };
const warn = msg => console.log(`WARN  ${msg}`);
const git = args => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return null; } };

const jsFiles = [
  ...fs.readdirSync(ROOT).filter(f => f.endsWith('.js')),
  ...fs.readdirSync(path.join(ROOT, 'web')).filter(f => f.endsWith('.js')).map(f => 'web/' + f),
  ...fs.readdirSync(__dirname).filter(f => f.endsWith('.js')).map(f => 'scripts/' + f),
];
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Dependencies: Node built-ins, relative files, /vendor/ and the "three" import map only.
{
  const bad = [];
  if (fs.existsSync(path.join(ROOT, 'package.json'))) {
    const p = JSON.parse(read('package.json'));
    for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) if (p[k] && Object.keys(p[k]).length) bad.push(`package.json ${k}`);
  }
  for (const f of jsFiles) {
    const s = read(f);
    for (const m of s.matchAll(/require\(\s*['"]([\w@./:-]+)['"]\s*\)/g)) { const x = m[1].replace(/^node:/, ''); if (!x.startsWith('.') && !builtins.has(x)) bad.push(`${f}: require('${m[1]}')`); }
    for (const m of s.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)) { const x = m[1]; if (!/^(\.{1,2}\/|\/(vendor|web)\/)/.test(x) && x !== 'three') bad.push(`${f}: import '${x}'`); }
  }
  bad.length ? fail('dependencies: Node built-ins and vendored files only', bad.join('\n      ')) : pass('dependencies: Node built-ins and vendored files only');
}

// Network: no outside URLs in runtime code (test.js keeps fake hosts on purpose).
{
  const bad = [];
  for (const f of jsFiles.filter(f => f !== 'test.js' && !f.startsWith('scripts/'))) {
    for (const m of read(f).matchAll(/https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\]|\$\{)[\w.-]+/g)) bad.push(`${f}: ${m[0]}`);
  }
  bad.length ? fail('network: no outside URLs in runtime code', bad.join('\n      ')) : pass('network: no outside URLs in runtime code');
  /^const HOST = '127\.0\.0\.1';$/m.test(read('server.js')) ? pass("network: server binds 127.0.0.1") : fail("network: server binds 127.0.0.1", "server.js must keep: const HOST = '127.0.0.1';");
}

// Private files never tracked.
{
  const tracked = git(['ls-files']);
  if (tracked == null) warn('private files: not a git checkout, skipped');
  else {
    const re = /(^|\/)(events[^/]*\.jsonl|stats\/|reports\/|roster\.json|secret|settings\.json|soak-[^/]*\.csv|screenshots\/|screenshot-[^/]*\.png|server\.(log|pid))/;
    const bad = tracked.split('\n').filter(f => f && re.test(f));
    bad.length ? fail('private files: none tracked by git', bad.join(', ')) : pass('private files: none tracked by git');
  }
}

// Guard on the diff against the base (origin/main, or the CI base): the bar must not quietly get lower.
{
  const base = process.env.CHECK_BASE || (git(['rev-parse', '--verify', '-q', 'origin/main']) ? 'origin/main' : null);
  const diff = base ? git(['diff', base, '--', 'test.js', 'CONSTRAINTS.md']) : null;
  if (diff == null) warn('guard: no base to diff against, skipped');
  else {
    const lines = diff.split('\n');
    const added = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')), removed = lines.filter(l => l.startsWith('-') && !l.startsWith('---'));
    const net = added.filter(l => /\bcheck\(/.test(l)).length - removed.filter(l => /\bcheck\(/.test(l)).length;
    if (added.some(l => /\.skip\(|\bskip\s*=\s*true/.test(l))) fail('guard: no skipped checks added to test.js');
    if (net < 0) warn(`guard: test.js has ${-net} fewer check() calls than ${base}; say why in the commit message`);
    if (/^diff --git a\/CONSTRAINTS\.md/m.test(diff)) warn(`guard: CONSTRAINTS.md changed vs ${base}; a human must review any loosened rule`);
    pass(`guard: diff vs ${base} reviewed`);
  }
}

// Full: the self-test and the test-count ratchet from CONSTRAINTS.md.
if (FULL) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'test.js')], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const m = /(\d+)\/(\d+) checks passed/.exec(r.stdout || '');
  const min = +((/\|\s*Self-test checks\s*\|\s*(\d+)\s*\|/.exec(read('CONSTRAINTS.md')) || [])[1] || 0);
  if (r.status !== 0 || !m || m[1] !== m[2]) fail('self-test: all checks pass', ((r.stdout || '') + (r.stderr || '')).split('\n').filter(l => /^FAIL/.test(l)).slice(0, 10).join('\n      ') || `exit ${r.status}`);
  else pass(`self-test: ${m[1]}/${m[2]} checks passed`);
  if (m && +m[2] < min) fail(`ratchet: self-test has at least ${min} checks`, `found ${m[2]}`); else if (m) pass(`ratchet: ${m[2]} checks >= ${min}`);
}

console.log(failed ? `\n${failed} constraint(s) failed (see CONSTRAINTS.md)` : '\nAll constraints hold.');
process.exitCode = failed ? 1 : 0;
