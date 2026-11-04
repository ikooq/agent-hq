// Agent HQ "Record": WebM of the office including the panels (MediaRecorder, no libraries).
// 1st choice: capture this browser tab (getDisplayMedia, preferCurrentTab) -> exactly what you see, panels included.
// Fallback (capture refused or unavailable): composite canvas = the 3D canvas + header, side panel, footer and
// open dialogs repainted every frame from the live state (so the video never shows just the bare 3D scene).
const pick = () => ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || 'video/webm';
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

export class Recorder {
  constructor({ world, getState, onChange }) { this.world = world; this.getState = getState; this.onChange = onChange || (() => {}); this.rec = null; this.mode = null; }
  get active() { return !!this.rec; }
  async start(opts = {}) {
    if (this.rec) return;
    this.chunks = []; this.startedAt = performance.now();
    let stream = null;
    if (!opts.composite && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30, displaySurface: 'browser', width: { ideal: Math.round(innerWidth * (devicePixelRatio || 1)) }, height: { ideal: Math.round(innerHeight * (devicePixelRatio || 1)) } }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', systemAudio: 'exclude' });
        this.mode = 'tab';
        stream.getVideoTracks()[0].addEventListener('ended', () => this.stop());   // "Stop sharing" in the browser bar
      } catch (e) { stream = null; }
    }
    if (!stream) { stream = this.compositeStream(); this.mode = 'composite'; }
    this.stream = stream;
    this.rec = new MediaRecorder(stream, { mimeType: pick(), videoBitsPerSecond: 8e6 });
    this.rec.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.done = new Promise(res => { this.rec.onstop = () => res(new Blob(this.chunks, { type: 'video/webm' })); });
    this.rec.start(1000);
    this.onChange(true);
  }
  async stop({ download = true } = {}) {
    if (!this.rec) return null;
    const rec = this.rec; this.rec = null;
    rec.stop(); for (const t of this.stream.getTracks()) t.stop();
    this.compG = null;
    const blob = await this.done; this.lastBlob = blob; this.onChange(false);
    if (download) {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `agent-hq-${stamp()}.webm`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
    return blob;
  }
  // ---------- fallback: canvas composite ----------
  compositeStream() {
    const c = this.comp = document.createElement('canvas'), dpr = Math.min(2, devicePixelRatio || 1);
    c.width = Math.round(innerWidth * dpr); c.height = Math.round(innerHeight * dpr);
    const g = this.compG = c.getContext('2d'); g.scale(dpr, dpr);
    this.paint(g);
    return c.captureStream(30);
  }
  // called by the render loop right after the WebGL frame is drawn (the drawing buffer is only valid then)
  frame() { if (this.compG) this.paint(this.compG); }
  paint(g) {
    const W = innerWidth, H = innerHeight, gl = this.world.renderer.domElement;
    g.fillStyle = '#1b1822'; g.fillRect(0, 0, W, H);
    try { g.drawImage(gl, 0, 0, W, H); } catch (e) {}
    // every visible panel: its box + its text lines, in DOM order (header, Waiting, Team, Activity, footer, card, kiosk, dialogs)
    for (const sel of ['header', '#side', 'footer', '#card.show', '#kiosk:not([hidden])', '.modal.show .modal-card']) for (const el of document.querySelectorAll(sel)) this.paintBox(g, el);
  }
  paintBox(g, el) {
    const r = el.getBoundingClientRect(); if (r.width < 4 || r.height < 4 || r.right < 0 || r.left > innerWidth) return;
    const cs = getComputedStyle(el);
    g.save(); g.beginPath(); g.roundRect(r.left, r.top, r.width, r.height, parseFloat(cs.borderTopLeftRadius) || 12);
    g.fillStyle = 'rgba(255,252,247,.93)'; g.shadowColor = 'rgba(30,20,40,.25)'; g.shadowBlur = 14; g.fill(); g.shadowColor = 'transparent'; g.clip();
    // status chips / avatars / buttons first, so states stay readable under the text
    for (const e of el.querySelectorAll('.chip, .av, .abtn, .hbtn.on, .seg.on, .stage.cur, .stage.past, .kpi, .wrow, .appr-detail, .legend i, .dot, .tile')) {
      const er = e.getBoundingClientRect(); if (!er.width || er.bottom < r.top || er.top > r.bottom || e.closest('[hidden]')) continue;
      const bg = getComputedStyle(e).backgroundColor; if (!bg || bg === 'rgba(0, 0, 0, 0)') continue;
      g.fillStyle = bg; g.beginPath(); g.roundRect(er.left, er.top, er.width, er.height, Math.min(10, er.height / 2)); g.fill();
    }
    // text nodes with their own positions and colours
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), range = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      let txt = n.textContent.replace(/\s+/g, ' ').trimEnd(); if (!txt.trim()) continue;   // keep a leading space: it sits inside the text rect
      const p = n.parentElement; if (!p || p.closest('[hidden]') || p.offsetParent === null && getComputedStyle(p).position !== 'fixed') continue;
      range.selectNodeContents(n); const rects = range.getClientRects(); if (!rects.length) continue;
      const ps = getComputedStyle(p); if (ps.visibility === 'hidden' || +ps.opacity === 0) continue;
      g.font = `${ps.fontWeight} ${ps.fontSize} ${ps.fontFamily}`; g.fillStyle = ps.color; g.textBaseline = 'middle';
      if (ps.textTransform === 'uppercase') txt = txt.toUpperCase();
      // one draw per line box (wrapped text spans several client rects)
      const lead = txt.startsWith(' ') ? g.measureText(' ').width : 0, words = txt.trim().split(' '); let wi = 0, first = true;
      for (const lr of rects) {
        if (lr.bottom < r.top || lr.top > r.bottom) continue;
        const x0 = lr.left + (first ? lead : 0), room = lr.right - x0 + 2; first = false;
        let line = ''; while (wi < words.length && g.measureText(line ? line + ' ' + words[wi] : words[wi]).width <= room) line = line ? line + ' ' + words[wi++] : words[wi++];
        if (!line && wi < words.length) line = words[wi++];
        g.fillText(line, x0, lr.top + lr.height / 2);
      }
    }
    g.restore();
  }
}
