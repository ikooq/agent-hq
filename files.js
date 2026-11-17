// Agent HQ file helpers: read only the bytes appended to a growing log, and small JSON files.
'use strict';
const fs = require('fs'), path = require('path');

// Open files are kept for files that keep growing: on Windows each open costs 1-2 ms (more under load), and
// live transcripts + the event log grow on almost every tick. A handle is closed after 20 s without new
// bytes, or when the path now points to another file (inode changed). Node opens with FILE_SHARE_DELETE,
// so a held handle never stops Claude Code / Codex from writing, renaming or deleting the file.
const FD_IDLE_MS = 20000, FD_MAX = 64, fdCache = new Map();   // file -> { fd, ino, used }
function dropFd(file) { const e = fdCache.get(file); if (e) { fdCache.delete(file); try { fs.closeSync(e.fd); } catch (x) {} } }
function fdFor(file, ino) {
  let e = fdCache.get(file);
  if (e && e.ino !== ino) { dropFd(file); e = null; }
  if (!e) {
    if (fdCache.size >= FD_MAX) { let old = null; for (const [f, x] of fdCache) if (!old || x.used < old[1].used) old = [f, x]; dropFd(old[0]); }
    e = { fd: fs.openSync(file, 'r'), ino, used: 0 }; fdCache.set(file, e);
  }
  e.used = Date.now();
  return e.fd;
}
function closeIdleFds(all) { const t = Date.now(); for (const [f, e] of [...fdCache]) if (all || t - e.used > FD_IDLE_MS) dropFd(f); }
// Read only the bytes appended since the last call; tolerate missing/rotated files.
function tail(file, st) {
  try {
    const s = fs.statSync(file), size = s.size;
    st.missing = false;
    if (size < st.offset) { st.offset = 0; st.rest = ''; st.reset = true; }
    if (size === st.offset) return [];
    const fd = fdFor(file, s.ino);
    const len = Math.min(size - st.offset, 64 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, st.offset);
    st.offset += n;
    const lines = (st.rest + buf.toString('utf8', 0, n)).split('\n');
    st.rest = lines.pop();
    return lines.filter(l => l.trim());
  } catch (e) { dropFd(file); st.missing = true; return []; }
}
const readJSON = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } };
function writeJSONAtomic(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, f);
}

const openFiles = () => fdCache.size;

module.exports = { tail, closeIdleFds, openFiles, readJSON, writeJSONAtomic };
