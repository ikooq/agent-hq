// Synthetic Agent HQ homes for tests, profiling and demos. Writes only inside the given temp dir.
'use strict';
const fs = require('fs'), path = require('path');

function makeHome(HOME, { agents = 15, codex = true, now = Date.now(), roster: baseRoster } = {}) {
  const HQ = path.join(HOME, '.agent-hq'); fs.mkdirSync(HQ, { recursive: true });
  const iso = s => new Date(now - s * 1000).toISOString();
  const TX = path.join(HOME, 'tx'); fs.mkdirSync(TX, { recursive: true });
  const roster = baseRoster || {
    teams: ['Research', 'Content', 'Visuals', 'Ops', 'Codex'], dropIn: { team: 'Ops' },
    bots: [
      { id: 'hq', name: 'HQ', team: 'Ops', model: 'claude-opus-5-5', folders: ['~/p/hq'] },
      { id: 'nexus', name: 'Nexus', team: 'Visuals', model: 'claude-opus-5-5', folders: ['~/p/nexus'] },
      { id: 'locqa', name: 'LocQA', team: 'Research', model: 'claude-sonnet-5-5', folders: ['~/p/locqa'] },
      { id: 'tutor', name: 'Tutor', team: 'Content', model: 'claude-opus-5-5', folders: ['~/p/tutor'] },
      { id: 'scratch', name: 'Scratch', team: 'Content', model: 'claude-opus-5-5', folders: ['~/p/scratch'] },
      { id: 'researcher', name: 'Researcher', team: 'Research', agentType: 'researcher', folders: [] },
      { id: 'writer', name: 'Writer', team: 'Content', agentType: 'writer', folders: [] },
      { id: 'designer', name: 'Designer', team: 'Visuals', agentType: 'designer', folders: [] },
      { id: 'reviewer', name: 'Reviewer', team: 'Ops', agentType: 'reviewer', folders: [] },
      { id: 'cx-chats', name: 'Codex Chats', team: 'Codex', source: 'codex', folders: ['~/p/cxchats'] },
      { id: 'cx-moodle', name: 'Moodle', team: 'Codex', source: 'codex', folders: ['~/p/moodle'] },
      { id: 'cx-hack', name: 'Hackathon', team: 'Codex', source: 'codex', folders: ['~/p/hack'] },
    ],
  };
  fs.writeFileSync(path.join(HQ, 'roster.json'), JSON.stringify(roster, null, 1));
  try { fs.copyFileSync(path.join(__dirname, 'prices.json'), path.join(HQ, 'prices.json')); } catch (e) {}
  const folderBots = roster.bots.filter(b => (b.folders || []).length && (b.source || 'claude') === 'claude');
  const codexBots = roster.bots.filter(b => b.source === 'codex');
  const events = [], tx = {};
  const plan = ['working', 'running', 'waiting', 'stuck', 'resting', 'working', 'running', 'working', 'resting', 'working', 'working', 'resting'];
  const nClaude = codex ? Math.max(1, agents - Math.min(3, codexBots.length)) : agents;
  for (let i = 0; i < nClaude; i++) {
    const b = folderBots[i % folderBots.length], sid = `fx-${i}`, cwd = path.join(HOME, 'p', b.id), st = plan[i % plan.length];
    const L = tx[sid] = [];
    const E = (s, event, x = {}) => events.push({ time: iso(s), event, session_id: sid, cwd, transcript_path: path.join(TX, sid + '.jsonl'), ...x });
    const A = (s, content, u = { input_tokens: 1200 + i * 50, output_tokens: 400 + i * 20, cache_read_input_tokens: 20000 }) =>
      L.push(JSON.stringify({ type: 'assistant', timestamp: iso(s), message: { id: sid + '-' + s, model: b.model || 'claude-opus-5-5', content, usage: u } }));
    E(1500 + i, 'SessionStart'); E(900, 'UserPromptSubmit');
    L.push(JSON.stringify({ type: 'user', timestamp: iso(900), message: { role: 'user', content: 'task ' + i } }));
    if (st === 'working') A(4, [{ type: 'text', text: `Refactoring module ${i} and updating the tests.` }]);
    if (st === 'running') A(70, [{ type: 'tool_use', id: 'r' + i, name: 'Bash', input: { command: 'npm run build' } }]);
    if (st === 'waiting') { A(80, [{ type: 'tool_use', id: 'w' + i, name: 'Bash', input: { command: 'git push' } }]); E(79, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }); }
    if (st === 'stuck') A(800, [{ type: 'text', text: 'Thinking about the layout…' }]);
    if (st === 'resting') { A(500, [{ type: 'text', text: 'Done: report saved.' }]); E(490, 'Stop', { summary: 'Done: report saved.' }); }
  }
  const month = new Date(now).toISOString().slice(0, 7);
  fs.writeFileSync(path.join(HQ, `events-${month}.jsonl`), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  for (const [sid, ls] of Object.entries(tx)) fs.writeFileSync(path.join(TX, sid + '.jsonl'), ls.join('\n') + '\n');
  if (codex) {
    codexBots.slice(0, agents - nClaude).forEach((b, k) => writeCodexSession(HOME, { id: `cx-${k}`, cwd: path.join(HOME, 'p', b.folders[0].split('/').pop()), now, state: ['working', 'running', 'resting'][k % 3] }));
  }
  return { HOME, HQ };
}

// Codex rollout fixture in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (real format, minimal fields)
function writeCodexSession(HOME, { id, cwd, now = Date.now(), state = 'working', model = 'gpt-6.1-sol' }) {
  const d = new Date(now), p2 = n => String(n).padStart(2, '0');
  const dir = path.join(HOME, '.codex', 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const iso = s => new Date(now - s * 1000).toISOString();
  const L = [];
  const R = (s, type, payload) => L.push(JSON.stringify({ timestamp: iso(s), type, payload }));
  R(600, 'session_meta', { id, session_id: id, timestamp: iso(600), cwd });
  R(599, 'turn_context', { turn_id: 't1', cwd, model });
  R(598, 'event_msg', { type: 'task_started', turn_id: 't1' });
  R(597, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say hi' }] });
  R(590, 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['npm', 'test'] }), call_id: 'c1' });
  R(585, 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'ok' });
  R(584, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 10000, cached_input_tokens: 6000, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 10300 } } });
  R(584, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 10000, cached_input_tokens: 6000, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 10300 } } });
  if (state === 'running') R(60, 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['npm', 'run', 'build'] }), call_id: 'c2' });
  if (state === 'working') R(5, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Writing the summary now.' }] });
  if (state === 'resting') { R(300, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }); R(299, 'event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: 'hi' }); }
  if (state === 'waiting') { R(50, 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['git', 'push'] }), call_id: 'c3' }); R(49, 'event_msg', { type: 'exec_approval_request', call_id: 'c3', command: ['git', 'push'] }); }
  R(state === 'working' ? 4 : 583, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 15000, cached_input_tokens: 8000, cache_write_input_tokens: 0, output_tokens: 500, reasoning_output_tokens: 150, total_tokens: 15500 } } });
  const f = path.join(dir, `rollout-${d.toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`);
  fs.writeFileSync(f, L.join('\n') + '\n');
  return f;
}

module.exports = { makeHome, writeCodexSession };
