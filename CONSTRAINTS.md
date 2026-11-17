# Constraints

Last reviewed: 2026-11-17.

Read this before changing Agent HQ. Do not weaken it to make a change pass: fix the code, or add a dated
exception below that a human approved. `node cli.js check` runs the fast checks; `node cli.js check --full`
also runs the self-test and the test-count ratchet.

## Floor (always enforced)

- No skipped or deleted self-test checks without a reason in the commit message.
- No secrets or personal data in git (see "Private files" below).
- This file does not get weakened in the same change that needed it weakened.

Silent `catch (e) {}` blocks are allowed on purpose: the hook and the server must never crash or block a
Claude Code session because of a bad log line or a missing file.

## Enforced with numbers

| Dimension | Rule | Why | Checked by | Runs at |
|-----------|------|-----|------------|---------|
| Dependencies | Node built-ins only: no npm packages, no `package.json` dependencies. Browser code imports only `/vendor/` (Three.js r160, pinned) and our own `/web/` files | Installs in a minute, nothing pulled from the internet, nothing to audit | `node cli.js check` | every change, CI |
| Network | No outside URLs in runtime code. The server binds `127.0.0.1`; LAN mode is opt-in, token-gated and expires after 12 h | Your prompts and file paths never leave the machine | `node cli.js check` | every change, CI |
| Private files | `events-*.jsonl`, `stats/`, `reports/`, `roster.json`, `secret`, `settings.json`, `soak-*.csv`, `screenshots/`, logs are never tracked | They hold your prompts, paths and the approvals secret | `node cli.js check` | every change, CI |
| Codex | Never write into `~/.codex` (read logs only) | Codex owns that folder; a bad write could break it | self-test check "~/.codex is never written" | task end, CI |
| Approvals | Off by default; Allow once / Deny for one request id; no "always allow"; requests touching Agent HQ or `~/.claude/settings` stay in the terminal | The office must not become a way around Claude Code's permission prompt | self-test approvals checks | task end, CI |
| Self-test | All checks pass, on Windows and Ubuntu, Node 22 | The only proof a change didn't break statuses, tokens, walking, the API guards | `node cli.js check --full` / `node cli.js test` | task end, CI |
| Frame rate | 15 agents at 1920x1080 on Intel UHD: ≥ 58 fps average, p95 frame < 20 ms, < 150 draw calls | Smooth on the laptop it runs on; measured 136 fps / 12 ms / 24 draws on 2026-11-04 | `node cli.js bench` (prints PASS/FAIL) | before a visual or render change ships (needs Chrome + GPU, local only) |
| Long run | Over a soak run: textures, shader programs, geometries and DOM nodes stay constant; page heap within ±15 MB | Catches the leaks that made the office lag after hours (textures 20 → 156 in 20 min before the fix) | `node cli.js soak --minutes=20` | before a render or server change ships (local only) |

The bench and soak are the external opinion here: they measure a real browser on real hardware, which the
agent cannot argue with. They need Chrome and a GPU, so they run locally, not in CI.

## Measured, not yet enforced (ratchets: must not get worse)

| Metric | Today | Direction | Checked by |
|--------|-------|-----------|------------|
| Self-test checks | 116 | must not fall | `node cli.js check --full` |
| Server tick under the 20-min soak (avg / max) | 20–33 ms / 270 ms | must fall; target avg < 15 ms, max < 200 ms | `node cli.js soak` |

## Exceptions

| ID | Rule | Path | Reason | Owner | Expires |
|----|------|------|--------|-------|---------|
| — | | | | | |
