// Minimal Chrome DevTools Protocol driver (Node 22 built-ins only: fetch + WebSocket).
// Used by `agent-hq bench` to open a page in Chrome and read numbers from it.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);
const sleep = n => new Promise(r => setTimeout(r, n));

async function launch({ width = 1920, height = 1080, gpu = true, headless = true } = {}) {
  const exe = CHROME_PATHS.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
  if (!exe) throw new Error('Chrome/Edge not found (set CHROME_PATH)');
  const port = 9300 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-chrome-'));
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--enable-precise-memory-info',
    '--disable-frame-rate-limit=false', 'about:blank'];
  if (headless) args.unshift('--headless=new');
  if (gpu) args.unshift('--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=d3d11');
  else args.unshift('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  const proc = spawn(exe, args, { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 60 && !ver; i++) { await sleep(150); try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch (e) {} }
  if (!ver) { proc.kill(); throw new Error('Chrome did not open its debugging port'); }
  const close = () => {   // kill the whole tree (Chrome GPU/renderer children survive proc.kill() on Windows)
    try { if (process.platform === 'win32') require('child_process').execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); else proc.kill(); } catch (e) {}
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }, 1500);
  };
  return { proc, port, profile, close };
}

async function openPage(browser, url) {
  const t = await (await fetch(`http://127.0.0.1:${browser.port}/json/new?${encodeURI(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    else if (m.method) listeners.forEach(fn => fn(m));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Runtime.enable');
  return { send, evaluate, on: fn => listeners.push(fn), close: () => ws.close() };
}

module.exports = { launch, openPage, sleep };
