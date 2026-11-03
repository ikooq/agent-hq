// Agent HQ v3 — the static office: merged + instanced furniture, atlases, sky, lighting, camera, quality.
import * as THREE from 'three';
import { OrbitControls } from '/vendor/OrbitControls.js';
import { RoundedBoxGeometry } from '/vendor/RoundedBoxGeometry.js';

export const STATUS_HEX = { working: 0x3fae7c, running: 0x3f9fae, waiting: 0xe39a2d, stuck: 0xe0565f, resting: 0x7d98df, off: 0x9a94a6 };
export const TEAM_HEX = { Research: 0x7cc9a2, Content: 0xf09f80, Visuals: 0xa992e0, Ops: 0x7db8e6, Codex: 0x5ec4c0 };
const EXTRA_TEAM = [0xf2c96d, 0xf2a0c0, 0xb5d98a];
export const teamColor = (team, i = 0) => new THREE.Color(TEAM_HEX[team] ?? EXTRA_TEAM[i % EXTRA_TEAM.length]);
export function botColor(bot, idx = 0) {
  const c = teamColor(bot.team), hsl = {}; c.getHSL(hsl);
  let h = 2166136261; for (const ch of String(bot.id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } h >>>= 0;
  return new THREE.Color().setHSL((hsl.h + ((h % 9) - 4) * 0.018 + idx * 0.04 + 1) % 1, Math.min(1, hsl.s * (0.85 + (h % 5) * 0.06)), Math.min(0.8, hsl.l + (((h >> 4) % 5) - 2) * 0.03));
}

// ---------- geometry builder: merges primitives into one non-indexed geometry with vertex colors ----------
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
export class Builder {
  constructor() { this.p = []; this.n = []; this.c = []; this.uv = []; }
  add(geo, color, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    _m.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
    g.applyMatrix4(_m);
    const P = g.attributes.position.array, N = g.attributes.normal.array, U = g.attributes.uv ? g.attributes.uv.array : null;
    const col = new THREE.Color(color);
    for (let i = 0; i < P.length; i += 3) { this.p.push(P[i], P[i + 1], P[i + 2]); this.n.push(N[i], N[i + 1], N[i + 2]); this.c.push(col.r, col.g, col.b); }
    for (let i = 0; i < P.length / 3; i++) this.uv.push(U ? U[i * 2] : 0, U ? U[i * 2 + 1] : 0);
    g.dispose(); geo.dispose && geo !== g && !geo.userData.keep && geo.dispose();
    return this;
  }
  box(w, h, d, color, x, y, z, ry = 0) { return this.add(new THREE.BoxGeometry(w, h, d), color, x, y, z, ry); }
  rbox(w, h, d, r, color, x, y, z, ry = 0) { return this.add(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)), color, x, y, z, ry); }
  cyl(rt, rb, h, seg, color, x, y, z) { return this.add(new THREE.CylinderGeometry(rt, rb, h, seg), color, x, y, z); }
  ball(r, color, x, y, z, sx = 1, sy = 1, sz = 1, detail = 0) { return this.add(new THREE.IcosahedronGeometry(r, detail), color, x, y, z, 0, 0, 0, sx, sy, sz); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
  get triangles() { return this.p.length / 9; }
}

// ---------- texture atlas with per-slot GPU updates (no whole-texture re-uploads) ----------
export class Atlas {
  constructor(renderer, w, h, slotW, slotH) {
    this.renderer = renderer; this.W = w; this.H = h; this.sw = slotW; this.sh = slotH;
    this.cols = Math.floor(w / slotW); this.rows = Math.floor(h / slotH); this.free = []; for (let i = this.cols * this.rows - 1; i >= 0; i--) this.free.push(i);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    this.tex = new THREE.CanvasTexture(c); this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.flipY = false;
    this.tex.generateMipmaps = false; this.tex.minFilter = THREE.LinearFilter; this.tex.magFilter = THREE.LinearFilter;
    renderer.initTexture(this.tex);
    this.slotCanvas = document.createElement('canvas'); this.slotCanvas.width = slotW; this.slotCanvas.height = slotH;
    this.g = this.slotCanvas.getContext('2d');
    this.src = { image: this.slotCanvas, isDataTexture: false, isCompressedTexture: false };
    this.keys = new Map(); this.uploads = 0;
  }
  alloc() { return this.free.length ? this.free.pop() : 0; }
  release(i) { if (i != null) { this.free.push(i); this.keys.delete(i); } }
  rect(i) { const x = (i % this.cols) * this.sw, y = Math.floor(i / this.cols) * this.sh; return [x / this.W, (y + this.sh) / this.H, this.sw / this.W, -this.sh / this.H]; }
  draw(i, key, painter) {             // repaint slot i only when its key changed
    if (this.keys.get(i) === key) return false;
    this.keys.set(i, key);
    const g = this.g; g.clearRect(0, 0, this.sw, this.sh); g.save(); painter(g, this.sw, this.sh); g.restore();
    const x = (i % this.cols) * this.sw, y = Math.floor(i / this.cols) * this.sh;
    this.renderer.copyTextureToTexture(new THREE.Vector2(x, y), this.src, this.tex);
    this.uploads++;
    return true;
  }
}
// instanced material that reads its map through a per-instance atlas rect
export function atlasMaterial(base) {
  base.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 atlasRect;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n vMapUv = vec2(atlasRect.x + uv.x * atlasRect.z, atlasRect.y + uv.y * atlasRect.w);\n#endif');
  };
  base.customProgramCacheKey = () => 'atlas';
  return base;
}
// billboards: fixed pixel size (pxScale = world units per screen pixel) or world size (pxScale = 1)
export function billboardMaterial(map, { additive = false, depthTest = false } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, pxScale: { value: 1 } },
    vertexShader: `attribute vec4 atlasRect; attribute vec4 tint; attribute vec2 pxOffset; uniform float pxScale; varying vec2 vUv; varying vec4 vTint;
      void main() { vec4 c = viewMatrix * modelMatrix * vec4(instanceMatrix[3].xyz, 1.0);
        vec2 size = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
        c.xy += (position.xy * size + pxOffset) * pxScale; gl_Position = projectionMatrix * c;
        vUv = vec2(atlasRect.x + uv.x * atlasRect.z, atlasRect.y + uv.y * atlasRect.w); vTint = tint; }`,
    fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying vec4 vTint;
      void main() { vec4 c = texture2D(map, vUv) * vTint; if (c.a < 0.02) discard; gl_FragColor = c;
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, depthTest, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}
// instanced billboard set: write slots each frame, count = active items
export class Billboards {
  constructor(material, capacity, renderOrder = 10) {
    const g = new THREE.PlaneGeometry(1, 1);
    this.rect = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.off = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    for (const a of [this.rect, this.tint, this.off]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('atlasRect', this.rect); g.setAttribute('tint', this.tint); g.setAttribute('pxOffset', this.off);
    this.mesh = new THREE.InstancedMesh(g, material, capacity); this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = renderOrder; this.mesh.count = 0; this.cap = capacity; this.n = 0;
    this.m = new THREE.Matrix4();
  }
  begin() { this.n = 0; }
  push(x, y, z, w, h, rect, r = 1, gg = 1, b = 1, a = 1, ox = 0, oy = 0) {
    if (this.n >= this.cap || !rect) { if (!rect && !this.warned) { this.warned = true; console.warn('billboard: missing atlas rect', new Error().stack); } return; }
    const i = this.n++;
    this.m.makeScale(w, h, 1); this.m.setPosition(x, y, z); this.mesh.setMatrixAt(i, this.m);
    const R = this.rect.array, T = this.tint.array, O = this.off.array, j = i * 4;
    if (R[j] !== rect[0] || R[j + 1] !== rect[1] || R[j + 2] !== rect[2] || R[j + 3] !== rect[3]) { R[j] = rect[0]; R[j + 1] = rect[1]; R[j + 2] = rect[2]; R[j + 3] = rect[3]; this.dirty = true; }
    if (T[j] !== r || T[j + 1] !== gg || T[j + 2] !== b || T[j + 3] !== a) { T[j] = r; T[j + 1] = gg; T[j + 2] = b; T[j + 3] = a; this.dirty = true; }
    if (O[i * 2] !== ox || O[i * 2 + 1] !== oy) { O[i * 2] = ox; O[i * 2 + 1] = oy; this.dirty = true; }
  }
  end() {
    this.mesh.count = this.n;
    if (!this.n && !this.lastN) return; this.lastN = this.n;
    const im = this.mesh.instanceMatrix; im.clearUpdateRanges(); im.addUpdateRange(0, Math.max(1, this.n) * 16); im.needsUpdate = true;
    if (this.dirty) { for (const [a, k] of [[this.rect, 4], [this.tint, 4], [this.off, 2]]) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, this.n) * k); a.needsUpdate = true; } this.dirty = false; }
  }
}

// ---------- canvas helpers ----------
export function canvasTex(w, h, paint, { repeat = false, srgb = true } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; paint(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.userData.canvas = c; return t;
}
export const rr = (g, x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); };

// ---------- sky by time of day ----------
const SKY = [ // hour, top, bottom, sunCol, sunI, hemiI, lamp(0..1), night(0..1)
  [0, '#141833', '#2a2d55', 0x9fb0ff, 0.35, 0.55, 1, 1], [5.5, '#1a2045', '#40406e', 0x9fb0ff, 0.35, 0.55, 1, 1],
  [6.8, '#89a0d8', '#ffcfae', 0xffc59a, 1.3, 0.85, 0.6, 0.35], [8.5, '#86c2ef', '#e4f3ff', 0xfff1de, 2.3, 1.1, 0.2, 0],
  [16.5, '#86c2ef', '#e9f4ff', 0xfff0da, 2.2, 1.05, 0.25, 0], [18, '#7d7fd0', '#ffae86', 0xffa16a, 1.5, 0.85, 0.7, 0.3],
  [19.4, '#33336f', '#9c7396', 0xc8a0ff, 0.6, 0.6, 1, 0.8], [20.6, '#141833', '#2a2d55', 0x9fb0ff, 0.35, 0.55, 1, 1], [24, '#141833', '#2a2d55', 0x9fb0ff, 0.35, 0.55, 1, 1]];
export function skyAt(hour) {
  let i = 0; while (i < SKY.length - 2 && SKY[i + 1][0] <= hour) i++;
  const a = SKY[i], b = SKY[i + 1], t = (hour - a[0]) / Math.max(1e-6, b[0] - a[0]), L = (p, q) => p + (q - p) * t;
  return { hour, top: new THREE.Color(a[1]).lerp(new THREE.Color(b[1]), t), bottom: new THREE.Color(a[2]).lerp(new THREE.Color(b[2]), t),
    sun: new THREE.Color(a[3]).lerp(new THREE.Color(b[3]), t), sunI: L(a[4], b[4]), hemiI: L(a[5], b[5]), lamp: L(a[6], b[6]), night: L(a[7], b[7]) };
}
function paintSky(g, w, h, sky) {
  const grd = g.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, '#' + sky.top.getHexString()); grd.addColorStop(1, '#' + sky.bottom.getHexString());
  g.fillStyle = grd; g.fillRect(0, 0, w, h);
  if (sky.night > .3) { g.fillStyle = `rgba(255,255,235,${sky.night * .9})`; for (let i = 0; i < 90; i++) g.fillRect((i * 97.1) % w, (i * 41.3) % (h * .5), i % 6 ? 1.5 : 2.5, i % 6 ? 1.5 : 2.5);
    g.fillStyle = `rgba(255,248,225,${sky.night})`; g.beginPath(); g.arc(w * .82, h * .22, 16, 0, 7); g.fill(); }
  else { const s = g.createRadialGradient(w * .2, h * .3, 3, w * .2, h * .3, 70); s.addColorStop(0, 'rgba(255,248,220,.95)'); s.addColorStop(1, 'rgba(255,236,190,0)'); g.fillStyle = s; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,.7)'; for (const [cx, cy, r] of [[.45, .2, 1], [.7, .3, .8], [.12, .38, .7]]) for (const [dx, dy, rr2] of [[0, 0, 20], [22, 5, 15], [-20, 6, 14]]) { g.beginPath(); g.arc(w * cx + dx * r, h * cy + dy * r, rr2 * r, 0, 7); g.fill(); } }
  let s = 11; const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const base = new THREE.Color().copy(sky.bottom).lerp(new THREE.Color(0x4a4560), .55 + sky.night * .3);
  for (let x = 0; x < w;) { const bw = 22 + rnd() * 46, bh = h * (.22 + rnd() * .38); g.fillStyle = '#' + base.getHexString(); g.fillRect(x, h - bh, bw, bh);
    if (sky.night > .05) for (let yy = h - bh + 6; yy < h - 4; yy += 9) for (let xx = x + 4; xx < x + bw - 5; xx += 7) if (rnd() < .4) { g.fillStyle = `rgba(255,212,140,${sky.night * (.5 + rnd() * .5)})`; g.fillRect(xx, yy, 3, 4); }
    x += bw + 2 + rnd() * 5; }
}

// ---------- the world ----------
export class World {
  constructor(container, { onPick, onFloor, perf, bench } = {}) {
    this.perf = perf; this.bench = !!bench; this.onPick = onPick;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap; this.renderer.shadowMap.autoUpdate = false;
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x1b1822);
    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 200);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: .1, rotateSpeed: .35, zoomSpeed: .9, panSpeed: .8, screenSpacePanning: true,
      minAzimuthAngle: Math.PI / 4 - .38, maxAzimuthAngle: Math.PI / 4 + .38, minPolarAngle: .78, maxPolarAngle: 1.08 });
    this.controls.addEventListener('change', () => { this.lastMove = performance.now(); });
    this.controls.addEventListener('start', () => { this.userMoved = true; this.follow = null; });
    // lights
    this.hemi = new THREE.HemisphereLight(0xfff6ea, 0x8a6a52, 1.1); this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1de, 2.2); this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048); this.sun.shadow.bias = -0.0005; this.sun.shadow.normalBias = 0.04; this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target);
    this.warm = new THREE.PointLight(0xffc488, 0, 18, 1.6); this.scene.add(this.warm);     // lounge lamp, stronger at night
    // shared materials
    this.mat = {
      vc: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .82, metalness: 0 }),
      vcInst: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .78, metalness: 0 }),
      glass: new THREE.MeshStandardMaterial({ color: 0xcfe6ff, transparent: true, opacity: .16, roughness: .1, metalness: .1, depthWrite: false, side: THREE.DoubleSide }),
      emissive: new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0xffe2b0, emissiveIntensity: .8, roughness: .6 }),
    };
    this.tex = { wood: this.woodTexture(), rug: canvasTex(128, 128, (g, w, h) => { rr(g, 4, 4, w - 8, h - 8, 22); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 0; }),
      blob: canvasTex(64, 64, (g) => { const r = g.createRadialGradient(32, 32, 2, 32, 32, 31); r.addColorStop(0, 'rgba(30,20,30,.45)'); r.addColorStop(1, 'rgba(30,20,30,0)'); g.fillStyle = r; g.fillRect(0, 0, 64, 64); }) };
    this.sky = canvasTex(512, 160, () => {});
    this.atlases = {
      screens: new Atlas(this.renderer, 1024, 1024, 256, 160),
      tags: new Atlas(this.renderer, 1024, 1024, 256, 64),
      chips: new Atlas(this.renderer, 1024, 1024, 256, 88),
    };
    this.icons = this.iconAtlas();
    this.quality = { mode: localStorage.getItem('hq-quality') || 'auto', level: 0, lockUntil: 0, below: 0, above: 0 };
    this.hourMode = localStorage.getItem('hq-tod') || 'now';
    this.insets = { left: 0, right: 0, top: 0, bottom: 0 };
    this.group = null; this.lastMove = 0; this.frame = 0;
    this.raycaster = new THREE.Raycaster();
    const el = this.renderer.domElement; let down = null;
    el.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', e => { if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 6) this.onPick && this.onPick(this.ndc(e)); down = null; });
    addEventListener('resize', () => this.resize());
    this.applyQuality(); this.resize(); this.updateSky(true);
  }
  ndc(e) { const r = this.renderer.domElement.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); }

  woodTexture() {
    return canvasTex(512, 512, (g, w, h) => {
      const rows = 10, ph = h / rows;
      for (let r = 0; r < rows; r++) { let x = -((r * 131) % 200); while (x < w) { const len = 150 + ((r * 37 + x) % 130), k = .93 + ((r * 7 + Math.floor(x)) % 8) / 100;
        g.fillStyle = `rgb(${Math.round(206 * k)},${Math.round(158 * k)},${Math.round(110 * k)})`; g.fillRect(x, r * ph, len, ph);
        g.strokeStyle = 'rgba(110,70,35,.28)'; g.lineWidth = 2; g.strokeRect(x + 1, r * ph + 1, len - 2, ph - 2); x += len; } }
    }, { repeat: true });
  }
  iconAtlas() {
    const S = 128, names = ['zzz', 'bang', 'q', 'spin0', 'spin1', 'spin2', 'spin3', 'report', 'glow', 'glowRed', 'card', 'check', 'lamp'];
    const t = canvasTex(S * 4, S * 4, (g) => {
      names.forEach((n, i) => {
        const x = (i % 4) * S, y = Math.floor(i / 4) * S; g.save(); g.translate(x, y);
        const bubble = (bg) => { g.fillStyle = bg; g.beginPath(); g.arc(64, 56, 46, 0, 7); g.fill(); g.beginPath(); g.moveTo(48, 96); g.lineTo(64, 124); g.lineTo(78, 94); g.fill(); };
        const txt = (s, size, col = '#fff') => { g.fillStyle = col; g.font = `800 ${size}px Segoe UI, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(s, 64, 58); };
        if (n === 'zzz') { g.fillStyle = '#8fa8f0'; g.font = '800 54px Segoe UI'; g.fillText('z', 18, 110); g.font = '800 42px Segoe UI'; g.fillText('z', 58, 72); g.font = '800 32px Segoe UI'; g.fillText('z', 92, 40); }
        if (n === 'bang') { bubble('#e0565f'); txt('!', 64); }
        if (n === 'q') { bubble('#e39a2d'); txt('?', 62); }
        if (n.startsWith('spin')) { const k = +n.slice(4); g.lineCap = 'round'; g.lineWidth = 12; for (let j = 0; j < 8; j++) { g.strokeStyle = `rgba(63,159,174,${.15 + ((j + k * 2) % 8) * .11})`; g.beginPath(); g.arc(64, 64, 40, j * .785, j * .785 + .5); g.stroke(); } }
        if (n === 'report') { bubble('#7d98df'); g.fillStyle = '#fff'; rr(g, 42, 30, 44, 54, 6); g.fill(); g.fillStyle = '#7d98df'; for (let k = 0; k < 4; k++) g.fillRect(50, 42 + k * 10, 28, 4); }
        if (n === 'glow' || n === 'glowRed' || n === 'lamp') { const c = n === 'glowRed' ? '255,90,100' : n === 'lamp' ? '255,206,140' : '255,190,90'; const r = g.createRadialGradient(64, 64, 2, 64, 64, 62); r.addColorStop(0, `rgba(${c},.95)`); r.addColorStop(.35, `rgba(${c},.35)`); r.addColorStop(1, `rgba(${c},0)`); g.fillStyle = r; g.fillRect(0, 0, S, S); }
        if (n === 'card') { g.fillStyle = '#fffdf7'; rr(g, 22, 30, 84, 68, 8); g.fill(); g.fillStyle = '#c9c2d4'; for (let k = 0; k < 3; k++) g.fillRect(32, 46 + k * 14, 60 - k * 12, 6); }
        if (n === 'check') { bubble('#3fae7c'); g.strokeStyle = '#fff'; g.lineWidth = 12; g.lineCap = 'round'; g.beginPath(); g.moveTo(42, 58); g.lineTo(58, 74); g.lineTo(88, 42); g.stroke(); }
        g.restore();
      });
    });
    t.flipY = false; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter;
    const rects = {}; names.forEach((n, i) => { const x = (i % 4) * S, y = Math.floor(i / 4) * S; rects[n] = [x / 512, (y + S) / 512, S / 512, -S / 512]; });
    return { tex: t, rects };
  }

  // ---------- build the static office from a layout ----------
  build(L) {
    if (this.group) { this.scene.remove(this.group); this.group.traverse(o => { if (o.geometry && !o.userData.keepGeo) o.geometry.dispose(); }); }
    const G = this.group = new THREE.Group(); this.scene.add(G); this.L = L;
    const W = L.W, D = L.D, WALL_H = 2.7;
    const B = new Builder();
    // diorama base + floor edge
    B.box(W + 0.5, 0.35, D + 0.5, 0x6b4a36, W / 2, -0.18, D / 2);
    B.box(W + 0.62, 0.06, D + 0.62, 0x4b3326, W / 2, -0.37, D / 2);
    // walls (back + left) with windows cut as separate panes; trims
    const wallC = 0xf3e8dc, trim = 0xffffff;
    B.box(W + 0.25, WALL_H, 0.22, wallC, W / 2, WALL_H / 2, -0.11);
    const dz0 = L.door.z - L.door.w / 2, dz1 = L.door.z + L.door.w / 2;
    B.box(0.22, WALL_H, dz0, wallC, -0.11, WALL_H / 2, dz0 / 2);
    B.box(0.22, WALL_H, D - dz1, wallC, -0.11, WALL_H / 2, (dz1 + D) / 2);
    B.box(0.22, 0.5, L.door.w, wallC, -0.11, WALL_H - 0.25, L.door.z);
    B.box(W + 0.3, 0.08, 0.3, trim, W / 2, WALL_H + 0.04, -0.1); B.box(0.3, 0.08, D, trim, -0.1, WALL_H + 0.04, D / 2);
    B.box(W, 0.12, 0.04, trim, W / 2, 0.06, 0.02); B.box(0.04, 0.12, D, trim, 0.02, 0.06, D / 2);
    // door frame + mat
    for (const dz of [dz0, dz1]) B.box(0.3, WALL_H - 0.45, 0.08, 0xc79a6b, -0.1, (WALL_H - 0.45) / 2, dz);
    B.box(0.3, 0.08, L.door.w + 0.1, 0xc79a6b, -0.1, WALL_H - 0.48, L.door.z);
    B.box(1.1, 0.02, 1.3, 0x8b6a8f, 0.6, 0.012, L.door.z);
    // windows: frames into the merged mesh, panes into one sky mesh
    const panes = [];
    const win = (x, z, w, h, axis) => {
      const y = 1.5;
      if (axis === 'z') { for (const [px, py, sw, sh] of [[0, h / 2, w + .1, .08], [0, -h / 2, w + .1, .08], [-w / 2, 0, .08, h], [w / 2, 0, .08, h], [0, 0, .05, h]]) B.box(sw, sh, .1, trim, x + px, y + py, .02); panes.push({ x, y, z: .025, w, h, axis }); }
      else { for (const [pz, py, sw, sh] of [[0, h / 2, w + .1, .08], [0, -h / 2, w + .1, .08], [-w / 2, 0, .08, h], [w / 2, 0, .08, h], [0, 0, .05, h]]) B.box(.1, sh, sw, trim, .02, y + py, z + pz); panes.push({ x: .025, y, z, w, h, axis }); }
    };
    for (let x = 1.6; x < W - 1.2; x += 3.4) win(x, 0, 2.4, 1.5, 'z');
    for (let z = 2.2; z < dz0 - 1.4; z += 3.4) win(0, z, 2.4, 1.5, 'x');
    // zone floor tints (under rugs/desks)
    for (const z of L.zones) {
      const col = z.kind === 'team' ? teamColor(z.team).lerp(new THREE.Color(0xffffff), .72) : z.kind === 'lounge' ? new THREE.Color(0xf4dccb) : z.kind === 'meeting' ? new THREE.Color(0xe5e1f0) : new THREE.Color(0xf0e6d4);
      B.box(z.x1 - z.x0, 0.012, z.z1 - z.z0, col, (z.x0 + z.x1) / 2, 0.008, (z.z0 + z.z1) / 2);
    }
    // lead office: desk, shelf, lamp, nameplate
    const ld = L.lead.desk;
    B.rbox(ld.w, 0.07, ld.d, .02, 0x8a5a3b, ld.x, 0.75, ld.z); B.box(ld.w - .1, 0.7, ld.d - .15, 0x7a4e33, ld.x, 0.36, ld.z);
    B.box(0.5, 0.32, 0.05, 0x2f2b3a, ld.x - 0.3, 0.98, ld.z - 0.2); B.box(0.46, 0.27, 0.01, 0x7fd6e0, ld.x - 0.3, 0.98, ld.z - 0.17);
    B.box(1.4, 1.9, 0.38, 0xb88a5f, 1.3, 0.95, 0.35); for (let k = 0; k < 4; k++) for (let j = 0; j < 6; j++) B.box(0.12, 0.3, 0.26, [0xf09f80, 0xa992e0, 0x7cc9a2, 0x7db8e6, 0xf2c96d][(k + j) % 5], 0.8 + j * 0.2, 0.32 + k * 0.45, 0.36);
    // meeting room: table, whiteboard
    const t = L.meeting.table;
    B.rbox(t.w, 0.07, t.d, .25, 0xd9b48a, t.x, 0.74, t.z); B.cyl(.07, .1, .7, 8, 0x8b6a4f, t.x - 1.1, 0.36, t.z); B.cyl(.07, .1, .7, 8, 0x8b6a4f, t.x + 1.1, 0.36, t.z);
    B.box(2.6, 1.1, 0.05, 0xffffff, t.x, 1.55, 0.06); B.box(2.7, 1.2, 0.03, 0xb9b3c7, t.x, 1.55, 0.04);
    for (let k = 0; k < 3; k++) B.box(0.5, 0.06, 0.01, [0xf09f80, 0x7cc9a2, 0x7db8e6][k], t.x - 0.8 + k * 0.6, 1.75 - k * 0.2, 0.09);
    // lounge: rug, sofa, coffee table, armchair, counter + coffee machine, lamp, shelves with books
    const lo = L.lounge;
    B.rbox(lo.rug.w, 0.02, lo.rug.d, .3, 0xe7b9a3, lo.rug.x, 0.015, lo.rug.z); B.rbox(lo.rug.w - .4, 0.022, lo.rug.d - .4, .25, 0xf3d4c2, lo.rug.x, 0.017, lo.rug.z);
    const so = lo.sofa, fab = 0x9cc7b6, fab2 = 0xb7dacb;
    B.rbox(so.w, 0.4, so.d, .1, fab, so.x, 0.22, so.z); B.rbox(so.w, 0.6, 0.26, .1, fab, so.x, 0.62, so.z - so.d / 2 + 0.13);
    for (const sx of [-so.w / 2 + .12, so.w / 2 - .12]) B.rbox(0.24, 0.56, so.d, .1, fab, so.x + sx, 0.4, so.z);
    for (const sx of [-1, 0, 1]) B.rbox(0.92, 0.12, 0.7, .05, fab2, so.x + sx, 0.46, so.z + .08);
    B.rbox(0.4, 0.34, 0.12, .06, 0xf09f80, so.x - 1.1, 0.66, so.z - 0.2);
    const ct = lo.coffeeTable; B.rbox(ct.w, 0.06, ct.d, .08, 0xc9905f, ct.x, 0.42, ct.z); B.box(ct.w - .3, 0.38, ct.d - .3, 0xa8754d, ct.x, 0.2, ct.z); B.cyl(.07, .06, .1, 10, 0xffffff, ct.x + .3, .5, ct.z);
    const ac = lo.armchair; B.rbox(ac.w, 0.42, ac.d, .12, 0xe8a98f, ac.x, 0.22, ac.z); B.rbox(0.24, 0.62, ac.d, .1, 0xe8a98f, ac.x + ac.w / 2 - .12, 0.5, ac.z);
    const cn = lo.counter; B.box(cn.w, 0.92, cn.d, 0xd2a77a, cn.x, 0.46, cn.z); B.box(cn.w + .05, 0.05, cn.d + .05, 0xf6f1ea, cn.x, 0.945, cn.z);
    B.rbox(0.42, 0.52, 0.38, .06, 0xe0646a, cn.x - .3, 1.23, cn.z - .02); B.box(0.16, 0.05, 0.12, 0x3a3346, cn.x - .3, 1.12, cn.z + .2); B.cyl(.05, .045, .09, 10, 0xffffff, cn.x - .3, 1.02, cn.z + .2);
    B.cyl(.06, .05, .1, 10, 0x7db8e6, cn.x + .25, 1.02, cn.z + .1); B.cyl(.06, .05, .1, 10, 0xf2c96d, cn.x + .45, 1.02, cn.z);
    const lampX = lo.zone.x0 + 2.3, lampZ = 0.6;
    B.cyl(.025, .025, 1.65, 6, 0x5b4a3e, lampX, .83, lampZ); B.cyl(.18, .2, .04, 12, 0x5b4a3e, lampX, .02, lampZ);
    this.lampPos = [new THREE.Vector3(lampX, 1.75, lampZ)];
    for (const s of lo.shelves) { B.box(s.w, 2.0, s.d, 0xb88a5f, s.x, 1.0, s.z); for (let k = 0; k < 4; k++) { let bx = s.x - s.w / 2 + .1; let i = 0; while (bx < s.x + s.w / 2 - .15) { const bw = .07 + ((k * 7 + i * 3) % 5) * .012, bh = .26 + ((k + i) % 4) * .04; B.box(bw, bh, .24, [0xf09f80, 0xa992e0, 0x7cc9a2, 0x7db8e6, 0xf2c96d, 0xfff1de][(k * 3 + i) % 6], bx + bw / 2, .2 + k * .46 + bh / 2, s.z + .04); bx += bw + .015; i++; } } }
    for (const nk of L.nooks || []) {
      B.rbox(nk.x1 - nk.x0 - 0.6, 0.02, nk.z1 - nk.z0 - 1.2, .3, 0xd9c4e6, (nk.x0 + nk.x1) / 2, 0.015, (nk.z0 + nk.z1) / 2 + 0.3);
      const s = nk.shelf; B.box(s.w, 1.6, s.d, 0xb88a5f, s.x, 0.8, s.z); for (let k2 = 0; k2 < 3; k2++) { let bx = s.x - s.w / 2 + .1, i2 = 0; while (bx < s.x + s.w / 2 - .15) { const bw = .07 + ((k2 * 5 + i2 * 3) % 5) * .012, bh = .26 + ((k2 + i2) % 4) * .04; B.box(bw, bh, .24, [0xf09f80, 0xa992e0, 0x7cc9a2, 0x7db8e6, 0xf2c96d][(k2 * 2 + i2) % 5], bx + bw / 2, .2 + k2 * .5 + bh / 2, s.z + .04); bx += bw + .015; i2++; } }
      for (const [i3, b] of nk.bags.entries()) B.ball(.42, [0xf2c96d, 0x9cc7b6][i3 % 2], b.x, .22, b.z, 1, .55, 1, 1);
      B.cyl(.3, .3, .05, 14, 0xc9905f, nk.table.x, .42, nk.table.z); B.cyl(.05, .07, .4, 8, 0xa8754d, nk.table.x, .2, nk.table.z); B.cyl(.06, .05, .1, 10, 0xffffff, nk.table.x + .1, .5, nk.table.z);
    }
    // approval kiosk + queue markers + sign
    const k = L.kiosk;
    B.rbox(0.8, 1.05, 0.5, .08, 0xf6f1ea, k.x, 0.52, k.z); B.box(0.62, 0.42, 0.05, 0x2f2b3a, k.x, 1.25, k.z + 0.2); B.box(0.56, 0.36, 0.01, 0xffc864, k.x, 1.25, k.z + 0.23);
    B.cyl(.03, .03, 2.0, 6, 0x9c8f86, k.x - .55, 1.0, k.z); B.box(0.9, 0.3, 0.04, 0xe39a2d, k.x - .1, 2.05, k.z);
    for (const q of L.queue.slice(0, 6)) B.cyl(.18, .18, .01, 14, 0xf3c78a, q.x, .014, q.z);
    // done board
    const bd = L.board; B.box(bd.w, 1.2, 0.06, 0x8f6a4c, bd.x, 1.25, bd.z); B.box(bd.w - .12, 1.08, 0.02, 0xf4e6cf, bd.x, 1.25, bd.z + 0.03);
    for (const sx of [-.7, .7]) B.box(0.06, 0.7, 0.06, 0x8f6a4c, bd.x + sx, 0.35, bd.z);
    this.boardRect = { x0: bd.x - bd.w / 2 + .14, x1: bd.x + bd.w / 2 - .14, y0: 0.8, y1: 1.6, z: bd.z + 0.05 };
    B.box(bd.w - .12, 0.2, 0.02, 0x3fae7c, bd.x, 1.76, bd.z + 0.045);
    // supervisor chair is instanced below; kiosk glow position
    this.kioskGlow = new THREE.Vector3(k.x, 1.25, k.z + 0.35);
    const merged = new THREE.Mesh(B.geometry(), this.mat.vc); merged.castShadow = merged.receiveShadow = true; G.add(merged);
    this.staticTris = B.triangles;
    // floor (wood texture)
    const wt = this.tex.wood.clone(); wt.repeat.set(W / 3, D / 3); wt.needsUpdate = true;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: wt, roughness: .75 }));
    floor.rotation.x = -Math.PI / 2; floor.position.set(W / 2, 0.002, D / 2); floor.receiveShadow = true; G.add(floor); this.floor = floor;
    // window panes: one mesh, UVs into the sky canvas
    const PB = new Builder();
    panes.forEach((p, i) => { const pg = new THREE.PlaneGeometry(p.w, p.h); const u0 = (i * 0.137) % 0.7; const uv = pg.attributes.uv; for (let j = 0; j < uv.count; j++) uv.setX(j, u0 + uv.getX(j) * 0.3); PB.add(pg, 0xffffff, p.x, p.y, p.z, p.axis === 'z' ? 0 : Math.PI / 2); });
    const paneMesh = new THREE.Mesh(PB.geometry(), new THREE.MeshBasicMaterial({ map: this.sky, toneMapped: false })); G.add(paneMesh);
    // glass walls: one transparent mesh
    const GB = new Builder();
    for (const g of L.glass) { const len = Math.hypot(g.x1 - g.x0, g.z1 - g.z0); GB.box(g.x0 === g.x1 ? 0.04 : len, 2.2, g.x0 === g.x1 ? len : 0.04, 0xffffff, (g.x0 + g.x1) / 2, 1.1, (g.z0 + g.z1) / 2);
      GB.box(g.x0 === g.x1 ? 0.07 : len, 0.06, g.x0 === g.x1 ? len : 0.07, 0xffffff, (g.x0 + g.x1) / 2, 2.2, (g.z0 + g.z1) / 2); }
    const glassMesh = new THREE.Mesh(GB.geometry(), this.mat.glass); glassMesh.renderOrder = 2; G.add(glassMesh);
    // floor labels: one mesh with a label atlas
    this.buildLabels(L, G);
    // instanced furniture: desks, chairs, monitors, plants, rugs
    this.buildInstanced(L, G);
    // camera + shadows
    this.sun.position.set(W * .5 - 9, 22, D * .5 + 14); this.sun.target.position.set(W / 2, 0, D / 2);
    const sc = this.sun.shadow.camera, ext = Math.max(W, D) * .72; Object.assign(sc, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 80 }); sc.updateProjectionMatrix();
    this.warm.position.set(lampX + .8, 1.9, 1.4);
    this.renderer.shadowMap.needsUpdate = true;           // static shadows: render once per layout
    this.needsCompile = true;
    if (!this.userMoved) this.fit(true);
  }
  buildLabels(L, G) {
    const items = [...L.labels, { text: 'Done today', board: true }], H = 64, Wc = 512;
    const c = document.createElement('canvas'); c.width = Wc; c.height = H * Math.max(1, items.length);
    const g = c.getContext('2d'); g.font = '800 40px Segoe UI, sans-serif'; g.textBaseline = 'middle';
    const widths = items.map(it => Math.min(Wc - 12, g.measureText(it.text.toUpperCase()).width + 10));
    items.forEach((it, i) => { g.fillStyle = it.board ? '#ffffff' : 'rgba(60,45,72,.82)'; g.fillText(it.text.toUpperCase(), 6, i * H + H / 2 + 2, Wc - 12); });
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const B = new Builder();
    items.forEach((it, i) => {
      const LH = 0.52, lw = widths[i] / H * LH, uf = widths[i] / Wc;
      const pg = new THREE.PlaneGeometry(lw, LH); const uv = pg.attributes.uv;
      for (let j = 0; j < uv.count; j++) { uv.setX(j, uv.getX(j) * uf); uv.setY(j, 1 - (i + 1 - uv.getY(j)) / items.length); }
      if (it.board) { const bd = L.board, s = 0.17 / LH; B.add(pg, 0xffffff, bd.x, 1.76, bd.z + 0.06, 0, 0, 0, s, s, 1); }
      else B.add(pg, 0xffffff, it.x + lw / 2, 0.03, it.z + LH / 2, 0, -Math.PI / 2);
    });
    const m = new THREE.Mesh(B.geometry(), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false })); m.renderOrder = 1; G.add(m);
  }
  buildInstanced(L, G) {
    const n = L.desks.length, chairs = n + L.meeting.seats.length + 1;
    const desk = new Builder();
    desk.rbox(1.7, 0.06, 0.85, .03, 0xdcb487, 0, 0.75, 0);
    for (const [x, z] of [[-.78, -.36], [.78, -.36], [-.78, .36], [.78, .36]]) desk.box(.05, .74, .05, 0xb48a5e, x, .37, z);
    desk.box(.45, .5, .7, 0xcfa577, .58, .5, 0);
    desk.box(.5, .02, .18, 0xfaf6ef, -.24, .79, .2); desk.cyl(.045, .04, .09, 8, 0xffffff, -.62, .82, .18); desk.ball(.09, 0x8cc79a, -.68, .87, -.22, 1, 1.3, 1);
    const deskGeo = desk.geometry();
    const chair = new Builder();
    chair.rbox(.5, .08, .48, .04, 0x5d5670, 0, .48, 0); chair.rbox(.48, .5, .07, .04, 0x5d5670, 0, .8, .24); chair.cyl(.025, .025, .4, 6, 0x8e88a0, 0, .26, 0); chair.cyl(.22, .22, .04, 5, 0x8e88a0, 0, .04, 0);
    const chairGeo = chair.geometry();
    const mon = new Builder();
    mon.box(.06, .2, .06, 0x3a3346, 0, .88, 0); mon.box(.26, .02, .16, 0x3a3346, 0, .79, 0); mon.rbox(.82, .52, .05, .02, 0x2f2b3a, 0, 1.22, 0);
    const monGeo = mon.geometry();
    const plant = new Builder();
    plant.cyl(.2, .15, .32, 10, 0xf0e2d0, 0, .16, 0); for (let i = 0; i < 6; i++) { const a = i * 1.05; plant.ball(.17, 0x8cc79a, Math.cos(a) * .12, .48 + (i % 3) * .13, Math.sin(a) * .12, 1, 1.5, 1); }
    const plantGeo = plant.geometry();
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
    const inst = (geo, count, mat) => { const m = new THREE.InstancedMesh(geo, mat, Math.max(1, count)); m.castShadow = m.receiveShadow = true; m.count = count; G.add(m); return m; };
    // desks face +z (agent side); chair behind the seat
    const deskM = inst(deskGeo, n, this.mat.vcInst), chairM = inst(chairGeo, chairs, this.mat.vcInst), monM = inst(monGeo, n, this.mat.vcInst);
    L.desks.forEach((d, i) => {
      deskM.setMatrixAt(i, m4.compose(new THREE.Vector3(d.desk.x, 0, d.desk.z), q.identity(), one));
      chairM.setMatrixAt(i, m4.compose(new THREE.Vector3(d.seat.x, 0, d.seat.z + 0.05), q.identity(), one));
      monM.setMatrixAt(i, m4.compose(new THREE.Vector3(d.monitor.x, 0, d.monitor.z), q.identity(), one));
    });
    L.meeting.seats.forEach((s, i) => chairM.setMatrixAt(n + i, m4.compose(new THREE.Vector3(s.x, 0, s.z + (s.facing ? .12 : -.12)), q.setFromAxisAngle(up, s.facing ? 0 : Math.PI), one)));
    chairM.setMatrixAt(chairs - 1, m4.compose(new THREE.Vector3(L.lead.supervisor.x, 0, L.lead.supervisor.z - .12), q.setFromAxisAngle(up, Math.PI), one));
    const plM = inst(plantGeo, L.plants.length, this.mat.vcInst);
    L.plants.forEach((p, i) => plM.setMatrixAt(i, m4.compose(new THREE.Vector3(p.x, 0, p.z), q.identity(), new THREE.Vector3(p.s, p.s, p.s))));
    // agent-coloured rugs (instance colour), screens (atlas), desk chips are billboards (actors.js)
    const rugM = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ map: this.tex.rug, transparent: true, roughness: 1, depthWrite: false }), Math.max(1, n));
    rugM.receiveShadow = true; rugM.renderOrder = 1; G.add(rugM);
    const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    L.desks.forEach((d, i) => rugM.setMatrixAt(i, m4.compose(new THREE.Vector3(d.rug.x, 0.02, d.rug.z), flat, new THREE.Vector3(d.rug.w, d.rug.d, 1))));
    this.rugs = rugM;
    const screenGeo = new THREE.PlaneGeometry(.76, .46);
    const rect = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 4), 4); screenGeo.setAttribute('atlasRect', rect);
    const scr = new THREE.InstancedMesh(screenGeo, atlasMaterial(new THREE.MeshBasicMaterial({ map: this.atlases.screens.tex, toneMapped: false })), Math.max(1, n));
    L.desks.forEach((d, i) => { scr.setMatrixAt(i, m4.compose(new THREE.Vector3(d.monitor.x, 1.22, d.monitor.z + .03), q.identity(), one)); });
    scr.count = n; G.add(scr);
    this.screens = { mesh: scr, rect, slots: L.desks.map(() => null) };
    for (const m of [deskM, chairM, monM, plM, rugM, scr]) m.instanceMatrix.needsUpdate = true;
  }

  // ---------- time of day ----------
  setHourMode(mode) { this.hourMode = mode; localStorage.setItem('hq-tod', mode); this.updateSky(true); }
  currentHour() { const d = new Date(); return { now: d.getHours() + d.getMinutes() / 60, day: 12, evening: 18.4, night: 22.5 }[this.hourMode] ?? 12; }
  updateSky(force) {
    const h = this.currentHour();
    if (!force && this.lastHour != null && Math.abs(h - this.lastHour) < 1 / 60) return;
    this.lastHour = h; const s = this.skyState = skyAt(h);
    paintSky(this.sky.userData.canvas.getContext('2d'), 512, 160, s); this.sky.needsUpdate = true;
    this.hemi.intensity = s.hemiI; this.hemi.color.set(0xfff6ea).lerp(new THREE.Color(0xa9b4ff), s.night * .35);
    this.sun.color.copy(s.sun); this.sun.intensity = s.sunI;
    this.warm.intensity = 2 + s.lamp * 26;
    this.mat.vc.emissive?.setHex(0x000000);
    this.renderer.toneMappingExposure = 1.0 + s.night * .15;
    this.scene.background.set(0x1b1822).lerp(new THREE.Color(0x0f0d16), s.night);
  }

  // ---------- quality ----------
  setQualityMode(mode) { this.quality.mode = mode; localStorage.setItem('hq-quality', mode); this.quality.level = mode === 'low' ? 3 : 0; this.applyQuality(); }
  applyQuality() {
    const lvl = this.quality.mode === 'low' ? 3 : this.quality.mode === 'high' ? 0 : this.quality.level;
    const shadows = lvl < 1, glow = lvl < 2, pr = lvl >= 3 ? 1 : Math.min(devicePixelRatio, 1.5);
    if (this.renderer.shadowMap.enabled !== shadows) { this.renderer.shadowMap.enabled = shadows; this.sun.castShadow = shadows; this.scene.traverse(o => { if (o.material) [].concat(o.material).forEach(m => m.needsUpdate = true); }); this.renderer.shadowMap.needsUpdate = true; }
    this.glowOn = glow;
    if (this.renderer.getPixelRatio() !== pr) { this.renderer.setPixelRatio(pr); this.resize(); }
    document.body.classList.toggle('q-low', this.quality.mode === 'low' || lvl >= 3);
    this.qualityLevel = lvl;
    this.onQuality && this.onQuality(lvl);
  }
  autoQuality(fps, active, now) {   // called ~4x per second
    const Q = this.quality; if (Q.mode !== 'auto' || !active) { Q.below = Q.above = 0; return; }
    if (fps < 50) { Q.below += .25; Q.above = 0; } else if (fps >= 58) { Q.above += .25; Q.below = 0; } else { Q.below = Q.above = 0; }
    if (Q.below >= 3 && Q.level < 3) { Q.level++; Q.below = 0; Q.lastDown = now; this.applyQuality(); }
    else if (Q.above >= 10 && Q.level > 0 && now > Q.lockUntil) { if (Q.lastUp && now - Q.lastUp < 25000 && Q.lastDown > Q.lastUp) Q.lockUntil = now + 120000; else { Q.level--; Q.lastUp = now; this.applyQuality(); } Q.above = 0; }
  }

  // ---------- camera ----------
  setInsets(i) { this.insets = { ...this.insets, ...i }; this.resize(); }
  resize() {
    const w = innerWidth, h = innerHeight; this.viewH = h;
    this.renderer.setSize(w, h);
    const aspect = w / h, half = 10;
    Object.assign(this.camera, { left: -half * aspect, right: half * aspect, top: half, bottom: -half });
    const dx = (this.insets.left - this.insets.right) / 2, dy = (this.insets.top - this.insets.bottom) / 2;
    this.camera.setViewOffset(w, h, -dx, -dy, w, h);
    this.camera.updateProjectionMatrix();
    if (!this.userMoved && this.L) this.fit(true);
  }
  fit(instant) {
    const L = this.L; if (!L) return;
    const target = new THREE.Vector3(L.W / 2, 0.6, L.D / 2);
    const dir = new THREE.Vector3(Math.sin(Math.PI / 4) * Math.sin(.95), Math.cos(.95), Math.cos(Math.PI / 4) * Math.sin(.95));
    this.camera.position.copy(target).addScaledVector(dir, 60); this.camera.lookAt(target); this.camera.updateMatrixWorld();
    this.controls.target.copy(target);
    // project the floor corners (and wall tops) to camera space, fit the free viewport
    const inv = this.camera.matrixWorldInverse, pts = [];
    for (const [x, z] of [[-0.3, -0.3], [L.W + 0.3, -0.3], [-0.3, L.D + 0.3], [L.W + 0.3, L.D + 0.3]]) pts.push(new THREE.Vector3(x, -0.4, z).applyMatrix4(inv));
    for (const [x, z] of [[-0.2, -0.2], [L.W, -0.2], [-0.2, L.D]]) pts.push(new THREE.Vector3(x, 2.8, z).applyMatrix4(inv));
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const needW = Math.max(...xs) - Math.min(...xs), needH = Math.max(...ys) - Math.min(...ys);
    const freeW = innerWidth - this.insets.left - this.insets.right, freeH = innerHeight - this.insets.top - this.insets.bottom;
    const viewW = (this.camera.right - this.camera.left) * freeW / innerWidth, viewH = (this.camera.top - this.camera.bottom) * freeH / innerHeight;
    const zoom = Math.min(viewW / needW, viewH / needH) * 0.995;
    // centre on the middle of the projected box
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0), upv = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const shift = right.multiplyScalar(cx).add(upv.multiplyScalar(cy));
    this.controls.target.add(shift); this.camera.position.add(shift);
    this.camera.zoom = zoom; this.fitZoom = zoom;
    this.controls.minZoom = zoom * .75; this.controls.maxZoom = zoom * 4;
    this.camera.updateProjectionMatrix(); this.controls.update(); this.lastMove = performance.now();
  }
  home() { this.userMoved = false; this.follow = null; this.fit(); }
  pxScale() { return (this.camera.top - this.camera.bottom) / (this.camera.zoom * (this.viewH || innerHeight)); }   // cached size: no layout reads per frame
  clampTarget() {
    const t = this.controls.target, L = this.L; if (!L) return;
    const cx = Math.min(L.W, Math.max(0, t.x)), cz = Math.min(L.D, Math.max(0, t.z));
    if (cx !== t.x || cz !== t.z) { const d = new THREE.Vector3(cx - t.x, 0, cz - t.z); t.add(d); this.camera.position.add(d); }
  }
}
