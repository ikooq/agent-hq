// Agent HQ labels: short human text for prompts, models and tool calls ("Edit server.js", "Opus 5.5").
// Pure functions, no state, so the engine, the report and the tests share them.
'use strict';
const path = require('path');

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// First real line of a prompt ("Fix login bug"): skips system/tool text (lines starting with "<") and interruption markers.
function taskLine(txt) {
  txt = String(txt || '');
  const req = /## My request for Codex:\s*/.exec(txt); if (req) txt = txt.slice(req.index + req[0].length);   // Codex IDE context block
  else if (/^\s*# (Files mentioned by the user|Context from my IDE)/.test(txt)) return null;
  for (const l of txt.split(/\r?\n/)) { const x = l.trim(); if (!x || x.startsWith('<') || /^\[Request interrupted/.test(x) || /^Caveat: /.test(x)) continue; return clip(x, 40); }
  return null;
}

function modelLabel(m, source) {
  const x = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(m || '');
  if (x) return x[1][0].toUpperCase() + x[1].slice(1) + ' ' + x[2] + (x[3] ? '.' + x[3] : '');
  if (source === 'codex' || /^(gpt|o\d|codex)/i.test(m || '')) return 'OpenAI · ' + (m || 'codex');
  return m ? clip(m, 18) : '—';
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

module.exports = { clip, taskLine, modelLabel, actionLabel, codexActionLabel, feedPhrase };
