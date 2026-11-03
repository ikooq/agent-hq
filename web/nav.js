// Agent HQ v3 — grid navigation: A* on a 0.25 m grid, line-of-sight smoothing, path cache.
// Pure JS (no Three.js) so tests can import it in Node.
export class NavGrid {
  constructor(layout, cell = 0.25) {
    this.cell = cell;
    this.ox = -2; this.oz = 0;                                   // grid starts outside the left wall (door approach)
    this.cols = Math.ceil((layout.W + 2) / cell); this.rows = Math.ceil(layout.D / cell);
    this.blocked = new Uint8Array(this.cols * this.rows);
    const R = 0.2;                                              // agent radius margin
    // outside the floor is blocked, except a corridor through the door
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      const x = this.ox + (c + .5) * cell, z = this.oz + (r + .5) * cell;
      const inFloor = x > 0.18 && x < layout.W - 0.18 && z > 0.18 && z < layout.D - 0.18;
      const inDoor = x <= 0.6 && x > -1.6 && Math.abs(z - layout.door.z) < layout.door.w / 2 - R;
      if (!inFloor && !inDoor) this.blocked[r * this.cols + c] = 1;
    }
    for (const o of layout.obstacles) this.blockRect(o.x0 - R * .5, o.z0 - R * .5, o.x1 + R * .5, o.z1 + R * .5);
    this.cache = new Map();
  }
  blockRect(x0, z0, x1, z1) {
    const c0 = Math.max(0, Math.floor((x0 - this.ox) / this.cell)), c1 = Math.min(this.cols - 1, Math.floor((x1 - this.ox) / this.cell));
    const r0 = Math.max(0, Math.floor((z0 - this.oz) / this.cell)), r1 = Math.min(this.rows - 1, Math.floor((z1 - this.oz) / this.cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.blocked[r * this.cols + c] = 1;
  }
  toCell(x, z) { return [Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.ox) / this.cell))), Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.oz) / this.cell)))]; }
  center(c, r) { return { x: this.ox + (c + .5) * this.cell, z: this.oz + (r + .5) * this.cell }; }
  free(c, r) { return c >= 0 && r >= 0 && c < this.cols && r < this.rows && !this.blocked[r * this.cols + c]; }
  walkableAt(x, z) { const [c, r] = this.toCell(x, z); return this.free(c, r); }
  nearestFree(c, r) {
    if (this.free(c, r)) return [c, r];
    for (let d = 1; d < 12; d++) for (let dr = -d; dr <= d; dr++) for (let dc = -d; dc <= d; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== d) continue;
      if (this.free(c + dc, r + dr)) return [c + dc, r + dr];
    }
    return [c, r];
  }
  // A* with octile heuristic, no corner cutting. Returns cells or null.
  astar(sc, sr, gc, gr) {
    const N = this.cols * this.rows, cols = this.cols;
    const g = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const heap = [], push = (i, f) => { heap.push([f, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
    const h = (c, r) => { const dx = Math.abs(c - gc), dy = Math.abs(r - gr); return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy); };
    const s = sr * cols + sc, goal = gr * cols + gc;
    g[s] = 0; push(s, h(sc, sr));
    const D8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
    let guard = 0;
    while (heap.length && guard++ < 60000) {
      const [, i] = pop(); if (closed[i]) continue; closed[i] = 1;
      if (i === goal) break;
      const c = i % cols, r = (i - c) / cols;
      for (const [dc, dr, cost] of D8) {
        const nc = c + dc, nr = r + dr; if (!this.free(nc, nr)) continue;
        if (dc && dr && (!this.free(c + dc, r) || !this.free(c, r + dr))) continue;   // no corner cutting
        const j = nr * cols + nc, ng = g[i] + cost;
        if (ng < g[j]) { g[j] = ng; from[j] = i; push(j, ng + h(nc, nr)); }
      }
    }
    if (from[goal] < 0 && goal !== s) return null;
    const cells = []; for (let i = goal; i >= 0; i = from[i]) { cells.push([i % cols, Math.floor(i / cols)]); if (i === s) break; }
    return cells.reverse();
  }
  lineFree(a, b) {   // walkable straight segment between two cells (sampled at quarter-cell steps)
    const [ax, az] = [a.x, a.z], [bx, bz] = [b.x, b.z];
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / (this.cell * .25));
    for (let k = 0; k <= n; k++) { const t = k / Math.max(1, n); if (!this.walkableAt(ax + (bx - ax) * t, az + (bz - az) * t)) return false; }
    return true;
  }
  // world points from -> to; cached by cell pair
  path(from, to) {
    let [sc, sr] = this.toCell(from.x, from.z), [gc, gr] = this.toCell(to.x, to.z);
    [sc, sr] = this.nearestFree(sc, sr); [gc, gr] = this.nearestFree(gc, gr);
    const key = `${sc},${sr}>${gc},${gr}`;
    let pts = this.cache.get(key);
    if (!pts) {
      const cells = this.astar(sc, sr, gc, gr);
      if (!cells) pts = [];
      else {
        const raw = cells.map(([c, r]) => this.center(c, r));
        pts = [raw[0]];                                         // string-pulling: keep only turning points with line of sight
        let anchor = raw[0];
        for (let i = 2; i < raw.length; i++) if (!this.lineFree(anchor, raw[i])) { anchor = raw[i - 1]; pts.push(anchor); }
        if (raw.length > 1) pts.push(raw[raw.length - 1]);
      }
      if (this.cache.size > 2000) this.cache.clear();
      this.cache.set(key, pts);
    }
    if (!pts.length) return null;
    const out = pts.map(p => ({ x: p.x, z: p.z }));
    out.push({ x: to.x, z: to.z });                               // finish exactly on the spot
    return out;
  }
}
