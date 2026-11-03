// Agent HQ v3 — office floor plan. Pure data (no Three.js), so tests can import it in Node.
// World units are meters. Back wall at z = 0, left wall at x = 0; the camera looks from +x,+z.

export const TEAM_ZONE_NAMES = { Research: 'Research corner', Content: 'Content room', Visuals: 'Visuals studio', Ops: 'Ops desk', Codex: 'Codex lab' };
export const DESK = { DX: 2.25, DZ: 2.75 };            // one desk cell
const GAP = 0.5, LEFT_CORRIDOR = 3.0, BACK_D = 5.4, MIN_W = 24;

// desk cell (local, origin = cell centre): desk at z<0, seat at z>0, agent faces -z (toward its monitor)
export function deskCell(cx, cz) {
  return {
    desk: { x: cx, z: cz - 0.55, w: 1.7, d: 0.85 },
    seat: { x: cx, z: cz + 0.32, facing: Math.PI },        // facing -z
    rug: { x: cx, z: cz - 0.1, w: 2.15, d: 2.45 },
    monitor: { x: cx, z: cz - 0.78 },
    chip: { x: cx + 0.62, z: cz - 0.72 },
  };
}

// bots: [{ id, team, seats }]   teams: ordered team names
export function computeLayout(teams, bots) {
  const zones = [], desks = [], obstacles = [], labels = [];
  const block = (x, z, w, d, pad = 0) => obstacles.push({ x0: x - w / 2 - pad, x1: x + w / 2 + pad, z0: z - d / 2 - pad, z1: z + d / 2 + pad });

  // ---- team zones: sizes first, then pick the wrap width that gives the most compact, office-shaped floor ----
  const specs = teams.map(team => {
    const tb = bots.filter(b => b.team === team);
    const seats = Math.max(1, tb.reduce((a, b) => a + Math.max(1, b.seats || 1), 0));
    const cols = seats <= 2 ? 2 : seats <= 6 ? 3 : 4, rows = Math.max(1, Math.ceil(seats / cols));
    return { team, tb, cols, rows, w: cols * DESK.DX + 1.2, d: rows * DESK.DZ + 1.3 };
  });
  const flow = maxX => { let x = LEFT_CORRIDOR, z = BACK_D + 1.1, rowD = 0, W = MIN_W;
    for (const s of specs) { if (x + s.w > maxX && x > LEFT_CORRIDOR) { x = LEFT_CORRIDOR; z += rowD + GAP; rowD = 0; } x += s.w + GAP; rowD = Math.max(rowD, s.d); W = Math.max(W, x - GAP + 0.4); }
    const D = Math.max(z + rowD + 1.5, BACK_D + 9); return { W, D, score: W * D * (1 + 0.5 * Math.abs(W / D - 1.35)) }; };
  let maxX = MIN_W, best = Infinity;
  for (let mx = MIN_W; mx <= 44; mx += 0.5) { const f = flow(mx); if (f.score < best - 1e-6) { best = f.score; maxX = mx; } }
  let x = LEFT_CORRIDOR, z = BACK_D + 1.1, rowD = 0;
  const teamZones = [], rowsInfo = [];
  for (const { team, tb, cols, rows, w, d } of specs) {
    if (x + w > maxX && x > LEFT_CORRIDOR) { rowsInfo.push({ z, d: rowD, end: x }); x = LEFT_CORRIDOR; z += rowD + GAP; rowD = 0; }
    const zone = { id: 'team:' + team, team, kind: 'team', name: TEAM_ZONE_NAMES[team] || `${team} zone`, x0: x, z0: z, x1: x + w, z1: z + d, cols, rows };
    teamZones.push(zone); zones.push(zone);
    // desks: one per seat, row-major, bots in order
    let k = 0;
    for (const b of tb) for (let s = 0; s < Math.max(1, b.seats || 1); s++, k++) {
      const c = k % cols, r = Math.floor(k / cols);
      const cx = x + 0.6 + DESK.DX * (c + 0.5), cz = z + 0.9 + DESK.DZ * (r + 0.5);
      const cell = deskCell(cx, cz);
      desks.push({ botId: b.id, index: s, team, ...cell });
      block(cell.desk.x, cell.desk.z, cell.desk.w, cell.desk.d, 0.18);
    }
    labels.push({ text: zone.name, x: x + 0.25, z: z + d - 0.68, zone: zone.id });   // front strip: never hidden behind monitors
    x += w + GAP; rowD = Math.max(rowD, d);
  }
  rowsInfo.push({ z, d: rowD, end: x });
  const W = Math.max(MIN_W, ...teamZones.map(t => t.x1 + 0.4));
  const nooks = [];
  for (const r of rowsInfo) if (W - 0.4 - r.end >= 3.4 && r.d > 0) {
    const nk = { id: 'nook' + nooks.length, kind: 'nook', name: 'Reading nook', x0: r.end, z0: r.z, x1: W - 0.4, z1: r.z + r.d };
    nooks.push(nk); zones.push(nk); labels.push({ text: nk.name, x: nk.x0 + 0.25, z: nk.z1 - 0.68, zone: nk.id });
    const cx = (nk.x0 + nk.x1) / 2, cz = (nk.z0 + nk.z1) / 2;
    nk.shelf = { x: cx, z: nk.z0 + 0.75, w: Math.min(2.4, nk.x1 - nk.x0 - 1), d: 0.4 }; block(nk.shelf.x, nk.shelf.z, nk.shelf.w, nk.shelf.d, 0.08);
    nk.bags = [{ x: cx - 0.9, z: cz + 0.4 }, { x: cx + 0.9, z: cz + 0.5 }]; for (const b of nk.bags) block(b.x, b.z, 0.7, 0.7, 0.02);
    nk.table = { x: cx, z: cz + 0.45 }; block(cx, cz + 0.45, 0.6, 0.6, 0.05);
    nk.plants = [{ x: nk.x0 + 0.5, z: nk.z1 - 0.5, s: 1.1 }, { x: nk.x1 - 0.5, z: nk.z1 - 0.5, s: 1.3 }];
  }
  const D = Math.max(z + rowD + 1.5, BACK_D + 9);

  // ---- back row: lead office, meeting room, lounge ----
  const lead = { id: 'lead', kind: 'lead', name: 'Lead office', x0: 0.3, z0: 0.3, x1: 6.3, z1: BACK_D };
  const meet = { id: 'meeting', kind: 'meeting', name: 'Meeting room', x0: 6.9, z0: 0.3, x1: 14.1, z1: BACK_D };
  const lounge = { id: 'lounge', kind: 'lounge', name: 'Lounge', x0: 14.7, z0: 0.3, x1: W - 0.3, z1: BACK_D };
  zones.unshift(lead, meet, lounge);
  labels.push({ text: lead.name, x: lead.x0 + 2.0, z: lead.z0 + 0.2, zone: lead.id });
  for (const zz of [meet, lounge]) labels.push({ text: zz.name, x: zz.x0 + 0.25, z: zz.z1 - 0.55, zone: zz.id });

  // lead office: supervisor desk, glass walls on the front + right with a door gap
  const leadDesk = { x: 3.3, z: 2.1, w: 2.2, d: 0.95 };
  block(leadDesk.x, leadDesk.z, leadDesk.w, leadDesk.d, 0.15);
  const supervisor = { x: 3.3, z: 1.25, facing: 0 };               // sits behind the desk, faces the room
  const reportSpot = { x: 3.3, z: 3.3, facing: Math.PI };          // stands in front of the desk
  const glass = [];
  const glassWall = (x0, z0, x1, z1) => { glass.push({ x0, z0, x1, z1 }); obstacles.push({ x0: Math.min(x0, x1) - 0.12, x1: Math.max(x0, x1) + 0.12, z0: Math.min(z0, z1) - 0.12, z1: Math.max(z0, z1) + 0.12 }); };
  glassWall(0.3, BACK_D, 2.2, BACK_D); glassWall(3.6, BACK_D, 6.3, BACK_D); glassWall(6.3, 0.3, 6.3, BACK_D);    // door gap x 2.2..3.6
  // meeting room: table + 6 chairs, glass front with door gap
  const table = { x: 10.5, z: 2.75, w: 3.4, d: 1.3 };
  block(table.x, table.z, table.w, table.d, 0.12);
  const meetingSeats = [];
  for (const sx of [-1.1, 0, 1.1]) { meetingSeats.push({ x: table.x + sx, z: table.z - 1.05, facing: 0 }); meetingSeats.push({ x: table.x + sx, z: table.z + 1.05, facing: Math.PI }); }
  glassWall(6.9, BACK_D, 9.6, BACK_D); glassWall(11.4, BACK_D, 14.1, BACK_D); glassWall(14.1, 0.3, 14.1, BACK_D);
  // lounge: sofa on the back wall, coffee table, rug, coffee machine, armchair, shelves
  const lx = (lounge.x0 + lounge.x1) / 2;
  const sofa = { x: lx - 1.2, z: 0.95, w: 3.2, d: 0.95 };
  block(sofa.x, sofa.z - 0.15, sofa.w, sofa.d - 0.3, 0.05);
  const sofaSeats = [-1.0, 0, 1.0].map(dx => ({ x: sofa.x + dx, z: 1.55, facing: 0 }));
  const coffeeTable = { x: sofa.x, z: 2.75, w: 1.6, d: 0.8 };
  block(coffeeTable.x, coffeeTable.z, coffeeTable.w, coffeeTable.d, 0.12);
  const counter = { x: lounge.x1 - 0.9, z: 0.55, w: 1.5, d: 0.6 };
  block(counter.x, counter.z, counter.w, counter.d, 0.1);
  const coffeeSpots = [{ x: counter.x - 0.35, z: 1.45, facing: Math.PI }, { x: counter.x + 0.45, z: 1.55, facing: Math.PI }];
  const armchair = { x: lounge.x1 - 1.0, z: 3.4, w: 0.95, d: 0.95 };
  block(armchair.x, armchair.z, armchair.w * 0.8, armchair.d * 0.8, 0.05);
  const armSeat = { x: armchair.x - 0.05, z: armchair.z, facing: -Math.PI / 2 };
  const loungeStand = [{ x: lx + 0.9, z: 4.4, facing: 0.5 }, { x: lx + 1.7, z: 4.6, facing: 0.2 }, { x: lx - 2.6, z: 4.5, facing: 0 }, { x: lx - 3.3, z: 3.6, facing: 0 }];
  const shelves = [{ x: lounge.x0 + 0.9, z: 0.42, w: 1.5, d: 0.4 }, { x: 12.9, z: 0.42, w: 1.6, d: 0.4 }];
  for (const s of shelves) block(s.x, s.z, s.w, s.d, 0.08);

  // ---- door (left wall, front), approval kiosk + queue in the left corridor, done board ----
  const door = { x: 0, z: D - 1.7, w: 1.6 };
  const spawn = { x: -0.9, z: door.z };
  const inside = { x: 0.8, z: door.z };
  const kiosk = { x: 1.55, z: BACK_D + 1.05, w: 0.9, d: 0.6 };
  block(kiosk.x, kiosk.z, kiosk.w, kiosk.d, 0.1);
  const queue = []; for (let i = 0; i < 8; i++) queue.push({ x: 1.55, z: kiosk.z + 1.0 + i * 0.85, facing: Math.PI });
  labels.push({ text: 'Approval kiosk', x: 0.35, z: kiosk.z + 0.45, zone: 'kiosk' });
  const board = { x: 5.0, z: BACK_D + 0.55, w: 1.9, d: 0.2 };
  block(board.x, board.z, board.w, board.d, 0.1);
  const boardSpot = { x: 5.0, z: board.z + 0.75, facing: Math.PI };
  // plants in free corners
  const plants = [{ x: 0.6, z: 0.6, s: 1.2 }, { x: 6.0, z: 0.7, s: 0.9 }, { x: 14.4, z: 0.7, s: 1.0 }, { x: W - 0.6, z: 4.8, s: 1.1 },
    { x: 0.6, z: D - 3.2, s: 1.0 }, { x: W - 0.6, z: D - 0.6, s: 1.2 }, { x: lounge.x0 + 0.5, z: 4.8, s: 0.8 }];
  for (const p of [...plants, ...nooks.flatMap(n => n.plants)]) block(p.x, p.z, 0.5 * p.s, 0.5 * p.s, 0.05);

  return {
    W, D, zones, desks, obstacles, labels, glass,
    lead: { zone: lead, desk: leadDesk, supervisor, reportSpot },
    meeting: { zone: meet, table, seats: meetingSeats },
    lounge: { zone: lounge, sofa, sofaSeats, coffeeTable, counter, coffeeSpots, armchair, armSeat, stand: loungeStand, shelves, rug: { x: lx - 0.6, z: 2.5, w: 5.2, d: 3.4 } },
    door, spawn, inside, kiosk, queue, board, boardSpot, plants: [...plants, ...nooks.flatMap(n => n.plants)], nooks,
  };
}

// stable signature: rebuild the static scene only when desks/teams change
export function layoutKey(teams, bots) { return JSON.stringify([teams, bots.map(b => [b.id, b.team, Math.max(1, b.seats || 1)])]); }
