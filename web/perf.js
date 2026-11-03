// Agent HQ perf overlay: press F to toggle. fps, frame ms, p95, draw calls, triangles, textures, JS heap, long tasks.
// Also exposed as window.__perf for `agent-hq bench`.
export class Perf {
  constructor() {
    this.samples = new Float32Array(240); this.n = 0; this.i = 0; this.last = 0;
    this.info = { calls: 0, triangles: 0, textures: 0, geometries: 0, programs: 0 };
    this.longTasks = []; this.frames = 0; this.t0 = performance.now();
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) { this.longTasks.push({ t: e.startTime, ms: e.duration }); if (this.longTasks.length > 200) this.longTasks.shift(); } }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
    this.el = document.createElement('pre');
    this.el.style.cssText = 'position:fixed;left:12px;top:90px;z-index:99;margin:0;padding:8px 11px;border-radius:10px;background:rgba(20,18,30,.82);color:#e9f7ef;font:12px/1.45 Consolas,monospace;pointer-events:none;display:none;white-space:pre';
    document.body.appendChild(this.el);
    this.visible = localStorage.getItem('hq-perf') === '1'; this.el.style.display = this.visible ? 'block' : 'none';
    addEventListener('keydown', e => { if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) this.toggle(); });
    this.extra = () => '';
    setInterval(() => this.paint(), 500);
    window.__perf = this;
  }
  toggle() { this.visible = !this.visible; localStorage.setItem('hq-perf', this.visible ? '1' : '0'); this.el.style.display = this.visible ? 'block' : 'none'; }
  frame(now, renderer) {
    if (this.last) { const dt = now - this.last; if (dt < 1000) { this.samples[this.i] = dt; this.i = (this.i + 1) % this.samples.length; this.n = Math.min(this.n + 1, this.samples.length); } }
    this.last = now; this.frames++;
    if (renderer) { const r = renderer.info; this.info.calls = r.render.calls; this.info.triangles = r.render.triangles; this.info.textures = r.memory.textures; this.info.geometries = r.memory.geometries; this.info.programs = r.programs ? r.programs.length : 0; }
  }
  idle() { this.last = 0; }   // call when a frame is skipped on purpose (hidden tab / idle cap) so gaps don't count
  stats() {
    const a = Array.from(this.samples.subarray(0, this.n)).sort((x, y) => x - y);
    const avg = a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
    const p95 = a.length ? a[Math.min(a.length - 1, Math.floor(a.length * .95))] : 0;
    const heap = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
    const recentLong = this.longTasks.filter(t => performance.now() - t.t < 10000);
    return { fps: avg ? 1000 / avg : 0, frameMs: avg, p95, ...this.info, heapMB: heap, longTasks10s: recentLong.length, maxLongTaskMs: recentLong.reduce((m, t) => Math.max(m, t.ms), 0) };
  }
  paint() {
    if (!this.visible) return;
    const s = this.stats();
    this.el.textContent = `fps     ${s.fps.toFixed(1)}\nframe   ${s.frameMs.toFixed(2)} ms\np95     ${s.p95.toFixed(2)} ms\ndraws   ${s.calls}\ntris    ${s.triangles.toLocaleString('en-US')}\ntex     ${s.textures}  geo ${s.geometries}  prog ${s.programs}\nheap    ${s.heapMB == null ? 'n/a' : s.heapMB.toFixed(1) + ' MB'}\nlong>50 ${s.longTasks10s} (max ${s.maxLongTaskMs.toFixed(0)} ms, 10 s)` + this.extra();
  }
}
