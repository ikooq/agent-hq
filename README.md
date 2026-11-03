# Agent HQ

A live 3D office for Claude Code and Codex agents. Everything runs locally on `127.0.0.1:7777`, with no dependencies and no network calls.

- `hook.js`: Claude Code hook that appends one line per event to `events-YYYY-MM.jsonl`
- `core.js`: reads hook events, Claude transcripts and Codex logs (read-only) into office state
- `server.js`: HTTP server with `/state`, the `/events` SSE stream, timeline and stats
- `web/`: the Three.js office (Three.js r160 is vendored in `vendor/`)
- `cli.js`: `agent-hq start | stop | restart | status | test | bench | open`
- `roster.json`: bots, teams and folders; `prices.json`: model prices for cost estimates
- `claude/`: copies of the Claude Code agents (`~/.claude/agents`) and the hooks block for `~/.claude/settings.json`

## Run

```
node cli.js start
node cli.js test
```

Then open http://127.0.0.1:7777/ (or `?bench=1` for the benchmark).

## Install on a new machine

1. Clone this repo into `~/.agent-hq`.
2. Copy `claude/agents/*.md` into `~/.claude/agents/`.
3. Merge `claude/hooks.json` into the `hooks` key of `~/.claude/settings.json`.
4. Edit `roster.json` folders to match your projects.
