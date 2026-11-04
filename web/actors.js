// Agent HQ v3 — agents: behaviour (status -> places to go), A* walking, instanced rendering.
import * as THREE from 'three';
import { RoundedBoxGeometry } from '/vendor/RoundedBoxGeometry.js';
import { placeFor, restsInLounge } from '/web/behavior.js';
import { Builder, Billboards, billboardMaterial, atlasMaterial, botColor, STATUS_HEX, TEAM_HEX, rr } from '/web/world.js';

const CAP = 64;
const fmtTok = n => { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)); };
const STATUS_CSS = { working: '#3fae7c', running: '#3f9fae', waiting: '#e39a2d', stuck: '#e0565f', resting: '#7d98df', off: '#9a94a6' };
const lerpAngle = (a, b, t) => { let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); return a + d * t; };
const _m = new THREE.Matrix4(), _r = new THREE.Matrix4(), _p = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
const Y = new THREE.Vector3(0, 1, 0);
// reusable temporaries: nothing is allocated in the per-frame loop
const _eu = new THREE.Euler(), _tr = new THREE.Matrix4(), _c2 = new THREE.Color(), _c3 = new THREE.Color();
const C_STUCK = new THREE.Color(0xff5a64), C_WAIT = new THREE.Color(0xffc060), C_WHITE = new THREE.Color(0xffffff), C_DARK = new THREE.Color(0x4a4058);
const SIDES = [[0, -1], [1, 1]];
const TRY = [[1, 0], [1, 30], [.8, 0], [.8, 26], [.8, -26]];   // tag placement attempts: [scale, lift px]
const FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2 + 0.75);   // desk plaque leaning back like a tent card
const setPart = (m, mesh, i, x, y, z, rx = 0, rz = 0, ry = 0) => { _p.makeRotationFromEuler(_eu.set(rx, ry, rz)); _p.setPosition(x, y, z); _r.multiplyMatrices(m, _p); mesh.setMatrixAt(i, _r); };

function faceAtlas() {
  const kinds = ['happy', 'focus', 'closed', 'worried', 'error'], SW = 128, SH = 88;
  const c = document.createElement('canvas'); c.width = SW * kinds.length; c.height = SH;
  const g = c.getContext('2d');
  kinds.forEach((k, i) => {
    g.save(); g.translate(i * SW, 0);
    const bg = g.createLinearGradient(0, 0, 0, SH); bg.addColorStop(0, '#30344f'); bg.addColorStop(1, '#22253a'); rr(g, 2, 2, SW - 4, SH - 4, 20); g.fillStyle = bg; g.fill();
    const eye = { happy: '#9ff3e0', focus: '#9ff3e0', closed: '#b9c6ff', worried: '#ffd27a', error: '#ff8a8f' }[k];
    g.fillStyle = eye; g.strokeStyle = eye; g.lineCap = 'round'; g.shadowColor = eye; g.shadowBlur = 8; const L = 42, R = 86, Yy = 40;
    if (k === 'happy') { for (const x of [L, R]) { g.beginPath(); g.ellipse(x, Yy, 9, 12, 0, 0, 7); g.fill(); } g.lineWidth = 4; g.beginPath(); g.arc(64, 56, 11, .2 * Math.PI, .8 * Math.PI); g.stroke(); }
    if (k === 'focus') { for (const x of [L, R]) { g.beginPath(); g.ellipse(x, Yy + 4, 10, 6, 0, 0, 7); g.fill(); } g.lineWidth = 4; g.beginPath(); g.moveTo(56, 64); g.lineTo(72, 64); g.stroke(); }
    if (k === 'closed') { g.lineWidth = 5; for (const x of [L, R]) { g.beginPath(); g.arc(x, Yy, 9, .15 * Math.PI, .85 * Math.PI); g.stroke(); } }
    if (k === 'worried') { for (const x of [L, R]) { g.beginPath(); g.arc(x, Yy + 2, 9, 0, 7); g.fill(); } g.lineWidth = 4; g.beginPath(); g.arc(64, 66, 7, 0, 7); g.stroke(); }
    if (k === 'error') { g.lineWidth = 5; for (const x of [L, R]) { g.beginPath(); g.moveTo(x - 8, Yy - 8); g.lineTo(x + 8, Yy + 8); g.moveTo(x + 8, Yy - 8); g.lineTo(x - 8, Yy + 8); g.stroke(); } }
    g.restore();
  });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.flipY = false; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter;
  const rects = {}; kinds.forEach((k, i) => rects[k] = [i / kinds.length, 1, 1 / kinds.length, -1]);
  return { tex: t, rects };
}

export class Actors {
  constructor(world) {
    this.w = world; this.agents = new Map(); this.pathQueue = []; this.first = true; this.finishedSeen = new Map(); this.boardCards = [];
    const G = new THREE.Group(); world.scene.add(G); this.group = G;
    const std = () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .45, metalness: .05 });
    const inst = (geo, mat, cap = CAP) => { const m = new THREE.InstancedMesh(geo, mat, cap); m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; m.count = 0; G.add(m); return m; };
    // robot parts (shared geometry, one draw call each)
    const head = new Builder(); head.add(new RoundedBoxGeometry(.46, .36, .38, 3, .1), 0xffffff, 0, 0, 0); head.cyl(.012, .012, .12, 5, 0xffffff, 0, .24, 0);
    this.m = {
      body: inst(new THREE.CapsuleGeometry(.2, .14, 4, 12), std()),
      head: inst(head.geometry(), std()),
      limb: inst(new THREE.CapsuleGeometry(.055, .15, 3, 8), std(), CAP * 4),
      bulb: inst(new THREE.SphereGeometry(.045, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff })),
    };
    for (const k of ['body', 'head', 'limb']) this.m[k].castShadow = false;
    this.faces = faceAtlas();
    const fg = new THREE.PlaneGeometry(.36, .25); this.faceRect = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4); this.faceRect.setUsage(THREE.DynamicDrawUsage); fg.setAttribute('atlasRect', this.faceRect);
    this.m.face = inst(fg, atlasMaterial(new THREE.MeshBasicMaterial({ map: this.faces.tex, toneMapped: false })));
    this.m.blob = inst(new THREE.PlaneGeometry(.8, .8), new THREE.MeshBasicMaterial({ map: world.tex.blob, transparent: true, depthWrite: false }));
    this.m.blob.renderOrder = 3;
    // billboards: tags + chips (atlases), icons, glows, cards
    this.tags = new Billboards(billboardMaterial(world.atlases.tags.tex), CAP, 20);
    // model + token chips: flat plaques lying on each desk (depth-tested, never on top of robots or labels)
    const cg = new THREE.PlaneGeometry(.78, .27); this.chipRect = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4); cg.setAttribute('atlasRect', this.chipRect);
    this.chipMesh = inst(cg, atlasMaterial(new THREE.MeshBasicMaterial({ map: world.atlases.chips.tex, transparent: true, toneMapped: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
    this.chipMesh.renderOrder = 4;
    this.chipBB = new Billboards(billboardMaterial(world.atlases.chips.tex), 4, 19); G.add(this.chipBB.mesh);
    this.icons = new Billboards(billboardMaterial(world.icons.tex), CAP, 21);
    this.glow = new Billboards(billboardMaterial(world.icons.tex, { additive: true, depthTest: true }), CAP, 15);
    this.cards = new Billboards(billboardMaterial(world.icons.tex, { depthTest: true }), CAP, 16);
    this.taskBB = new Billboards(billboardMaterial(world.atlases.tasks.tex), CAP, 20);
    for (const b of [this.tags, this.icons, this.glow, this.cards, this.taskBB]) G.add(b.mesh);
    this.taskSlots = new Map();
    this.tagSlots = new Map(); this.chipSlots = new Map(); this.tagQ = [];
  }

  setLayout(L, nav) {
    this.L = L; this.nav = nav; this.pathQueue = [];
    for (const a of this.agents.values()) { a.goalKey = null; a.path = []; }   // re-plan with the new grid
    this.boardCards.length = Math.min(this.boardCards.length, 24);
  }

  // ---------- spots ----------
  deskFor(botId, i) { return this.L.desks.find(d => d.botId === botId && d.index === i) || this.L.desks.find(d => d.botId === botId); }
  // ---------- sync with server state ----------
  sync(state) {
    if (!this.L) return;
    this.state = state; this.desksDirty = true;
    const live = new Set(), t = performance.now();
    const queueOrder = [], resting = [], meetingParents = [];
    for (const b of state.bots) b.robots.forEach((r, i) => {
      live.add(r.key);
      let a = this.agents.get(r.key);
      if (!a) {
        a = this.spawn(r.key, { kind: 'robot', color: botColor(b, i), scale: r.kind === 'subagent' ? 1.1 : 1.35 });
        a.lastFinished = Math.max(0, ...state.finished.filter(f => f.sessionId === r.id).map(f => f.time));
      }
      a.bot = b; a.r = r; a.botId = b.id; a.label = r.label; a.desk = this.deskFor(b.id, i);
      const prev = a.status; a.status = r.status;
      // finished a reply -> report to the lead, pin the card on the Done board, then lounge
      const fin = state.finished.find(f => f.sessionId === r.id && f.time > a.lastFinished);
      if (fin) {
        a.lastFinished = fin.time;
        if (!this.first && r.status === 'resting' && a.placed) {
          a.tasks = [
            { spot: this.L.lead.reportSpot, pose: 'stand', hold: 1.8, icon: 'report', carry: true },
            { spot: this.L.boardSpot, pose: 'stand', hold: 1.0, icon: 'check', carry: true, onDone: () => this.pinCard(a) },
          ];
          // finished before it ever reached its desk (fast reply): sit down at the desk first, then report
          if (!a.sawDesk && a.desk) a.tasks.unshift({ spot: { ...a.desk.seat }, pose: 'sit', hold: 1.5, icon: null });
        } else this.pinCard(a, true);
      }
      if (r.status !== 'resting' && a.tasks && a.tasks.length && prev === 'resting') a.tasks = [];
      if (r.status === 'waiting') queueOrder.push(a);
      if (restsInLounge(r.status, r.turn)) resting.push(a);
      if ((r.helpers || []).length >= 2) meetingParents.push(a);
      // helpers (subagents) walk in from the door
      const hkeys = new Set();
      (r.helpers || []).slice(0, 4).forEach((h, hi) => {
        const hk = 'helper:' + h.id; hkeys.add(hk); live.add(hk);
        let ha = this.agents.get(hk);
        if (!ha) { ha = this.spawn(hk, { kind: 'helper', color: botColor({ id: h.type, team: (state.bots.find(x => x.agentType === h.type) || b).team }), scale: .85 }); }
        ha.parent = a; ha.helperIndex = hi; ha.label = h.type; ha.status = h.status === 'running' ? 'running' : 'working'; ha.r = { step: h.step };
      });
      a.helperKeys = hkeys;
    });
    // queue at the kiosk: oldest request first
    queueOrder.sort((p, q) => (p.r.statusSince || 0) - (q.r.statusSince || 0)).forEach((a, i) => { a.queueIndex = i; });
    // lounge: keep previous spots, fill the rest
    const pool = [...this.L.lounge.sofaSeats.map(s => ({ ...s, pose: 'sit', seatH: .5 })), { ...this.L.lounge.armSeat, pose: 'sit', seatH: .46 }, ...this.L.lounge.coffeeSpots.map(s => ({ ...s, pose: 'stand' })), ...this.L.lounge.stand.map(s => ({ ...s, pose: 'stand' }))];
    const taken = new Set();
    for (const a of resting) if (a.loungeIdx != null && !taken.has(a.loungeIdx)) taken.add(a.loungeIdx); else a.loungeIdx = null;
    for (const a of resting.sort((p, q) => p.key.localeCompare(q.key))) if (a.loungeIdx == null) { let k = 0; while (taken.has(k) && k < pool.length - 1) k++; a.loungeIdx = k; taken.add(k); }
    this.loungePool = pool;
    // meeting room: parents with 2+ helpers bring them along
    let seat = 0; this.meetingSeat = new Map();
    for (const p of meetingParents) { if (seat >= this.L.meeting.seats.length) break; this.meetingSeat.set(p.key, seat++); for (const hk of p.helperKeys) if (seat < this.L.meeting.seats.length) this.meetingSeat.set(hk, seat++); }
    // whoever is no longer live walks out of the door
    for (const [k, a] of this.agents) if (!live.has(k) && a.kind !== 'lead' && !a.leaving) { a.leaving = true; a.tasks = []; a.goalKey = null; }
    if (this.first) { this.boardCards = state.finished.slice(0, 24).reverse().map(f => { const b = state.bots.find(x => x.id === f.botId); return { color: b ? botColor(b, 0) : new THREE.Color(0xdddddd), t: 0, instant: true }; }); }
    if (!this.agents.has('lead')) { const L = this.L.lead.supervisor; const a = this.spawn('lead', { kind: 'lead', color: new THREE.Color(0xf2c96d), scale: 1.35 }); a.label = 'You'; a.status = 'working'; a.pos.x = L.x; a.pos.z = L.z; a.yaw = 0; a.pose = 'sit'; a.sit = 1; a.placed = true; }
    this.first = false;
  }
  spawn(key, o) {
    const s = this.L.spawn;
    const a = { key, kind: o.kind, color: o.color, scale: o.scale, pos: { x: s.x, z: s.z }, yaw: Math.PI / 2, path: [], pose: 'stand', sit: 0, walkT: 0, tasks: [],
      status: 'working', goalKey: null, placed: false, holdUntil: 0, blinkAt: 0, appear: this.first ? 1 : 0, wait: 0 };
    a.initial = this.first;
    this.agents.set(key, a); return a;
  }
  pinCard(a, instant) { this.boardCards.push({ color: a.color.clone(), t: performance.now(), instant }); if (this.boardCards.length > 24) this.boardCards.shift(); }

  // where should this agent be right now?
  homeSpot(a) {
    const L = this.L;
    const place = placeFor({ kind: a.kind, status: a.status, turn: a.r && a.r.turn, leaving: a.leaving, hasTask: a.tasks.length > 0, inMeeting: !!(this.meetingSeat && this.meetingSeat.has(a.key)) });
    a.place = place;
    if (place === 'door') return { ...L.spawn, pose: 'stand', facing: -Math.PI / 2, key: 'out' };
    if (place === 'lead') return { ...L.lead.supervisor, pose: 'sit', key: 'lead' };
    if (place === 'task') { const t = a.tasks[0]; return { ...t.spot, pose: t.pose, facing: t.spot.facing, key: 'task:' + a.tasks.length + ':' + t.icon }; }
    if (place === 'meeting') { const s = L.meeting.seats[this.meetingSeat.get(a.key)]; return { ...s, pose: 'sit', key: 'meet' + this.meetingSeat.get(a.key) }; }
    if (place === 'helper') {
      const d = a.parent && a.parent.desk; if (!d) return { ...L.inside, pose: 'stand', key: 'in' };
      return { x: d.seat.x - .5 + (a.helperIndex || 0) * .5, z: d.seat.z + .85, facing: Math.PI, pose: 'stand', key: 'help:' + d.botId + (a.helperIndex || 0) };
    }
    if (place === 'queue') { const q = L.queue[Math.min(a.queueIndex || 0, L.queue.length - 1)]; return { ...q, pose: 'stand', key: 'q' + a.queueIndex }; }
    if (place === 'lounge' && this.loungePool) { const s = this.loungePool[a.loungeIdx || 0]; return { x: s.x, z: s.z, facing: s.facing, pose: s.pose, seatH: s.seatH, key: 'lounge' + a.loungeIdx }; }
    const d = a.desk; if (!d) return { ...L.inside, pose: 'stand', key: 'in' };
    return { x: d.seat.x, z: d.seat.z, facing: d.seat.facing, pose: 'sit', key: 'desk:' + d.botId + d.index };
  }

  // ---------- per-frame simulation ----------
  update(dt, t, now) {
    if (!this.L) return false;
    // path requests: spend at most ~4 ms per frame on A* (first lookups only; repeats are cached)
    const t0 = performance.now();
    while (this.pathQueue.length && performance.now() - t0 < 4) {
      const a = this.pathQueue.shift(); if (!this.agents.has(a.key)) continue;
      const p = this.nav.path(a.pos, a.goal); a.path = p ? p : [{ x: a.goal.x, z: a.goal.z }]; a.pending = false;   // full path: first leg goes to a validated cell centre
    }
    let walking = false;
    const list = [...this.agents.values()];
    for (const a of list) {
      const h = this.homeSpot(a);
      if (h.key !== a.goalKey || Math.abs((a.goal?.x ?? 1e9) - h.x) > .01 || Math.abs((a.goal?.z ?? 1e9) - h.z) > .01) {
        a.goalKey = h.key; a.goal = h; a.arrived = false; a.holdUntil = 0;
        if (a.initial && !a.placed) { a.sawDesk = true; a.pos.x = h.x; a.pos.z = h.z; a.yaw = h.facing ?? 0; a.path = []; a.placed = true; a.arrived = true; a.sit = h.pose === 'sit' ? 1 : 0; }
        else { a.path = []; a.pending = true; this.pathQueue.push(a); }
      }
      // walk
      if (a.path.length) {
        const p = a.path[0], dx = p.x - a.pos.x, dz = p.z - a.pos.z, dist = Math.hypot(dx, dz);
        let speed = (a.kind === 'helper' ? 2.3 : 2.0) * dt;
        // simple avoidance: yield to an agent just ahead (never forever)
        for (const o of list) { if (o === a || !o.placed) continue; const ox = o.pos.x - a.pos.x, oz = o.pos.z - a.pos.z, od = Math.hypot(ox, oz);
          if (od < .5 && (ox * dx + oz * dz) > 0 && o.key < a.key && a.wait < 1.0) { speed = 0; a.wait += dt; break; } }
        if (speed) a.wait = Math.max(0, a.wait - dt);
        if (dist <= speed) { a.pos.x = p.x; a.pos.z = p.z; a.path.shift(); } else if (speed) { a.pos.x += dx / dist * speed; a.pos.z += dz / dist * speed; }
        if (dist > .02) a.yaw = lerpAngle(a.yaw, Math.atan2(dx, dz), Math.min(1, dt * 10));
        a.walkT += dt * 10; a.moving = true; walking = true; a.placed = true;
        a.sit = Math.max(0, a.sit - dt * 5);
      } else if (!a.pending) {
        a.moving = false;
        if (!a.arrived) { a.arrived = true; if (a.goalKey && (a.goalKey.startsWith('desk') || (a.tasks.length && a.tasks[0].pose === 'sit' && !a.tasks[0].icon))) a.sawDesk = true; if (a.tasks.length && a.tasks[0].hold) a.holdUntil = now + a.tasks[0].hold * 1000; }
        if (a.goal && a.goal.facing != null) a.yaw = lerpAngle(a.yaw, a.goal.facing, Math.min(1, dt * 8));
        const wantSit = a.goal && a.goal.pose === 'sit';
        a.sit += ((wantSit ? 1 : 0) - a.sit) * Math.min(1, dt * 6);
        if (a.tasks.length && a.holdUntil && now >= a.holdUntil) { const done = a.tasks.shift(); done.onDone && done.onDone(); a.holdUntil = 0; a.goalKey = null; }
        if (a.leaving && a.goalKey === 'out') { this.agents.delete(a.key); continue; }
      }
      a.appear = Math.min(1, a.appear + dt * 3);
    }
    return walking;
  }

  // ---------- rendering ----------
  render(t, now) {
    const w = this.w, px = w.pxScale(), m = this.m;
    for (const b of [this.tags, this.icons, this.glow, this.cards, this.taskBB]) { b.begin(); b.mesh.material.uniforms.pxScale.value = px; }
    this.glow.mesh.material.uniforms.pxScale.value = 1; this.cards.mesh.material.uniforms.pxScale.value = 1;
    let n = 0, ln = 0;
    for (const a of this.agents.values()) {
      if (n >= CAP) break;
      const sc = a.scale * (0.6 + 0.4 * a.appear), sit = a.sit, st = a.status, tt = t + (a.key.length % 7) * .37;
      const seatY = Math.max(0, ((a.goal && a.goal.seatH) ?? .54) - .3 * a.scale);
      const rigY = sit * seatY + (a.moving ? Math.abs(Math.sin(a.walkT)) * .03 : 0);
      _q.setFromAxisAngle(Y, a.yaw); _m.compose(_v.set(a.pos.x, rigY, a.pos.z), _q, _s.set(sc, sc, sc));
      // body / head
      const typing = st === 'working' && !a.moving && sit > .5 && a.kind !== 'lead';
      setPart(_m, m.body, n, 0, .5, 0);
      const headTilt = st === 'resting' ? .28 : typing ? .12 : st === 'running' ? .18 : st === 'waiting' ? -.12 : 0;
      setPart(_m, m.head, n, 0, .92, 0, headTilt);
      setPart(_m, m.face, n, 0, .92 + Math.sin(-headTilt) * .02, .195, headTilt);
      setPart(_m, m.bulb, n, 0, 1.2, 0);
      // limbs: legs (hips), arms (shoulders)
      const swing = a.moving ? Math.sin(a.walkT) * .7 : 0;
      for (const [k, side] of SIDES) {
        const legA = -swing * side * 0 + (a.moving ? swing * side : -Math.PI / 2 * sit);
        _p.makeRotationX(legA); _p.setPosition(side * .1, .3, 0); _r.multiplyMatrices(_m, _p); _r.multiply(_tr.makeTranslation(0, -.13, 0)); m.limb.setMatrixAt(ln++, _r);
        let armA = a.moving ? -swing * side : 0, armZ = 0;
        if (typing) armA = -1.2 + Math.sin(tt * 18 + k * 1.9) * .15;
        else if (st === 'running' && sit > .5) armA = -.9;
        else if (st === 'waiting' && !a.moving && k === 1) { armZ = 2.6 + Math.sin(tt * 6) * .35; }
        else if (a.tasks && a.tasks.length && a.tasks[0].carry && !a.moving) armA = -.9;
        _p.makeRotationFromEuler(_eu.set(armA, 0, armZ * side)); _p.setPosition(side * .26, .64, 0); _r.multiplyMatrices(_m, _p); _r.multiply(_tr.makeTranslation(0, -.12, 0)); m.limb.setMatrixAt(ln++, _r);
      }
      // colours: body tint per status
      _c.copy(a.color);
      if (st === 'stuck' && a.kind !== 'lead') _c.lerp(C_STUCK, .55 + .15 * Math.sin(t * 5));
      if (st === 'waiting' && !a.moving) _c.lerp(C_WAIT, .35 + .2 * Math.sin(t * 4));
      // colours: re-upload only when they changed (pulsing tints refresh at ~12 Hz)
      const pulse = (st === 'stuck' || (st === 'waiting' && !a.moving)) ? Math.floor(now / 80) : 0;
      const ck = a.colorKey !== n + '|' + st + '|' + pulse + '|' + a.moving;
      if (ck || !m.body.instanceColor) {
        a.colorKey = n + '|' + st + '|' + pulse + '|' + a.moving; this.colorsDirty = true;
        m.body.setColorAt(n, _c); m.head.setColorAt(n, _c2.copy(_c).lerp(C_WHITE, .35));
        const limbC = _c3.copy(_c).lerp(C_DARK, .2); m.limb.setColorAt(ln - 4, limbC); m.limb.setColorAt(ln - 3, limbC); m.limb.setColorAt(ln - 2, limbC); m.limb.setColorAt(ln - 1, limbC);
        m.bulb.setColorAt(n, _c.setHex(STATUS_HEX[st] || 0xffffff));
      }
      // face expression (+ blink)
      let expr = st === 'resting' ? 'closed' : st === 'stuck' ? 'error' : st === 'waiting' ? 'worried' : (typing || st === 'running') ? 'focus' : 'happy';
      if ((expr === 'happy' || expr === 'focus') && (now % 3700) < 120) expr = 'closed';
      const fr = this.faces.rects[expr], fa = this.faceRect.array, fj = n * 4;
      if (fa[fj] !== fr[0] || fa[fj + 1] !== fr[1]) { fa.set(fr, fj); this.facesDirty = true; }
      // blob shadow
      _p.makeRotationX(-Math.PI / 2); _p.setPosition(a.pos.x, .025, a.pos.z); _p.scale(_s.set(sc, sc, sc)); m.blob.setMatrixAt(n, _p);
      // tag above the head (fixed pixel size, atlas slot redrawn only when text changes)
      const headY = rigY + 1.38 * sc;
      if (!a.tagRect || a.tagKey !== a.label + a.status + (this.selected === a.key)) this.refreshTag(a);
      // queue the tag; placement (no overlaps) happens after the loop
      const q = this.tagQ[n] || (this.tagQ[n] = {}); q.a = a; q.x = a.pos.x; q.y = headY + .1; q.z = a.pos.z; q.icon = null;
      q.pri = this.selected === a.key ? 9 : (st === 'waiting' || st === 'stuck') ? 8 : a.kind === 'lead' ? 6 : (st === 'working' || st === 'running') && a.kind !== 'helper' ? 7 : a.kind === 'helper' ? 1 : 3;
      // status icon above the tag
      const icon = a.tasks && a.tasks.length && !a.moving && a.arrived ? a.tasks[0].icon : st === 'stuck' ? 'bang' : st === 'waiting' && !a.moving ? 'q' : st === 'resting' && !a.moving ? 'zzz' : st === 'running' && !a.moving ? 'spin' + (Math.floor(t * 8) % 4) : null;
      if (icon && !this.w.icons.rects[icon] && !this.warnedIcon) { this.warnedIcon = true; console.warn('icon without rect: ' + icon + ' agent ' + a.key + ' status ' + st); }
      if (icon && a.kind !== 'lead') q.icon = this.w.icons.rects[icon];
      // task card: first line of the last prompt, above robots that are on a task
      q.task = null;
      const task = a.kind === 'robot' && a.r && a.r.task && (st === 'working' || st === 'running' || st === 'stuck' || st === 'waiting') ? a.r.task : null;
      if (task) { if (a.taskKey !== task || !a.taskRect) this.refreshTask(a, task); q.task = a.taskRect; q.taskW = a.taskW; }
      // glows (off in Low quality)
      if (this.w.glowOn) {
        if (st === 'waiting' && a.kind !== 'helper') this.glow.push(a.pos.x, .6 + rigY, a.pos.z, 1.8, 1.8, this.w.icons.rects.glow, 1, 1, 1, .55 + .25 * Math.sin(t * 4));
        if (st === 'stuck') this.glow.push(a.pos.x, .6 + rigY, a.pos.z, 1.3, 1.3, this.w.icons.rects.glowRed, 1, 1, 1, .5);
      }
      // carried task card
      if (a.kind === 'robot' && (st === 'waiting' || (a.tasks && a.tasks.length && a.tasks[0].carry))) {
        const fx = Math.sin(a.yaw) * .28, fz = Math.cos(a.yaw) * .28;
        this.cards.push(a.pos.x + fx, .62 + rigY, a.pos.z + fz, .3, .3, this.w.icons.rects.card, 1, 1, 1, 1);
      }
      n++;
    }
    this.placeTags(n);
    this.chipBB.begin(); this.chipBB.mesh.material.uniforms.pxScale.value = px;
    for (const k of [this.selected, this.hovered]) { const ag = k && this.agents.get(k); if (!ag || !ag.botId || (k === this.hovered && k === this.selected && ag !== this.agents.get(this.hovered))) continue;
      const c = (this.chipList || []).find(x => x.botId === ag.botId); if (c && !(k === this.hovered && this.hovered === this.selected)) this.chipBB.push(c.x, .9, c.z, 150, 52, c.rect, 1, 1, 1, 1, 0, 10); }
    this.chipBB.end();
    const up = (attr, count, size) => { if (!attr) return; attr.clearUpdateRanges(); attr.addUpdateRange(0, Math.max(1, count) * size); attr.needsUpdate = true; };
    for (const k of ['body', 'head', 'face', 'bulb', 'blob']) { m[k].count = n; up(m[k].instanceMatrix, n, 16); }
    m.limb.count = ln; up(m.limb.instanceMatrix, ln, 16);
    if (this.colorsDirty) { for (const k of ['body', 'head', 'bulb']) up(m[k].instanceColor, n, 3); up(m.limb.instanceColor, ln, 3); this.colorsDirty = false; }
    if (this.facesDirty) { up(this.faceRect, n, 4); this.facesDirty = false; }
    // static glows: lamps + kiosk screen (+ busy monitors)
    if (this.w.glowOn) {
      const lamp = this.w.skyState ? this.w.skyState.lamp : .5;
      for (const p of this.w.lampPos || []) this.glow.push(p.x, p.y, p.z, 2.6, 2.6, this.w.icons.rects.lamp, 1, 1, 1, .35 + lamp * .6);
      if (this.w.kioskGlow) this.glow.push(this.w.kioskGlow.x, this.w.kioskGlow.y, this.w.kioskGlow.z, 1.4, 1.4, this.w.icons.rects.glow, 1, 1, 1, .45 + (this.state && this.state.counts.waiting ? .4 * Math.abs(Math.sin(t * 3)) : 0));
    }
    // done board: pinned cards
    const br = this.w.boardRect;
    if (br) this.boardCards.forEach((c, i) => { const col = i % 6, row = Math.floor(i / 6); this.cards.push(br.x0 + .14 + col * .27, br.y1 - .14 - row * .24, br.z + .02, .22, .22, this.w.icons.rects.card, c.color.r * .6 + .4, c.color.g * .6 + .4, c.color.b * .6 + .4, 1); });
    if (this.desksDirty || now - (this.desksAt || 0) > 1000) { this.desksDirty = false; this.desksAt = now; this.refreshDesks(); }
    for (const b of [this.tags, this.icons, this.glow, this.cards, this.taskBB]) b.end();
  }
  // Name tags stay on top but never overlap: higher priority first (selected, waiting/stuck, working);
  // a colliding tag is nudged up, then shrunk; low-priority tags (resting, helpers) are hidden if they still collide.
  placeTags(n) {
    const cam = this.w.camera, W = innerWidth, H = this.w.viewH || innerHeight, placed = this.placed || (this.placed = []);
    placed.length = 0;
    const list = this.tagSort || (this.tagSort = []); list.length = 0;
    for (let i = 0; i < n; i++) { const q = this.tagQ[i]; _v.set(q.x, q.y, q.z).project(cam); q.sx = (_v.x * .5 + .5) * W; q.sy = (-_v.y * .5 + .5) * H; list.push(q); }
    list.sort((p, r) => r.pri - p.pri);
    const hit = (x, y, w, h) => { for (let k = 0; k < placed.length; k += 4) if (Math.abs(x - placed[k]) * 2 < w + placed[k + 2] && Math.abs(y - placed[k + 1]) * 2 < h + placed[k + 3]) return true; return false; };
    for (const q of list) {
      const a = q.a, base = a.kind === 'helper' ? .8 : 1;
      let s = base, oy = 0, ok = false;
      for (const [ss, dy] of TRY) { s = base * ss; oy = dy; if (!hit(q.sx, q.sy - oy, 132 * s, 34 * s)) { ok = true; break; } }
      if (!ok && q.pri < 6) continue;                 // resting agents / helpers: hide when crowded
      if (!ok) { s = base * .75; oy = 0; }           // working / waiting / stuck: always shown
      placed.push(q.sx, q.sy - oy, 132 * s, 34 * s);
      this.tags.push(q.x, q.y, q.z, 128 * s, 32 * s, a.tagRect, 1, 1, 1, a.appear, 0, oy);
      if (q.icon) { placed.push(q.sx, q.sy - oy - 34 * s, 36 * s, 36 * s); this.icons.push(q.x, q.y, q.z, 34 * s, 34 * s, q.icon, 1, 1, 1, 1, 0, oy + 34 * s); }
      if (q.task && q.pri >= 7) {   // only robots on a task; hidden when it would cover another tag
        const ty = oy + (q.icon ? 70 : 34) * s, tw = (q.taskW || 200) * s;
        if (!hit(q.sx, q.sy - ty, tw, 28 * s) || q.pri === 9) { placed.push(q.sx, q.sy - ty, tw, 28 * s); this.taskBB.push(q.x, q.y, q.z, 256 * s, 32 * s, q.task, 1, 1, 1, a.appear, 0, ty); }
      }
    }
  }
  refreshTag(a) {   // repaint this agent's name tag (only when label / status / selection changed)
    const atlas = this.w.atlases.tags, slot = this.slotFor(this.tagSlots, a.key, atlas), sel = this.selected === a.key, st = a.status, label = a.label || '';
    a.tagKey = label + st + sel; a.tagRect = slot < 0 ? null : atlas.rect(slot);
    if (slot < 0) return;                                  // atlas full (more agents than CAP): no tag rather than a shared slot
    atlas.draw(slot, a.tagKey, (g, W, H) => {
      g.font = `${a.kind === 'helper' ? 600 : 700} 30px Segoe UI, sans-serif`; const tw = Math.min(W - 54, g.measureText(label).width);
      const pw = tw + 52, x0 = (W - pw) / 2; rr(g, x0, 6, pw, H - 12, 24); g.fillStyle = sel ? 'rgba(58,51,70,.94)' : 'rgba(255,252,247,.94)'; g.fill();
      g.lineWidth = 3; g.strokeStyle = STATUS_CSS[st] || '#999'; g.stroke();
      g.fillStyle = STATUS_CSS[st] || '#999'; g.beginPath(); g.arc(x0 + 22, H / 2, 8, 0, 7); g.fill();
      g.fillStyle = sel ? '#fff' : '#3a3346'; g.textBaseline = 'middle'; g.fillText(label, x0 + 38, H / 2 + 1, W - 54);
    });
  }
  refreshTask(a, task) {   // paper task card with the prompt's first line (slot redrawn only when the text changes)
    const atlas = this.w.atlases.tasks, slot = this.slotFor(this.taskSlots, a.key, atlas);
    a.taskKey = task; a.taskRect = slot < 0 ? null : atlas.rect(slot);
    if (slot < 0) return;
    atlas.draw(slot, task, (g, W, H) => {
      g.font = '600 25px Segoe UI, sans-serif'; const tw = Math.min(W - 60, g.measureText(task).width), pw = tw + 50, x0 = (W - pw) / 2;
      a.taskW = pw / 2 + 4;
      g.shadowColor = 'rgba(40,30,50,.25)'; g.shadowBlur = 6; g.shadowOffsetY = 2;
      rr(g, x0, 8, pw, H - 16, 8); g.fillStyle = '#fffaf0'; g.fill(); g.shadowColor = 'transparent';
      g.fillStyle = '#e8b04a'; g.fillRect(x0 + 12, 16, 5, H - 32);            // tape strip
      g.fillStyle = '#4a4058'; g.textBaseline = 'middle'; g.fillText(task, x0 + 30, H / 2 + 1, W - 60);
    });
  }
  slotFor(map, key, atlas) { let s = map.get(key); if (s == null || s < 0) { s = atlas.alloc(); map.set(key, s); } return s; }
  gcSlots() {   // every 5 s: give back atlas slots of agents that left and bots that are gone
    for (const [k, s] of this.tagSlots) if (!this.agents.has(k)) { this.w.atlases.tags.release(s); this.tagSlots.delete(k); }
    for (const [k, s] of this.taskSlots) if (!this.agents.has(k)) { this.w.atlases.tasks.release(s); this.taskSlots.delete(k); }
    const bots = new Set(this.state ? this.state.bots.map(b => b.id) : []);
    for (const [id, s] of this.chipSlots) if (!bots.has(id)) { this.w.atlases.chips.release(s); this.chipSlots.delete(id); }
  }

  // desk monitors (atlas) + model chips
  refreshDesks() {
    const L = this.L, S = this.w.screens, st = this.state; if (!st || !S) return;
    const byKey = new Map(); for (const a of this.agents.values()) if (a.r && a.r.key) byKey.set(a.r.key, a);
    const botById = new Map(st.bots.map(x => [x.id, x])); this.chipList = []; this.maxTok = Math.max(1, ...st.bots.map(x => x.tokens.total));
    L.desks.forEach((d, i) => {
      const b = botById.get(d.botId); if (!b) return;
      const r = b.robots[d.index]; const a = r && byKey.get(r.key);
      const atDesk = a && !a.moving && a.goalKey && a.goalKey.startsWith('desk');
      const sts = !r ? 'off' : r.status;
      const timer = r && r.status === 'running' && r.runningSince ? Math.floor((Date.now() - r.runningSince) / 1000) : null;
      if (S.slots[i] == null || S.slots[i] < 0) S.slots[i] = this.w.atlases.screens.alloc();
      const slot = S.slots[i]; if (slot < 0) return;
      const key = `${sts}|${r ? r.step : ''}|${timer}|${atDesk}`;
      this.w.atlases.screens.draw(slot, key, (g, W, H) => this.paintScreen(g, W, H, b, r, sts, timer, atDesk));
      S.rect.array.set(this.w.atlases.screens.rect(slot), i * 4);
      // chip: model + tokens today (whole bot) on the first desk of each bot
      if (d.index === 0) {
        const cs = this.slotFor(this.chipSlots, d.botId, this.w.atlases.chips); if (cs < 0) return;
        const label = b.modelLabel, tok = b.tokens.total;
        this.w.atlases.chips.draw(cs, `${label}|${fmtTok(tok)}|${b.team}|${Math.round(100 * tok / (this.maxTok || 1))}`, (g, W, H) => {
          const col = '#' + new THREE.Color(b.source === 'codex' ? 0x2fa39d : (TEAM_HEX[b.team] ?? 0x9a94a6)).getHexString();
          rr(g, 2, 2, W - 4, H - 4, 14); g.fillStyle = 'rgba(255,252,247,.96)'; g.fill(); g.lineWidth = 3; g.strokeStyle = col; g.stroke();
          let fs = 30; g.font = `800 ${fs}px Segoe UI, sans-serif`; while (g.measureText(label).width > W - 36 && fs > 18) { fs--; g.font = `800 ${fs}px Segoe UI, sans-serif`; }
          rr(g, 8, 8, W - 16, 42, 10); g.fillStyle = col; g.fill();
          g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.textAlign = 'center'; g.fillText(label, W / 2, 30, W - 28);
          const maxT = this.maxTok || 1; g.fillStyle = 'rgba(80,60,100,.14)'; rr(g, 14, 64, W - 120, 12, 6); g.fill(); g.fillStyle = col; rr(g, 14, 64, Math.max(10, (W - 120) * Math.min(1, tok / maxT)), 12, 6); g.fill();
          g.fillStyle = '#3a3346'; g.font = '800 26px Segoe UI, sans-serif'; g.textAlign = 'right'; g.fillText(fmtTok(tok), W - 12, 71);
        });
        this.chipList.push({ botId: d.botId, x: d.desk.x + .45, z: d.desk.z + .26, rect: this.w.atlases.chips.rect(cs) });
      }
    });
    S.rect.needsUpdate = true;
    const key = this.chipList.map(c => c.x.toFixed(2) + c.z.toFixed(2) + c.rect.join()).join('|');
    if (key !== this.chipKey) {   // matrices change only with the layout
      this.chipKey = key;
      this.chipList.forEach((c, i) => { _p.compose(_v.set(c.x, .86, c.z), FLAT, _s.set(1, 1, 1)); this.chipMesh.setMatrixAt(i, _p); this.chipRect.array.set(c.rect, i * 4); });
      this.chipMesh.count = this.chipList.length; this.chipMesh.instanceMatrix.needsUpdate = true; this.chipRect.needsUpdate = true;
    }
  }
  paintScreen(g, W, H, b, r, sts, timer, atDesk) {
    const bg = { working: '#1f3a33', running: '#0f2a2f', waiting: '#3d2f18', stuck: '#3b1d24', resting: '#262a40', off: '#08080c' }[sts];
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    if (sts === 'off') return;
    const accent = { working: '#7fe0b3', running: '#7fd6e0', waiting: '#ffc864', stuck: '#ff8a8f', resting: '#a9b8ff' }[sts];
    g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(0, 0, W, 28);
    g.fillStyle = accent; g.font = '700 17px Segoe UI, sans-serif'; g.textBaseline = 'middle';
    g.fillText({ working: '● working', running: '▶ running', waiting: '? needs approval', stuck: '! stuck', resting: '☕ break' }[sts], 9, 15);
    g.fillStyle = 'rgba(255,255,255,.6)'; g.textAlign = 'right'; g.fillText(r.label, W - 9, 15, 110); g.textAlign = 'left';
    if (sts === 'running') {
      const grd = g.createRadialGradient(W / 2, H / 2 + 14, 4, W / 2, H / 2 + 14, W * .6); grd.addColorStop(0, 'rgba(80,220,200,.25)'); grd.addColorStop(1, 'rgba(80,220,200,0)'); g.fillStyle = grd; g.fillRect(0, 28, W, H - 28);
      g.fillStyle = '#c9fff3'; g.font = '600 16px Cascadia Mono, Consolas, monospace'; g.fillText('$ ' + r.step.replace(/^Running (\w+: )?/, '').slice(0, 26), 9, 52);
      if (timer != null) { g.fillStyle = accent; g.font = '700 30px Cascadia Mono, Consolas, monospace'; g.fillText(`${String(Math.floor(timer / 60)).padStart(2, '0')}:${String(timer % 60).padStart(2, '0')}`, 9, 92); }
      g.fillStyle = 'rgba(255,255,255,.15)'; g.fillRect(9, 124, W - 18, 8); g.fillStyle = accent; g.fillRect(9 + ((timer || 0) * 23) % (W - 60), 124, 42, 8);
      return;
    }
    g.fillStyle = '#f4f1ea'; g.font = '600 16px Cascadia Mono, Consolas, monospace';
    const words = String(sts === 'resting' && !atDesk ? 'on a break' : r.step).split(/\s+/); let line = '', y = 50;
    for (const wd of words) { const tl = line ? line + ' ' + wd : wd; if (g.measureText(tl).width > W - 18 && line) { g.fillText(line, 9, y); y += 21; line = wd; if (y > H - 14) break; } else line = tl; }
    if (y <= H - 14) g.fillText(line, 9, y);
  }

  // ---------- picking ----------
  pick(ndc) {
    const rc = this.w.raycaster; rc.setFromCamera(ndc, this.w.camera);
    for (const k of ['body', 'head']) this.m[k].boundingSphere = null;
    const hits = rc.intersectObjects([this.m.head, this.m.body], false);
    if (!hits.length) return null;
    const idx = hits[0].instanceId; let i = 0;
    for (const a of this.agents.values()) { if (i === idx) return a; i++; }
    return null;
  }
  agentByRobotKey(key) { return this.agents.get(key) || null; }
}
