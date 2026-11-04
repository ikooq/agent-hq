// Agent HQ v3 — DOM: KPI cards, team list, activity feed, pipeline, legend, controls, bot card, insights.
// Rule: build nodes once, then only touch what changed (keyed rows, text compared before writing).
const $ = id => document.getElementById(id);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtTok = n => { n = n || 0; return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)); };
const hhmm = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const ago = t => { if (!t) return '—'; const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : Math.floor(s / 86400) + ' d ago'; };
const dur = ms => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${m} min` : m ? `${m} min` : `${s % 60} s`; };
const num = n => (n || 0).toLocaleString('en-US');
const usd = t => t.unpriced && !t.cost ? '$ n/a' : '$' + (t.cost || 0).toFixed(2) + (t.unpriced ? '+' : '');
export const ST = {
  working: { label: 'Working', css: 'var(--working)' }, running: { label: 'Running a command', css: 'var(--running)' }, waiting: { label: 'Waiting on me', css: 'var(--waiting)' },
  stuck: { label: 'Stuck', css: 'var(--stuck)' }, resting: { label: 'Resting', css: 'var(--resting)' }, off: { label: 'Off', css: 'var(--off)' },
};
const ICON = {
  working: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8"/></svg>',
  waiting: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.2 9a3 3 0 0 1 5.6 1.2c0 2-2.8 2.4-2.8 4.3"/><path d="M12 18.2h.01"/><circle cx="12" cy="12" r="9.5"/></svg>',
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  tokens: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
  bellOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.7 3.3A6 6 0 0 1 18 8c0 2.6.4 4.4 1 5.6M17 17H3s3-1 3-8c0-.6.1-1.2.3-1.8"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0M2 2l20 20"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11 12 3l9 8M5 9.5V21h14V9.5"/></svg>',
};
const gitText = g => [g.branch || '?', g.changed ? g.changed + ' changed' : 'clean', g.unpushed ? g.unpushed + ' unpushed' : null, g.behind ? g.behind + ' behind' : null].filter(Boolean).join(' · ');
const setText = (el, v) => { v = String(v); if (el.textContent !== v) el.textContent = v; };
const setAttr = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
const setStyle = (el, k, v) => { if (el.style[k] !== v) el.style[k] = v; };
const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

export class UI {
  constructor({ world, actors, onSelect, onHome, botColorCss, bench }) {
    this.world = world; this.actors = actors; this.onSelect = onSelect; this.onHome = onHome; this.colorOf = botColorCss; this.bench = bench;
    this.state = null; this.selected = null; this.rows = new Map(); this.feedKeys = [];
    this.muted = localStorage.getItem('hq-muted') === '1'; this.mutedSynced = false;
    // KPI cards
    this.kpi = {};
    for (const [k, label, icon, css] of [['working', 'Working', 'working', 'var(--working)'], ['waiting', 'Waiting on me', 'waiting', 'var(--waiting)'], ['done', 'Finished today', 'done', 'var(--resting)'], ['tokens', 'Tokens today', 'tokens', 'var(--ink)']]) {
      const c = h('div', 'kpi ' + k, `<span class="kicon" style="color:${css}">${ICON[icon]}</span><div class="kbody"><div class="klabel">${label}</div><div class="kval">0</div><div class="ksub"></div></div>`);
      $('kpis').appendChild(c); this.kpi[k] = { el: c, val: c.querySelector('.kval'), sub: c.querySelector('.ksub') };
    }
    // header buttons
    this.btnInsights = h('button', 'hbtn text', `${ICON.chart}<span>Timeline &amp; stats</span>`); this.btnInsights.onclick = () => this.openInsights('timeline');
    this.btnHome = h('button', 'hbtn', ICON.home); this.btnHome.title = 'Fit the whole office (Esc)'; this.btnHome.onclick = () => onHome();
    this.btnMute = h('button', 'hbtn'); this.btnMute.onclick = () => { this.muted = !this.muted; localStorage.setItem('hq-muted', this.muted ? '1' : '0'); this.paintMute(); this.pushMute(); this.unlockAudio(); };
    this.btnPhone = h('button', 'hbtn text', `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg><span>Phone</span>`); this.btnPhone.hidden = true; this.btnPhone.title = 'LAN mode is on: link + QR code for your phone'; this.btnPhone.onclick = () => this.openPhone();
    $('hbtns').append(this.btnPhone, this.btnInsights, this.btnHome, this.btnMute); this.paintMute();
    $('phone').addEventListener('click', e => { if (e.target.id === 'phone' || e.target.closest('.m-close')) $('phone').classList.remove('show'); });
    // bottom: time of day + quality
    const tod = $('tod');
    for (const [k, l] of [['now', 'Now'], ['day', 'Day'], ['evening', 'Evening'], ['night', 'Night']]) {
      const b = h('button', 'seg' + (world.hourMode === k ? ' on' : ''), l); b.dataset.k = k;
      b.onclick = () => { world.setHourMode(k); for (const x of tod.children) x.classList.toggle('on', x.dataset.k === k); };
      tod.appendChild(b);
    }
    const q = $('quality'); q.value = world.quality.mode; q.onchange = () => world.setQualityMode(q.value);
    world.onQuality = lvl => { const names = ['High', 'High · 1x pixels', 'Medium · no shadows', 'Low · no glow']; setText($('qualityNow'), world.quality.mode === 'auto' ? 'Auto → ' + names[lvl] : ''); };
    world.onQuality(world.qualityLevel || 0);
    // legend
    $('legend').innerHTML = ['working', 'running', 'waiting', 'stuck', 'resting', 'off'].map(k => `<span><i style="background:${ST[k].css}"></i>${ST[k].label}</span>`).join('');
    // lists: event delegation
    $('team').addEventListener('click', e => { const r = e.target.closest('[data-bot]'); if (r) this.onSelect(r.dataset.robot || null, r.dataset.bot); });
    $('feed').addEventListener('click', e => { const r = e.target.closest('[data-bot]'); if (r) this.onSelect(null, r.dataset.bot); });
    // approvals: Allow once / Deny (Waiting list + kiosk panel), event delegation
    const onDecide = e => { const b = e.target.closest('[data-decide]'); if (b) { e.stopPropagation(); this.decide(b.dataset.id, b.dataset.decide, b); return true; } return false; };
    $('waitList').addEventListener('click', e => { if (onDecide(e)) return; const r = e.target.closest('[data-bot]'); if (r) this.onSelect(r.dataset.robot || null, r.dataset.bot); });
    $('kiosk').addEventListener('click', onDecide);
    setInterval(() => this.tickCountdowns(), 1000);
    // card + insights
    this.card = $('card'); this.modal = $('insights');
    this.modal.addEventListener('click', e => { if (e.target === this.modal) this.closeInsights(); });
    addEventListener('pointerdown', () => this.unlockAudio(), { once: true });
    setInterval(() => { const n = new Date(); setText($('clock'), n.toLocaleTimeString('en-GB', { hour12: false })); setText($('date'), n.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })); }, 1000);
  }

  // ---------- notifications ----------
  paintMute() { this.btnMute.innerHTML = this.muted ? ICON.bellOff : ICON.bell; this.btnMute.classList.toggle('on', this.muted); this.btnMute.title = this.muted ? 'Muted (click to unmute)' : 'Chime + Windows toasts on (click to mute)'; }
  async pushMute() { if (this.bench) return; try { await fetch('/api/mute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ muted: this.muted }) }); } catch (e) {} }
  unlockAudio() { try { this.actx = this.actx || new AudioContext(); if (this.actx.state === 'suspended') this.actx.resume(); } catch (e) {} }
  chime(kind) {
    if (this.muted || !this.actx || this.bench) return;
    const notes = kind === 'stuck' ? [523.25, 392] : [659.25, 880], t0 = this.actx.currentTime;
    notes.forEach((f, i) => { const o = this.actx.createOscillator(), g = this.actx.createGain(); o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + i * .18); g.gain.linearRampToValueAtTime(.07, t0 + i * .18 + .02); g.gain.exponentialRampToValueAtTime(.0001, t0 + i * .18 + .9);
      o.connect(g).connect(this.actx.destination); o.start(t0 + i * .18); o.stop(t0 + i * .18 + 1); });
  }

  // ---------- refresh (called on every state change) ----------
  update(s, prev) {
    this.state = s;
    if (!this.mutedSynced && !this.bench) { this.mutedSynced = true; if (localStorage.getItem('hq-muted') == null) { this.muted = !!s.muted; this.paintMute(); } else if (!!s.muted !== this.muted) this.pushMute(); }
    // transitions -> chime + highlight
    if (prev) {
      const before = new Map(); for (const b of prev.bots) for (const r of b.robots) before.set(r.key, r.status);
      let ring = null;
      for (const b of s.bots) for (const r of b.robots) if ((r.status === 'waiting' || r.status === 'stuck') && before.get(r.key) !== r.status) { ring = ring === 'waiting' ? ring : r.status; this.flash = { key: r.key, until: performance.now() + 8000 }; }
      if (ring) this.chime(ring);
    }
    document.title = s.counts.waiting ? `(${s.counts.waiting}) Agent HQ` : 'Agent HQ';
    const v = s.viewer || this.viewer || { lan: false, canControl: true, canApprove: true }; this.viewer = v;
    document.body.classList.toggle('viewer-lan', !!v.lan); document.body.classList.toggle('can-approve', !!v.canApprove);
    if (!v.lan && !this.bench && Date.now() - (this.lanAt || 0) > 30000) { this.lanAt = Date.now(); fetch('/api/lan').then(r => r.json()).then(l => { this.lan = l; this.btnPhone.hidden = !(l.enabled && l.url); }).catch(() => {}); }
    // KPIs
    setText(this.kpi.working.val, s.counts.working); setText(this.kpi.working.sub, `${s.bots.reduce((a, b) => a + b.robots.filter(r => r.status === 'running').length, 0)} running a command`);
    setText(this.kpi.waiting.val, s.counts.waiting); setText(this.kpi.waiting.sub, s.waiting[0] ? `${s.waiting[0].label} · ${ago(s.waiting[0].since)}` : 'nobody needs you');
    this.kpi.waiting.el.classList.toggle('hot', s.counts.waiting > 0);
    setText(this.kpi.done.val, s.finished.length); setText(this.kpi.done.sub, s.finished[0] ? `last: ${s.finished[0].bot} ${hhmm(s.finished[0].time)}` : '—');
    setText(this.kpi.tokens.val, fmtTok(s.totals.total)); setText(this.kpi.tokens.sub, `${usd(s.totals)} est. · in+out`);
    this.kpi.tokens.el.title = `Today: input ${num(s.totals.in)} · output ${num(s.totals.out)} · cache write ${num(s.totals.cw)} · cache read ${num(s.totals.cr)}\n$ from ~/.agent-hq/prices.json (Codex models unpriced unless added)`;
    this.renderWaiting(s); this.renderTeam(s); this.renderFeed(s); this.renderPipeline(); if (this.cardOpen) this.renderCard();
    if (this.modal.classList.contains('show') && this.tab === 'timeline') this.loadTimeline(true);
  }
  // ---------- waiting on me + approvals (Claude Code only; Codex stays read-only) ----------
  approvalFor(robotKey) { return (this.state && this.state.approvals || []).find(a => a.robot === robotKey) || null; }
  approvalHTML(a, compact) {
    return `<div class="appr" data-appr="${esc(a.id)}"><div class="appr-tool"><b>${esc(a.tool)}</b><span class="appr-left" data-until="${a.until}"></span></div>
      <pre class="appr-detail${compact ? ' compact' : ''}">${esc(a.detail || '(no details)')}</pre>
      <div class="appr-btns"><button class="abtn allow" data-decide="allow" data-id="${esc(a.id)}">Allow once</button><button class="abtn deny" data-decide="deny" data-id="${esc(a.id)}">Deny</button><span class="appr-msg"></span></div></div>`;
  }
  renderWaiting(s) {
    const sec = $('waitSec'), host = $('waitList'), approvals = s.approvals || [];
    const items = s.waiting.map(w => ({ w, a: approvals.find(a => a.robot === w.robot) || null }));
    for (const a of approvals) if (!items.some(x => x.a === a)) items.push({ w: null, a });   // request whose robot is not on the floor yet
    const key = JSON.stringify([items.map(x => [x.w && x.w.robot, x.w && x.w.message, x.a && x.a.id]), s.approvalsOn]);
    sec.hidden = !items.length; setText($('waitCount'), items.length);
    if (key !== this.waitKey) {
      this.waitKey = key;
      host.innerHTML = items.map(({ w, a }) => `<div class="wrow" ${w ? `data-bot="${esc(w.botId)}" data-robot="${esc(w.robot)}"` : ''}>
        <div class="wl1"><b>${esc(w ? w.label : 'Claude Code')}</b><span class="muted">${w ? ago(w.since) : ''}</span></div>
        ${a ? this.approvalHTML(a) : `<div class="wmsg">${esc(w.message || 'Needs your permission')}</div>${s.approvalsOn ? '' : (this.bench ? '' : '<div class="whint muted">Answer in the terminal · approvals from the office are off</div>')}`}</div>`).join('');
    }
    this.renderKiosk(approvals, s);
    this.tickCountdowns();
  }
  renderKiosk(approvals, s) {
    const k = $('kiosk'), a = approvals[0];
    const key = a ? a.id + '|' + approvals.length : '';
    k.hidden = !a;
    if (key === this.kioskKey) return; this.kioskKey = key;
    if (!a) { k.innerHTML = ''; return; }
    const w = s.waiting.find(x => x.robot === a.robot);
    k.innerHTML = `<div class="k-head">Approval kiosk${approvals.length > 1 ? ` · 1 of ${approvals.length}` : ''}</div><div class="k-who">${esc(w ? w.label : 'Claude Code')} wants to use</div>${this.approvalHTML(a, true)}`;
  }
  placeKiosk() {   // keep the kiosk panel next to the kiosk in the 3D office (only while a request is pending)
    const k = $('kiosk'); if (k.hidden || !this.world.kioskGlow) return;
    if (matchMedia('(max-width: 760px)').matches) { k.style.transform = ''; return; }   // phone layout: docked by CSS
    const v = this.world.kioskGlow.clone().project(this.world.camera), H = this.world.viewH || innerHeight;
    const x = Math.round((v.x * .5 + .5) * innerWidth), y = Math.round((-v.y * .5 + .5) * H);
    const tx = Math.max(12, Math.min(innerWidth - k.offsetWidth - 12, x + 28)), ty = Math.max(90, Math.min(innerHeight - k.offsetHeight - 110, y - k.offsetHeight / 2));
    const t = `translate(${tx}px, ${ty}px)`; if (k.style.transform !== t) k.style.transform = t;
  }
  tickCountdowns() {
    for (const el of document.querySelectorAll('.appr-left[data-until]')) { const left = Math.max(0, Math.round((+el.dataset.until - Date.now()) / 1000)); setText(el, left ? `office closes in ${left} s · terminal works too` : 'answer in the terminal'); }
  }
  async token() {
    if (this.tok) return this.tok;
    const r = await (await fetch('/api/approvals/token', { cache: 'no-store' })).json(); this.tok = r.token; return this.tok;
  }
  async decide(id, decision, btn) {
    const box = btn.closest('.appr'), msg = box && box.querySelector('.appr-msg');
    for (const b of box ? box.querySelectorAll('button') : []) b.disabled = true;
    try {
      const tok = await this.token();
      const res = await fetch('/api/approvals/decide', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HQ-Secret': tok || '' }, body: JSON.stringify({ id, decision }) });
      const j = await res.json().catch(() => ({}));
      if (res.status === 403) this.tok = null;
      if (msg) msg.textContent = res.ok ? (decision === 'allow' ? 'Allowed once' : 'Denied') : (j.error || 'Could not send');
      if (!res.ok) for (const b of box.querySelectorAll('button')) b.disabled = false;
    } catch (e) { if (msg) msg.textContent = 'Server offline'; }
  }
  renderTeam(s) {
    const order = { Research: 0, Content: 1, Visuals: 2, Ops: 3, Codex: 4 };
    const bots = [...s.bots].sort((a, b) => (order[a.team] ?? 9) - (order[b.team] ?? 9) || a.name.localeCompare(b.name));
    const host = $('team'); const seen = new Set();
    setText($('teamCount'), `${s.bots.length}`);
    bots.forEach((b, i) => {
      seen.add(b.id);
      let row = this.rows.get(b.id);
      if (!row) {
        const el = h('button', 'trow', `<span class="av"></span><span class="tmain"><span class="tl1"><b class="nm"></b><span class="role"></span><span class="chip"></span></span><span class="act"></span></span>`);
        el.dataset.bot = b.id; row = { el, av: el.querySelector('.av'), nm: el.querySelector('.nm'), role: el.querySelector('.role'), chip: el.querySelector('.chip'), act: el.querySelector('.act') };
        this.rows.set(b.id, row);
      }
      if (host.children[i] !== row.el) host.insertBefore(row.el, host.children[i] || null);
      const r = b.robots[0], st = b.status;
      row.el.dataset.robot = r ? r.key : '';
      setStyle(row.av, 'background', this.colorOf(b));
      setText(row.nm, b.name + (b.robots.length > 1 ? ` ×${b.robots.length}` : ''));
      setText(row.role, b.team + (b.source === 'codex' ? ' · Codex' : ''));
      setText(row.chip, (ST[st] || ST.off).label); setAttr(row.chip, 'data-st', st);
      setText(row.act, r ? r.step : (b.lastLine ? `off · last line ${ago(b.lastLine)}` : 'off · no session yet'));
      row.el.classList.toggle('sel', !!(this.selected && (this.selected.botId === b.id)));
    });
    for (const [id, row] of this.rows) if (!seen.has(id)) { row.el.remove(); this.rows.delete(id); }
  }
  renderFeed(s) {
    const host = $('feed'); const want = s.feed.slice(0, 40); const keys = want.map(f => `${f.t}|${f.botId}|${f.text}`);
    if (keys.join('\n') === this.feedKeys.join('\n')) return;
    const have = new Map([...host.children].map(el => [el.dataset.key, el]));
    keys.forEach((k, i) => {
      let el = have.get(k);
      if (!el) { const f = want[i]; el = h('div', 'frow ' + f.kind, `<time>${hhmm(f.t)}</time><span><b>${esc(f.bot)}</b> ${esc(f.text)}</span>`); el.dataset.key = k; el.dataset.bot = f.botId; }
      have.delete(k);
      if (host.children[i] !== el) host.insertBefore(el, host.children[i] || null);
    });
    for (const el of have.values()) el.remove();
    this.feedKeys = keys;
    if (!keys.length && !host.querySelector('.empty')) host.innerHTML = '<div class="empty">No activity yet today.</div>';
  }
  // ---------- selection, pipeline, card ----------
  select(key, botId) {
    const s = this.state; if (!s) return;
    let b = s.bots.find(x => x.id === botId) || s.bots.find(x => x.robots.some(r => r.key === key));
    if (!b) return;
    const r = (key && b.robots.find(x => x.key === key)) || b.robots[0] || null;
    this.selected = { key: r ? r.key : null, botId: b.id };
    this.cardOpen = true; this.card.classList.add('show'); this.renderCard(); this.renderPipeline(); this.renderTeam(s);
  }
  closeCard() { this.cardOpen = false; this.selected = null; this.card.classList.remove('show'); this.renderPipeline(); if (this.state) this.renderTeam(this.state); }
  target() {
    const s = this.state; if (!s) return null;
    if (this.selected) { const b = s.bots.find(x => x.id === this.selected.botId); if (b) return { b, r: b.robots.find(x => x.key === this.selected.key) || b.robots[0] || null }; }
    // default: the agent that needs me, else the most recently active one
    let best = null; for (const b of s.bots) for (const r of b.robots) { const score = (r.status === 'waiting' ? 1e15 : 0) + (r.lastLine || 0); if (!best || score > best.score) best = { b, r, score }; }
    return best;
  }
  renderPipeline() {
    const t = this.target(), host = $('pipeline');
    if (!t || !t.r || !t.r.turn) { setText($('pipeTitle'), t ? `${t.b.name}: no task right now` : 'Select an agent to see its task'); for (const el of host.querySelectorAll('.stage')) { el.className = 'stage'; setText(el.querySelector('em'), '—'); } return; }
    const { r, b } = t, tn = r.turn;
    setText($('pipeTitle'), `${r.label}${this.selected ? '' : ' (latest)'}${r.task ? ` · “${r.task}”` : ''} · ${r.step}`);
    const stages = [['requested', tn.requested], ['working', tn.working], ['approval', tn.approval], ['done', tn.done]];
    const cur = tn.done ? 'done' : r.status === 'waiting' ? 'approval' : tn.working ? 'working' : 'requested';
    for (const [k, time] of stages) {
      const el = host.querySelector(`[data-stage="${k}"]`);
      const cls = 'stage' + (k === cur ? ' cur' : time ? ' past' : '') + (k === 'approval' && !time && cur !== 'approval' ? ' skip' : '');
      if (el.className !== cls) el.className = cls;
      setText(el.querySelector('em'), time ? hhmm(time) : k === 'approval' && tn.done ? 'not needed' : '—');
    }
  }
  renderCard() {
    const t = this.target(); if (!t || !this.selected) return;
    const { b, r } = t; const st = r ? r.status : 'off';
    const tok = r ? r.tokens : b.tokens; const scope = r && b.robots.length > 1 ? 'this session' : 'whole bot';
    const key = JSON.stringify([b.id, b.git, r && r.key, st, r && r.step, r && r.task, tok, r && r.actions && r.actions.length && r.actions[0].t, r && r.helpers]);
    if (key === this.cardKey && Date.now() - (this.cardAt || 0) < 15000) return;
    this.cardKey = key; this.cardAt = Date.now();
    this.card.innerHTML = `
      <div class="bc-head"><span class="av big" style="background:${this.colorOf(b)}"></span><div class="bc-title"><div class="bc-name">${esc(r ? r.label : b.name)}</div>
        <div class="bc-status" style="color:${(ST[st] || ST.off).css}">${esc((ST[st] || ST.off).label)}${r ? ' · ' + esc(dur(Date.now() - r.statusSince)) : ''}</div></div>
        <button class="hbtn bc-close" aria-label="Close">✕</button></div>
      <div class="bc-body">
        <p class="bc-job">${esc(b.job || '—')}</p>
        ${r && r.task ? `<div class="bc-task"><span>Task</span>${esc(r.task)}</div>` : ''}
        ${r ? `<div class="bc-step">${st === 'running' && r.runningSince ? `<b>${dur(Date.now() - r.runningSince)}</b> · ` : ''}${esc(r.step)}</div>` : '<div class="bc-step muted">No live session. The desk is empty.</div>'}
        <dl class="bc-grid"><dt>Team</dt><dd>${esc(b.team)}${b.source === 'codex' ? ' · Codex' : ' · Claude Code'}</dd>
          <dt>Model</dt><dd>${esc(r ? r.modelLabel : b.modelLabel)}</dd>
          <dt>Folder</dt><dd class="mono">${esc(r && r.kind === 'subagent' ? 'subagent: ' + r.agentType : (r && r.cwd) || '—')}</dd>
          ${b.git ? `<dt>Git</dt><dd class="mono gitv">${esc(gitText(b.git))}${b.git.dirtyOld ? ` <span class="gitold" title="Uncommitted changes older than 2 hours">● since ${esc(ago(b.git.dirtySince))}</span>` : ''}</dd>` : ''}
          <dt>Session</dt><dd>${r ? `${dur(Date.now() - r.start)} <span class="muted">since ${hhmm(r.start)}</span>` : '—'}</dd>
          <dt>Last line</dt><dd>${r && r.lastLine ? `${hhmm(r.lastLine)} <span class="muted">${ago(r.lastLine)}</span>` : (b.lastLine ? ago(b.lastLine) : '—')}</dd></dl>
        <h3>Tokens today <span class="muted">(${scope})</span></h3>
        <div class="bc-tok"><div class="tile"><span>Input</span><b>${num(tok.in)}</b></div><div class="tile"><span>Output</span><b>${num(tok.out)}</b></div>
          <div class="tile"><span>Cache write</span><b>${num(tok.cw)}</b></div><div class="tile"><span>Cache read</span><b>${num(tok.cr)}</b></div>
          <div class="tile wide"><span>Tokens today (in + out) · est. cost</span><b>${num(tok.total)} · ${usd(tok)}</b></div></div>
        ${r && r.helpers && r.helpers.length ? `<h3>Helpers</h3><div class="bc-helpers">${r.helpers.map(x => `<div><i class="dot" style="background:${(ST[x.status] || ST.working).css}"></i><b>${esc(x.type)}</b> <span class="muted">${esc(x.step || x.status)}</span></div>`).join('')}</div>` : ''}
        <h3>Last actions</h3>
        <ol class="bc-actions">${r && r.actions.length ? r.actions.map(a => `<li><time>${hhmm(a.t)}</time><span>${esc(a.text)}</span></li>`).join('') : '<li class="muted">No actions yet.</li>'}</ol>
      </div>
      <div class="bc-foot"><button class="hbtn text bc-open" ${b.canOpen && !this.bench ? '' : 'disabled title="Only folders listed in roster.json can be opened"'}>Open folder</button><button class="hbtn text bc-code" ${b.canOpen && !this.bench ? '' : 'disabled title="Only folders listed in roster.json can be opened"'}>Open in VS Code</button><span class="bc-msg muted"></span></div>`;
    this.card.querySelector('.bc-close').onclick = () => this.onSelect(null, null, true);
    const open = app => async () => {
      const msg = this.card.querySelector('.bc-msg');
      try { const res = await fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: b.id, app }) }); const j = await res.json(); msg.textContent = res.ok ? (app === 'vscode' ? 'Opening VS Code…' : 'Opened in Explorer') : (j.error || 'Could not open'); }
      catch (e) { msg.textContent = 'Server offline'; }
    };
    this.card.querySelector('.bc-open').onclick = open(null);
    this.card.querySelector('.bc-code').onclick = open('vscode');
  }

  // ---------- insights: timeline + stats (v2 views, as tabs) ----------
  openInsights(tab) { this.modal.classList.add('show'); this.tab = tab; this.renderInsightsShell(); this.loadTab(); }
  loadTab() { this.tab === 'timeline' ? this.loadTimeline() : this.tab === 'report' ? this.loadReport() : this.loadStats(); }
  closeInsights() { this.modal.classList.remove('show'); }
  renderInsightsShell() {
    this.modal.innerHTML = `<div class="modal-card"><div class="m-head"><div class="tabs"><button data-tab="timeline" class="${this.tab === 'timeline' ? 'on' : ''}">Today's timeline</button><button data-tab="stats" class="${this.tab === 'stats' ? 'on' : ''}">Stats · 7 days</button><button data-tab="report" class="${this.tab === 'report' ? 'on' : ''}">Report</button></div>
      <span class="muted">tokens = input + output · $ are estimates</span><button class="hbtn m-close" aria-label="Close">✕</button></div><div class="m-body" id="mbody"><div class="empty">Loading…</div></div><div class="tl-tip" id="tip"></div></div>`;
    this.modal.querySelector('.m-close').onclick = () => this.closeInsights();
    for (const b of this.modal.querySelectorAll('[data-tab]')) b.onclick = () => { this.tab = b.dataset.tab; this.renderInsightsShell(); this.loadTab(); };
    const tip = this.modal.querySelector('#tip');
    this.modal.onmousemove = e => { const el = e.target.closest('[data-tip]'); if (!el) { tip.style.display = 'none'; return; } tip.textContent = el.dataset.tip; tip.style.display = 'block'; tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY - 40) + 'px'; };
  }
  async loadTimeline(soft) {
    if (soft && Date.now() - (this.tlAt || 0) < 30000) return; this.tlAt = Date.now();
    let d; try { d = this.bench ? { dayStart: new Date().setHours(0, 0, 0, 0), rows: [] } : await (await fetch('/timeline')).json(); } catch (e) { return; }
    const s = this.state, COL = { working: '#3fae7c', waiting: '#e39a2d', stuck: '#e0565f', resting: '#7d98df' }, LBL = { working: 'Working', waiting: 'Waiting on me', stuck: 'Stuck', resting: 'Resting' };
    const rows = new Map(d.rows.map(r => [r.botId, r])), span = 86400000, pct = t => ((t - d.dayStart) / span * 100);
    const body = this.modal.querySelector('#mbody'); if (!body || this.tab !== 'timeline') return;
    body.innerHTML = `<div class="tl-legend">${Object.keys(COL).map(k => `<span><i style="background:${COL[k]}"></i>${LBL[k]}</span>`).join('')}</div>
      <div class="tl-axis"><div class="tl-lab"></div><div class="tl-track">${[0, 3, 6, 9, 12, 15, 18, 21, 24].map(hh => `<span class="tk" style="left:${hh / 24 * 100}%">${String(hh).padStart(2, '0')}:00</span>`).join('')}</div></div>
      ${(s ? s.bots : []).map(b => `<div class="tl-row"><div class="tl-lab">${esc(b.name)}</div><div class="tl-track">${(rows.get(b.id) || { segments: [] }).segments.map(([a, z, st]) =>
        `<b class="tseg" data-tip="${esc(b.name)} · ${LBL[st]} ${hhmm(a)}–${hhmm(Math.min(z, Date.now()))} (${dur(Math.min(z, Date.now()) - a)})" style="left:${pct(a)}%;width:max(2px, calc(${(z - a) / span * 100}% - 1px));background:${COL[st]}"></b>`).join('')}
        <i class="now" style="left:${pct(Date.now())}%"></i></div></div>`).join('')}`;
  }
  // daily report: built on the server from local logs (child process), shown in a sandboxed frame
  async loadReport(day, fresh) {
    const body = this.modal.querySelector('#mbody'); if (!body || this.tab !== 'report') return;
    const today = new Date(); const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    day = day || this.reportDay || iso(today); this.reportDay = day;
    let saved = []; try { saved = this.bench ? [] : await (await fetch('/api/reports')).json(); } catch (e) {}
    body.innerHTML = `<div class="rp-bar"><label>Day <input type="date" id="rpDate" value="${esc(day)}" max="${iso(today)}"></label>
      <button class="hbtn text" id="rpFresh">Rebuild</button><a class="hbtn text" id="rpOpen" target="_blank" rel="noopener" href="/report?date=${esc(day)}">Open in a new tab</a>
      <span class="muted">Saved: ${saved.slice(0, 7).map(d => `<a href="#" data-day="${esc(d)}">${esc(d.slice(5))}</a>`).join(' · ') || 'none yet'} · written automatically at 23:00</span></div>
      <div class="rp-wrap"><div class="empty" id="rpWait">Building the report from local logs…</div><iframe id="rpFrame" sandbox title="Daily report"></iframe></div>`;
    const frame = body.querySelector('#rpFrame');
    frame.onload = () => { const w = body.querySelector('#rpWait'); if (w) w.remove(); };
    frame.src = this.bench ? 'about:blank' : `/report?date=${encodeURIComponent(day)}${fresh ? '&fresh=1' : ''}`;
    body.querySelector('#rpDate').onchange = e => { if (e.target.value) this.loadReport(e.target.value); };
    body.querySelector('#rpFresh').onclick = () => this.loadReport(day, true);
    for (const a of body.querySelectorAll('[data-day]')) a.onclick = e => { e.preventDefault(); this.loadReport(a.dataset.day); };
  }
  async openPhone() {   // link + QR code (drawn from the server's matrix, no libraries)
    const m = $('phone'); let l = null; try { l = await (await fetch('/api/lan')).json(); } catch (e) {}
    m.innerHTML = `<div class="modal-card phone-card"><div class="m-head"><b>Office on your phone</b><button class="hbtn m-close" aria-label="Close">✕</button></div><div class="m-body">${!l || !l.url ? '<div class="empty">LAN mode is off. Run <code>agent-hq lan on</code>.</div>' :
      `<canvas id="qrc" width="296" height="296"></canvas><p>Scan with the phone camera (same Wi-Fi), or open:</p><p class="mono">${esc(l.url)}</p>
      <p class="muted">${l.listening ? 'Listening on ' + esc(l.ip) : 'Not listening: ' + esc(l.error || '?')} · read-only${l.approvals ? ' · Allow once / Deny allowed from the phone' : ''}. The link holds a secret token: share it only with yourself. <code>agent-hq lan off</code> invalidates it.</p>`}</div></div>`;
    m.classList.add('show');
    const c = m.querySelector('#qrc'); if (!c || !l.qr) return;
    const g = c.getContext('2d'), n = l.qr.length, q = 3, s = Math.floor(c.width / (n + 2 * q)), off = Math.floor((c.width - s * (n + 2 * q)) / 2);
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000';
    l.qr.forEach((row, y) => { for (let x = 0; x < n; x++) if (row[x] === '1') g.fillRect(off + (x + q) * s, off + (y + q) * s, s, s); });
  }
  async loadStats() {
    let d; try { d = this.bench ? { days: [], busiestToday: null } : await (await fetch('/stats')).json(); } catch (e) { return; }
    const body = this.modal.querySelector('#mbody'); if (!body || this.tab !== 'stats') return;
    const days = d.days; if (!days.length) { body.innerHTML = '<div class="empty">No stats in bench mode.</div>'; return; }
    const label = day => new Date(day.date + 'T12:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
    const totals = days.map(x => ({ tok: (x.total && x.total.total) || 0, cost: (x.total && x.total.cost) || 0 }));
    const maxDay = Math.max(1, ...totals.map(t => t.tok)), week = totals.reduce((a, t) => ({ tok: a.tok + t.tok, cost: a.cost + t.cost }), { tok: 0, cost: 0 });
    const names = new Map((this.state ? this.state.bots : []).map(b => [b.id, b.name]));
    const ids = new Set(); days.forEach(x => Object.keys(x.bots || {}).forEach(id => ids.add(id)));
    const per = [...ids].map(id => { const se = days.map(x => (x.bots && x.bots[id]) || null); return { id, name: names.get(id) || (se.find(Boolean) || {}).name || id, se, tok: se.reduce((a, v) => a + (v ? v.total || 0 : 0), 0), cost: se.reduce((a, v) => a + (v ? v.cost || 0 : 0), 0), today: se[6] ? se[6].total || 0 : 0 }; }).sort((a, b) => b.tok - a.tok);
    const maxCell = Math.max(1, ...per.flatMap(p => p.se.map(v => v ? v.total || 0 : 0))), best = d.busiestToday;
    body.innerHTML = `<div class="m-tiles"><div class="tile big"><span>Busiest bot today</span><b>${best ? esc(best.name) : '—'}</b><em>${best ? `${fmtTok(best.tokens)} tokens · $${(best.cost || 0).toFixed(2)}` : 'no activity yet'}</em></div>
      <div class="tile big"><span>Today</span><b>${fmtTok(totals[6].tok)}</b><em>$${totals[6].cost.toFixed(2)} estimated</em></div><div class="tile big"><span>Last 7 days</span><b>${fmtTok(week.tok)}</b><em>$${week.cost.toFixed(2)} estimated</em></div></div>
      <h3>Tokens per day</h3><div class="m-days">${days.map((x, i) => `<div class="m-day" data-tip="${esc(label(x))}: ${num(totals[i].tok)} tokens · $${totals[i].cost.toFixed(2)}"><div class="m-bar-wrap">${i === 6 && totals[i].tok ? `<span class="m-val">${fmtTok(totals[i].tok)}</span>` : ''}<div class="m-bar" style="height:${totals[i].tok ? Math.max(3, totals[i].tok / maxDay * 100) : 0}%"></div></div><span class="m-lab ${i === 6 ? 'today' : ''}">${esc(label(x))}</span></div>`).join('')}</div>
      <h3>Per bot</h3><table class="m-table"><thead><tr><th>Bot</th><th>Last 7 days</th><th>Today</th><th>7 days</th><th>7-day $</th></tr></thead><tbody>${per.map(p => `<tr><td class="b">${esc(p.name)}</td><td><div class="spark">${p.se.map((v, i) => `<i data-tip="${esc(p.name)} · ${esc(label(days[i]))}: ${num(v ? v.total : 0)} tokens" style="height:${v && v.total ? Math.max(8, v.total / maxCell * 100) : 0}%"></i>`).join('')}</div></td><td class="n">${fmtTok(p.today)}</td><td class="n">${fmtTok(p.tok)}</td><td class="n">$${p.cost.toFixed(2)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No token usage recorded yet.</td></tr>'}</tbody></table>`;
  }
}
