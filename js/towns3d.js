/*
 * Borrowed Crown: the settlements.
 *
 * A village is a ring of sharpened logs round thatched cottages and a hall. A town has a stone
 * curtain wall with towers, a gatehouse, a keep, a church and a market square. A city has more
 * of all of it, a citadel and a cathedral spire. Every one flies the banner of whoever holds it
 * and shows the state it is in: gates barred under siege, grey and smokeless when it starves,
 * burning and then scorched after a sack, a torchlit crowd when it is close to revolt, snow on
 * the roofs in winter, lit windows at dusk.
 *
 * Everything that never moves is merged into one mesh, so every town on the map is one draw
 * call. Per-town state reaches that mesh as a small uniform array, so nothing is rebuilt while
 * the game runs. Banners, smoke, flames, townsfolk and firelight are one instanced mesh each.
 * Banners and fires are drawn larger than life from far away, so that who holds a town and
 * which towns are burning can be read with the whole realm in view.
 *
 * Besides the fixed surface (setTheme, update, dispose) there is site(id), which tells other
 * modules how a town was built: where its wall and gates are and how high its banners fly.
 *
 * Needs THREE (three.js r149). Map (x, y) with height h sits at scene (x, h, y).
 */
(function () {
  'use strict';
  const BC = (window.BC = window.BC || {});
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const frac = (v) => v - Math.floor(v);
  const wrap = (a) => a - TAU * Math.round(a / TAU);
  const toward = (v, to, step) => (v < to ? Math.min(to, v + step) : Math.max(to, v - step));
  const c0 = (v) => (v > 0 ? v : 0);

  function hash(a, b) {
    let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function stream(seed) { let i = 0; return () => hash(seed, ++i); }
  const tint = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  const pick = (list, r) => list[Math.min(list.length - 1, Math.floor(r * list.length))];

  const LOW = 0.84;                  // how much a wall darkens toward the ground
  const EAVE = 0.5;                  // how much of the snow on a ridge reaches the eaves
  const MOVE = 4;                    // the furthest a gate leaf or a market stall travels, in map units
  const WIND = 0.22;                 // the way the wind blows, as a map angle: banners and smoke lean this way
  const DROP = 0.38, RISE = 0.62;    // seconds for a banner to come down and for its successor to go up
  const MAX_SMOKE = 900, MAX_FLAME = 360, MAX_FOLK = 420;
  const FAR = 520;                   // beyond this a town's hearth smoke and townsfolk are a pixel or two, and are not drawn
  const SPOTS = [4, 0, 2, 6, 8, 1, 3, 5, 7];   // the order a footprint's nine sample points are tried in

  // Colours, 0..255, drawn from the same restrained palette as the land. Only banners are saturated.
  const STONE = [176, 171, 158], STONE_LT = [190, 184, 170], STONE_DK = [146, 141, 131], WALK = [136, 132, 122];
  const CHURCH = [214, 208, 192], SLATE = [104, 110, 122];
  const TIMBER = [138, 106, 72], TIMBER_DK = [98, 74, 52], LOG_TIP = [186, 154, 110];
  const PLASTER = [[230, 220, 198], [222, 206, 176], [236, 228, 210], [212, 196, 164]];
  const DAUB = [[204, 182, 144], [190, 168, 132], [214, 196, 160]];
  const TILE = [[165, 86, 60], [176, 98, 66], [150, 78, 56], [184, 110, 76]];
  const THATCH = [[196, 166, 104], [180, 152, 96], [206, 178, 116], [166, 144, 100]];
  const EARTH = [150, 130, 96], TURF = [126, 130, 86], COBBLE = [124, 117, 104], PAVING = [150, 142, 126], STREET = [160, 134, 98];
  const PANE = [84, 80, 80], WATER = [86, 116, 132];
  const CANVAS = [[226, 212, 176], [204, 176, 128], [176, 170, 160]];
  const FOLK = [[124, 98, 74], [150, 134, 108], [100, 104, 100], [172, 152, 122], [112, 86, 72], [136, 120, 96]];

  // What each size of settlement is built to. Heights follow the scale every module shares.
  const SPEC = [null, {
    inset: 1.7, wallH: 3.2, wallT: 1.3, spacing: 8.5, towerR: 0, square: 4.6, lane: 2.4, mainHw: 2.75, sideHw: 2.55,
  }, {
    inset: 3.8, wallH: 5.6, wallT: 1.7, spacing: 17, towerR: 2.1, towerH: 8.4, square: 6.2, lane: 2.6,
    gate: { pw: 2.6, arch: 4.3, towerR: 2.3, towerH: 9.6, over: 1.9, depth: 1.9, fwd: 0.6 }, mainHw: 2.6 + 0.924 * 2.3, sideHw: 3.0,
  }, {
    inset: 4.6, wallH: 7.6, wallT: 2.3, spacing: 17.5, towerR: 2.7, towerH: 10.8, square: 7.8, lane: 2.7,
    gate: { pw: 2.8, arch: 4.9, towerR: 3.1, towerH: 12.4, over: 2.2, depth: 2.4, fwd: 0.6 }, mainHw: 2.8 + 0.924 * 3.1, sideHw: 3.2,
  }];

  /* ----- a small mesh builder (this build of three.js has no BufferGeometryUtils) ----- */

  /**
   * Collects triangles for one big merged mesh. Shapes are described in a local frame set with
   * at(); every face is wound to look away from a point inside its solid (core()), so no shape
   * has to think about winding. Besides position and colour each vertex carries which town it
   * belongs to, how much snow settles on it, when it chars in a sack, whether it is a window,
   * and how far it travels when the town's gates open.
   */
  class Mesher {
    constructor() {
      this.pos = []; this.col = []; this.fx = []; this.mv = []; this.idx = []; this.n = 0;
      this.ox = 0; this.oy = 0; this.oz = 0; this.ca = 1; this.sa = 0;
      this.kx = 0; this.ky = 0; this.kz = 0;
      this.c = STONE; this.town = 0; this.snow = 0; this.char = 0; this.glow = 0;
      this.mx = 0; this.my = 0; this.mz = 0;
    }

    /** Local frame: origin at map (x, y) and height h, local x along map angle `a`, local z a quarter turn on from it. */
    at(x, y, h, a) { this.ox = x; this.oy = h; this.oz = y; this.ca = Math.cos(a); this.sa = Math.sin(a); }

    /** A point inside the solid about to be built; faces are wound to look away from it. */
    core(x, y, z) { this.kx = this.ox + x * this.ca - z * this.sa; this.ky = this.oy + y; this.kz = this.oz + x * this.sa + z * this.ca; }

    /** How far the vertices that follow move when the gates are open (local units). */
    shift(x, y, z) { this.mx = x; this.my = y; this.mz = z; }

    v(x, y, z, k) {
      const ca = this.ca, sa = this.sa, c = this.c, q = 127 / MOVE;
      if (k === undefined) k = 1;
      this.pos.push(this.ox + x * ca - z * sa, this.oy + y, this.oz + x * sa + z * ca);
      this.col.push(c[0] * k, c[1] * k, c[2] * k);
      this.fx.push(this.town, this.snow * 255, this.char * 255, this.glow * 255);
      this.mv.push(Math.round((this.mx * ca - this.mz * sa) * q), Math.round(this.my * q), Math.round((this.mx * sa + this.mz * ca) * q), 0);
      return this.n++;
    }

    tri(a, b, c) {
      const p = this.pos, A = a * 3, B = b * 3, C = c * 3;
      const ux = p[B] - p[A], uy = p[B + 1] - p[A + 1], uz = p[B + 2] - p[A + 2];
      const vx = p[C] - p[A], vy = p[C + 1] - p[A + 1], vz = p[C + 2] - p[A + 2];
      const out = (uy * vz - uz * vy) * (p[A] - this.kx) + (uz * vx - ux * vz) * (p[A + 1] - this.ky) + (ux * vy - uy * vx) * (p[A + 2] - this.kz);
      if (out >= 0) this.idx.push(a, b, c); else this.idx.push(a, c, b);
    }

    quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }

    /**
     * A box between two local corners, without a floor. The walls share eight vertices and darken
     * toward the ground. `cap` is the lid: null for none, a colour for a lid of its own, otherwise
     * the wall colour. A lid that takes snow gets its own vertices so the white stays on top.
     * `open` leaves out the two faces across local x ('x') or across local z ('z').
     */
    box(x0, y0, z0, x1, y1, z1, cap, capSnow, open) {
      this.core((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      const a = this.v(x0, y0, z0, LOW), b = this.v(x1, y0, z0, LOW), c = this.v(x1, y0, z1, LOW), d = this.v(x0, y0, z1, LOW);
      const e = this.v(x0, y1, z0), f = this.v(x1, y1, z0), g = this.v(x1, y1, z1), h = this.v(x0, y1, z1);
      if (open !== 'x') { this.quad(a, d, h, e); this.quad(b, c, g, f); }
      if (open !== 'z') { this.quad(a, b, f, e); this.quad(d, c, g, h); }
      if (cap === null) return;
      if (!cap && !capSnow) { this.quad(e, f, g, h); return; }
      const keep = this.c, snow = this.snow;
      this.c = cap || keep; this.snow = capSnow || 0;
      this.quad(this.v(x0, y1, z0), this.v(x1, y1, z0), this.v(x1, y1, z1), this.v(x0, y1, z1));
      this.c = keep; this.snow = snow;
    }

    /** A pitched roof over a local rectangle, ridge along local x. `wall` fills in the two gable ends. */
    gable(x0, z0, x1, z1, y, rise, over, wall) {
      const zm = (z0 + z1) / 2, drop = rise * over / ((z1 - z0) / 2), snow = this.snow;
      this.core((x0 + x1) / 2, y - 1, zm);
      this.snow = EAVE;                      // snow lies thin at the eaves and thick on the ridge
      const a = this.v(x0 - over, y - drop, z0 - over, 0.9), b = this.v(x1 + over, y - drop, z0 - over, 0.9);
      const c = this.v(x1 + over, y - drop, z1 + over, 0.9), d = this.v(x0 - over, y - drop, z1 + over, 0.9);
      this.snow = 1;
      const e = this.v(x0 - over, y + rise, zm), f = this.v(x1 + over, y + rise, zm);
      this.quad(a, b, f, e); this.quad(d, c, f, e);
      this.snow = snow;
      if (!wall) return;
      const keep = this.c;
      this.c = wall;
      this.tri(this.v(x0, y, z0), this.v(x0, y, z1), this.v(x0, y + rise, zm));
      this.tri(this.v(x1, y, z0), this.v(x1, y, z1), this.v(x1, y + rise, zm));
      this.c = keep;
    }

    /** A hipped roof: like a gable, but the ridge stops `inset` short of each end. inset of half the length makes a pyramid. */
    hip(x0, z0, x1, z1, y, rise, over, inset) {
      const zm = (z0 + z1) / 2, drop = rise * over / ((z1 - z0) / 2), snow = this.snow;
      this.core((x0 + x1) / 2, y - 1, zm);
      this.snow = EAVE;
      const a = this.v(x0 - over, y - drop, z0 - over, 0.9), b = this.v(x1 + over, y - drop, z0 - over, 0.9);
      const c = this.v(x1 + over, y - drop, z1 + over, 0.9), d = this.v(x0 - over, y - drop, z1 + over, 0.9);
      this.snow = 1;
      const e = this.v(x0 + inset, y + rise, zm), f = this.v(x1 - inset, y + rise, zm);
      this.quad(a, b, f, e); this.quad(d, c, f, e); this.tri(a, d, e); this.tri(b, c, f);
      this.snow = snow;
    }

    /** An upright prism with n sides (a tower, a post, a well), r0 wide at y0 and r1 wide at y1. Lid as for box(). */
    drum(n, cx, cz, r0, r1, y0, y1, cap, capSnow, turn) {
      this.core(cx, (y0 + y1) / 2, cz);
      const base = this.n;
      turn = turn || 0;
      for (let i = 0; i < n; i++) {
        const a = turn + i / n * TAU, ca = Math.cos(a), sa = Math.sin(a);
        this.v(cx + ca * r0, y0, cz + sa * r0, LOW); this.v(cx + ca * r1, y1, cz + sa * r1);
      }
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; this.quad(base + i * 2, base + j * 2, base + j * 2 + 1, base + i * 2 + 1); }
      if (cap === null) return;
      let lid = base + 1, stride = 2;
      if (cap || capSnow) {
        const keep = this.c, snow = this.snow;
        this.c = cap || keep; this.snow = capSnow || 0;
        lid = this.n; stride = 1;
        for (let i = 0; i < n; i++) { const a = turn + i / n * TAU; this.v(cx + Math.cos(a) * r1, y1, cz + Math.sin(a) * r1); }
        this.c = keep; this.snow = snow;
      }
      for (let i = 1; i + 1 < n; i++) this.tri(lid, lid + i * stride, lid + (i + 1) * stride);
    }

    /** A cone with n sides: a tower roof, a spire, a haystack. Takes snow like a roof if `snowy`. */
    cone(n, cx, cz, r, y0, y1, turn, snowy) {
      this.core(cx, y0 + 0.01, cz);
      const base = this.n, snow = this.snow;
      if (snowy) this.snow = EAVE;
      for (let i = 0; i < n; i++) { const a = (turn || 0) + i / n * TAU; this.v(cx + Math.cos(a) * r, y0, cz + Math.sin(a) * r, 0.88); }
      if (snowy) this.snow = 1;
      const tip = this.v(cx, y1, cz);
      this.snow = snow;
      for (let i = 0; i < n; i++) this.tri(base + i, base + (i + 1) % n, tip);
    }

    /** A flat panel on a wall (a door, a window): two opposite corners that share either x or z. */
    pane(x0, y0, z0, x1, y1, z1) {
      this.quad(this.v(x0, y0, z0), this.v(x1, y0, z1), this.v(x1, y1, z1), this.v(x0, y1, z0));
    }
  }

  /* ----- the parts a settlement is made of ----- */

  // Battlements: a row of teeth along local x, standing at height y between z0 and z1.
  function teeth(m, x0, x1, y, z0, z1, high) {
    const n = Math.max(1, Math.round((x1 - x0) / 2.3)), step = (x1 - x0) / n;
    for (let i = 0; i < n; i++) { const x = x0 + (i + 0.5) * step; m.box(x - 0.6, y, z0, x + 0.6, y + high, z1); }
  }

  // A stretch of stone curtain wall between two points of the ring, with its parapet on the outer edge.
  function curtain(m, c, A, B) {
    const S = c.S, t = S.wallT / 2, H = S.wallH;
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]), a = Math.atan2(B[1] - A[1], B[0] - A[0]);
    const out = -Math.sin(a) * (A[0] + B[0]) + Math.cos(a) * (A[1] + B[1]) > 0 ? 1 : -1;     // which way local z leaves the town
    m.at(c.x + A[0], c.y + A[1], c.h, a);
    m.c = STONE;
    m.box(0, -1.5, -t, len, H, t, WALK, 0.75, 'x');
    m.c = STONE_LT;
    if (len > S.towerR * 2 + 2) teeth(m, S.towerR + 0.2, len - S.towerR - 0.2, H, out > 0 ? t - 0.55 : -t, out > 0 ? t : -t + 0.55, 0.9);
  }

  // A stretch of palisade: sharpened logs set corner to corner, no two quite alike.
  function palisade(m, c, A, B) {
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]), a = Math.atan2(B[1] - A[1], B[0] - A[0]);
    const n = Math.max(1, Math.round(len / 1.25)), step = len / n, r = 0.68;
    m.at(c.x + A[0], c.y + A[1], c.h, a);
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * step, z = (c.rnd() - 0.5) * 0.3, top = c.S.wallH + (c.rnd() - 0.5) * 0.8, base = m.n;
      m.core(x, 1, z);
      m.c = tint(TIMBER, 0.84 + c.rnd() * 0.3);
      for (let j = 0; j < 4; j++) {
        const dx = j === 0 ? r : j === 2 ? -r : 0, dz = j === 1 ? r : j === 3 ? -r : 0;
        m.v(x + dx, -1.2, z + dz, LOW); m.v(x + dx * 0.92, top - 0.6, z + dz * 0.92);
      }
      m.c = LOG_TIP; m.snow = 0.8;
      const tip = m.v(x, top, z);
      m.snow = 0;
      for (let j = 0; j < 4; j++) {
        const k = (j + 1) % 4;
        m.quad(base + j * 2, base + k * 2, base + k * 2 + 1, base + j * 2 + 1);
        m.tri(base + j * 2 + 1, base + k * 2 + 1, tip);
      }
    }
  }

  // A wall tower: a crenellated drum on a town wall, a taller one under a slate cone on a city wall.
  function tower(m, c, p, out) {
    const S = c.S, R = S.towerR, H = S.towerH, a = Math.atan2(p[1], p[0]), x = c.x + p[0], y = c.y + p[1];
    m.at(x, y, c.h, a);
    m.c = STONE_LT;
    if (c.tier === 2) {
      m.drum(6, 0, 0, R + 0.15, R, -1.5, H - 1.2, null, 0, Math.PI / 6);
      m.drum(6, 0, 0, R + 0.4, R + 0.4, H - 1.2, H, WALK, 0.75, Math.PI / 6);
      const flat = (R + 0.4) * 0.866;
      for (let i = 0; i < 6; i++) { m.at(x, y, c.h, a + i * TAU / 6); m.box(flat - 0.5, H, -0.55, flat, H + 0.8, 0.55); }
    } else {
      m.drum(8, 0, 0, R + 0.2, R, -1.5, H, null, 0, Math.PI / 8);
      m.c = SLATE;
      m.cone(8, 0, 0, R + 0.5, H - 0.25, H + 3.9, Math.PI / 8, true);
      if (c.towers++ % 2 === 0) {
        m.c = TIMBER_DK; m.drum(4, 0, 0, 0.14, 0.1, H + 3.6, H + 6.6, null);
        out.flags.push({ town: c.id, x: x, y: y, top: c.h + H + 6.6, w: 3.2, hgt: 2, drop: 2.6 });
      }
    }
  }

  // One leaf of a gate. Hung at (hx, hz) it closes across the passage; open, it lies back along the passage wall.
  function leaf(m, hx, hz, s, w, y0, y1) {
    const e = 0.15, id = [];
    m.c = TIMBER;                              // lighter than the shadow of an open archway, so a shut gate reads as shut
    m.core(hx, (y0 + y1) / 2, hz - s * w / 2);
    for (let i = 0; i < 8; i++) {
      const u = i & 1 ? w : 0, t = i & 2 ? e : -e;
      m.shift(-u - t, 0, s * (u - t));
      id.push(m.v(hx + t, i & 4 ? y1 : y0, hz - s * u, i & 4 ? 1 : LOW));
    }
    m.shift(0, 0, 0);
    m.quad(id[0], id[1], id[5], id[4]); m.quad(id[2], id[3], id[7], id[6]);
    m.quad(id[1], id[3], id[7], id[5]); m.quad(id[4], id[5], id[7], id[6]);
  }

  // The stone shoulders that round off the top corners of a gate passage, so it reads as an arch.
  function haunches(m, bx, pw, arch, hh) {
    for (const s of [-1, 1]) {
      m.core(0, arch - hh / 3, s * (pw - hh / 3));
      const a0 = m.v(-bx, arch - hh, s * pw, LOW), a1 = m.v(-bx, arch, s * (pw - hh)), a2 = m.v(-bx, arch, s * pw);
      const b0 = m.v(bx, arch - hh, s * pw, LOW), b1 = m.v(bx, arch, s * (pw - hh)), b2 = m.v(bx, arch, s * pw);
      m.quad(a0, a1, b1, b0); m.tri(a0, a1, a2); m.tri(b0, b1, b2);
    }
  }

  // The main gate of a walled town: a passage between two drum towers with a room over it, banners on the towers.
  function gatehouse(m, c, g, out, info) {
    const S = c.S, G = S.gate, pw = G.pw, tr = G.towerR, th = G.towerH, top = S.wallH + G.over, bx = G.depth;
    const ox = c.x + Math.cos(g.a) * c.Rw, oy = c.y + Math.sin(g.a) * c.Rw, ca = Math.cos(g.a), sa = Math.sin(g.a);
    m.at(ox, oy, c.h, g.a);                    // local x runs out through the gate, local z along the wall
    m.c = STONE_LT;
    m.box(-bx, -1.5, pw, bx, G.arch, pw + 1.2, null);
    m.box(-bx, -1.5, -pw - 1.2, bx, G.arch, -pw, null);
    m.box(-bx, G.arch, -pw - 1.2, bx, top, pw + 1.2, WALK, 0.75);
    haunches(m, bx, pw, G.arch, 1.3);
    leaf(m, bx - 0.6, pw - 0.04, 1, pw - 0.07, 0.1, G.arch - 0.25);
    leaf(m, bx - 0.6, -pw + 0.04, -1, pw - 0.07, 0.1, G.arch - 0.25);
    m.at(ox, oy, c.h, g.a + Math.PI / 2);      // turned a quarter: local x along the wall, to lay the parapet
    m.c = STONE_LT;
    teeth(m, -pw - 0.6, pw + 0.6, top, -bx, -bx + 0.55, 0.9);
    for (const s of [-1, 1]) {
      const tz = s * (pw + 0.924 * tr), tx = G.fwd, wx = ox + tx * ca - tz * sa, wy = oy + tx * sa + tz * ca;
      m.at(wx, wy, c.h, g.a);
      m.c = STONE_LT;
      let pole = th;
      if (c.tier === 2) {
        m.drum(8, 0, 0, tr + 0.2, tr, -1.5, th - 1.3, null, 0, Math.PI / 8);
        m.drum(8, 0, 0, tr + 0.42, tr + 0.42, th - 1.3, th, WALK, 0.75, Math.PI / 8);
        const flat = (tr + 0.42) * 0.924;
        for (let i = 0; i < 4; i++) { m.at(wx, wy, c.h, g.a + i * Math.PI / 2); m.box(flat - 0.5, th, -0.6, flat, th + 0.8, 0.6); }
        m.at(wx, wy, c.h, g.a);
      } else {
        m.drum(8, 0, 0, tr + 0.2, tr, -1.5, th, null, 0, Math.PI / 8);
        m.c = SLATE;
        m.cone(8, 0, 0, tr + 0.45, th - 0.25, th + 4.2, Math.PI / 8, true);
        pole = th + 3.9;
      }
      const fw = c.tier === 2 ? 5.4 : 6.2, fh = c.tier === 2 ? 3.5 : 4;
      m.c = TIMBER_DK; m.drum(4, 0, 0, 0.17, 0.12, pole, pole + fh + 2.4, null);
      out.flags.push({ town: c.id, x: wx, y: wy, top: c.h + pole + fh + 2.4, w: fw, hgt: fh, drop: 2.2 });
      // a torch bracket on the face of each tower, lit at dusk and under siege
      m.box(tr * 0.924, 3.0, -0.12, tr * 0.924 + 0.45, 3.25, 0.12);
      info.torches.push([wx + (tr * 0.924 + 0.4) * ca, wy + (tr * 0.924 + 0.4) * sa, c.h + 3.3]);
    }
  }

  // A lesser gate where another road meets a stone wall: one squat gate tower with the road through it.
  function postern(m, c, g) {
    const S = c.S, pw = 2.45, bx = S.wallT / 2 + 0.7, top = S.wallH + 1.9, arch = 3.9;
    const ox = c.x + Math.cos(g.a) * c.Rw, oy = c.y + Math.sin(g.a) * c.Rw;
    m.at(ox, oy, c.h, g.a);
    m.c = STONE_LT;
    m.box(-bx, -1.5, pw, bx, arch, pw + 1.2, null);
    m.box(-bx, -1.5, -pw - 1.2, bx, arch, -pw, null);
    m.box(-bx, arch, -pw - 1.2, bx, top, pw + 1.2, WALK, 0.75);
    haunches(m, bx, pw, arch, 1.2);
    leaf(m, bx - 0.5, pw - 0.04, 1, pw - 0.07, 0.1, arch - 0.25);
    leaf(m, bx - 0.5, -pw + 0.04, -1, pw - 0.07, 0.1, arch - 0.25);
    m.c = STONE_LT;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.box(sx * bx, top, sz * (pw + 1.2), sx * (bx - 0.8), top + 0.85, sz * (pw + 0.2));
  }

  // A village gate: two stout posts, a lintel, and over the main gate a strip of thatch to keep the rain off the watch.
  function timberGate(m, c, g) {
    const pw = g.hw, ph = g.main ? 5 : 4, ox = c.x + Math.cos(g.a) * c.Rw, oy = c.y + Math.sin(g.a) * c.Rw;
    m.at(ox, oy, c.h, g.a);
    m.c = TIMBER_DK;
    for (const s of [-1, 1]) m.drum(6, 0, s * pw, 0.6, 0.52, -1.2, ph, TIMBER, 0.6);
    m.c = TIMBER;
    m.box(-0.3, ph - 1.05, -pw - 0.8, 0.3, ph - 0.5, pw + 0.8, undefined, 0.6);
    leaf(m, -0.2, pw - 0.5, 1, pw - 0.53, 0.1, ph - 1.9);
    leaf(m, -0.2, -pw + 0.5, -1, pw - 0.53, 0.1, ph - 1.9);
    if (!g.main) return;
    m.at(ox, oy, c.h, g.a + Math.PI / 2);
    m.c = THATCH[1];
    m.gable(-pw - 1, -0.7, pw + 1, 0.7, ph - 0.5, 0.95, 0.15, null);
  }

  // A village's lookout by the gate: four legs, a platform and a thatched cap, with the gate banner on top.
  function lookout(m, c, g, out) {
    const lx = -3.6, lz = g.hw + 3.1, ca = Math.cos(g.a), sa = Math.sin(g.a);
    const wx = c.x + ca * (c.Rw + lx) - sa * lz, wy = c.y + sa * (c.Rw + lx) + ca * lz;
    m.at(wx, wy, c.h, g.a);
    m.c = TIMBER_DK;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.box(sx * 1.15 - 0.17, -0.5, sz * 1.15 - 0.17, sx * 1.15 + 0.17, 6.3, sz * 1.15 + 0.17, null);
    m.c = TIMBER;
    m.box(-1.5, 4.2, -1.5, 1.5, 4.5, 1.5);
    m.box(-1.5, 4.5, -1.5, 1.5, 5.2, -1.38); m.box(-1.5, 4.5, 1.38, 1.5, 5.2, 1.5);
    m.box(-1.5, 4.5, -1.5, -1.38, 5.2, 1.5); m.box(1.38, 4.5, -1.5, 1.5, 5.2, 1.5);
    m.c = THATCH[0];
    m.hip(-1.6, -1.6, 1.6, 1.6, 6.3, 1.9, 0.5, 1.6);
    m.c = TIMBER_DK; m.drum(4, 0, 0, 0.14, 0.1, 8, 12.2, null);
    out.flags.push({ town: c.id, x: wx, y: wy, top: c.h + 12.2, w: 4.8, hgt: 3, drop: 2.6 });
    return [wx - c.x, wy - c.y];
  }

  // Slit windows round a tower: `n` to a side on each of its four faces, at each height in `rows`.
  function slits(m, c, b, w, rows, n) {
    for (let i = 0; i < 4; i++) {
      m.at(c.x + b.x, c.y + b.y, c.h, b.a + Math.PI + i * Math.PI / 2);
      m.core(0, 5, 0);
      m.c = PANE;
      for (const y of rows) for (let j = 0; j < n; j++) {
        const z = n === 1 ? 0 : (j / (n - 1) - 0.5) * w;
        m.glow = 0.05 + 0.9 * c.rnd();
        m.pane(w + 0.07, y, z - 0.24, w + 0.07, y + 1.25, z + 0.24);
      }
      m.glow = 0;
    }
  }

  // A village hall: a long thatched house with the standard planted in front of it.
  function hall(m, c, b, out, info) {
    const s = b.s, L = 4.5 * s, D = 2.3 * s, wh = 2.8, wall = DAUB[2];
    m.at(c.x + b.x, c.y + b.y, c.h, b.a + Math.PI / 2);        // local x along the hall, local z toward the green
    m.char = 0.32;
    m.c = wall; m.box(-L, -0.4, -D, L, wh, D, null);
    m.c = TIMBER_DK;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.box(sx * L - 0.2, -0.4, sz * D - 0.2, sx * L + 0.2, wh, sz * D + 0.2, null);
    m.c = THATCH[0]; m.hip(-L, -D, L, D, wh, 3.1, 0.6, L * 0.42);
    m.core(0, 1, 0);
    m.c = TIMBER_DK; m.pane(-0.7, 0, D + 0.07, 0.7, 2.05, D + 0.07);
    m.c = PANE;
    for (const sx of [-1, 1]) for (const f of [0.38, 0.74]) { m.glow = 0.05 + 0.5 * c.rnd(); m.pane(sx * L * f - 0.32, 1.15, D + 0.07, sx * L * f + 0.32, 1.9, D + 0.07); }
    m.glow = 0; m.char = 0;
    c.chimneys.push([c.x + b.x, c.y + b.y, c.h + wh + 3.1]);
    c.burnable.push([0.32, c.x + b.x, c.y + b.y, c.h + wh + 2]);
    // the standard, on the green in front
    const px = L * 0.72, pz = D + 1.7, ca = Math.cos(b.a + Math.PI / 2), sa = Math.sin(b.a + Math.PI / 2);
    m.c = TIMBER_DK; m.drum(5, px, pz, 0.26, 0.17, -0.5, 12.6, null);
    out.flags.push({ town: c.id, x: c.x + b.x + px * ca - pz * sa, y: c.y + b.y + px * sa + pz * ca, top: c.h + 12.6, w: 7.8, hgt: 4.9, drop: 5.6 });
    info.mob = [c.x + b.x - Math.cos(b.a) * (D + 4.2), c.y + b.y - Math.sin(b.a) * (D + 4.2)];
    info.face = b.a;
  }

  // A town's keep: a square stone tower on a plinth, turrets at the corners, a forebuilding toward the square.
  function keepTower(m, c, b, out, info) {
    const s = b.s, w = 3.6 * s, H = 11, tw = 0.95 * s, cx = c.x + b.x, cy = c.y + b.y;
    m.at(cx, cy, c.h, b.a + Math.PI);                           // local x toward the market square
    m.c = STONE_DK; m.box(-w - 0.8, -1.5, -w - 0.8, w + 0.8, 1.5, w + 0.8, undefined, 0.6);
    m.c = STONE_LT; m.box(-w, 1.5, -w, w, H, w, WALK, 0.8);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const tx = sx * (w - 0.38), tz = sz * (w - 0.38);
      m.box(tx - tw, 1.5, tz - tw, tx + tw, H + 1.3, tz + tw, undefined, 0.7);
    }
    // the forebuilding with the way in, under a lean-to roof
    const fx = w + 2.6 * s, fz = 1.5 * s;
    m.c = STONE; m.box(w, -0.4, -fz, fx, 4.4, fz, null);
    m.core(w + 1, 4, 0);
    m.c = TILE[2]; m.snow = 1;
    m.quad(m.v(w, 5.7, -fz - 0.3), m.v(w, 5.7, fz + 0.3), m.v(fx + 0.3, 4.2, fz + 0.3, 0.9), m.v(fx + 0.3, 4.2, -fz - 0.3, 0.9));
    m.snow = 0; m.c = STONE;
    for (const sz of [-1, 1]) m.tri(m.v(w, 4.4, sz * fz), m.v(w, 5.7, sz * fz), m.v(fx, 4.4, sz * fz));
    m.c = TIMBER_DK; m.pane(fx + 0.07, 0, -0.65, fx + 0.07, 2.2, 0.65);
    slits(m, c, b, w, [5, 8], 2);
    for (let i = 0; i < 4; i++) {
      m.at(cx, cy, c.h, b.a + Math.PI + i * Math.PI / 2);
      m.c = STONE_LT; teeth(m, -w + tw + 0.7, w - tw - 0.7, H, w - 0.5, w, 0.85);
    }
    m.at(cx, cy, c.h, b.a + Math.PI);
    m.c = TIMBER_DK; m.drum(5, 0, 0, 0.26, 0.17, H, H + 10, null);
    out.flags.push({ town: c.id, x: cx, y: cy, top: c.h + H + 10, w: 8.8, hgt: 5.5, drop: 4.2 });
    info.mob = [cx - Math.cos(b.a) * (fx + 3.6), cy - Math.sin(b.a) * (fx + 3.6)];
    info.face = b.a;
  }

  // A city's citadel: a great keep with a drum tower at each corner, all of it on a plinth.
  function citadel(m, c, b, out, info) {
    const s = b.s, w = 4.9 * s, H = 15, R = 2.35 * s, TH = 17.2, cx = c.x + b.x, cy = c.y + b.y;
    const ca = Math.cos(b.a + Math.PI), sa = Math.sin(b.a + Math.PI);
    m.at(cx, cy, c.h, b.a + Math.PI);
    m.c = STONE_DK; m.box(-w - 1.6, -1.5, -w - 1.6, w + 1.6, 1.8, w + 1.6, WALK, 0.7);
    m.c = STONE_LT; m.box(-w, 1.8, -w, w, H, w, WALK, 0.8);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      m.c = STONE_LT; m.drum(8, sx * w, sz * w, R + 0.2, R, 1.8, TH, null, 0, Math.PI / 8);
      m.c = SLATE; m.cone(8, sx * w, sz * w, R + 0.5, TH - 0.25, TH + 3.6, Math.PI / 8, true);
      m.c = TIMBER_DK; m.drum(4, sx * w, sz * w, 0.14, 0.1, TH + 3.3, TH + 6.2, null);
      out.flags.push({ town: c.id, x: cx + sx * w * ca - sz * w * sa, y: cy + sx * w * sa + sz * w * ca, top: c.h + TH + 6.2, w: 3.4, hgt: 2.1, drop: 2.5 });
    }
    // the gate tower toward the square
    const fx = w + 3.4 * s, fz = 2.2 * s;
    m.c = STONE; m.box(w, -0.4, -fz, fx, 6.4, fz, WALK, 0.7);
    m.core(w + 1, 3, 0);
    m.c = TIMBER_DK; m.pane(fx + 0.07, 0, -0.95, fx + 0.07, 3.1, 0.95);
    m.c = STONE_LT;
    m.at(cx, cy, c.h, b.a + Math.PI + Math.PI / 2);
    teeth(m, -fz, fz, 6.4, -fx, -fx + 0.5, 0.8);
    slits(m, c, b, w, [4.6, 8, 11.4], 3);
    for (let i = 0; i < 4; i++) {
      m.at(cx, cy, c.h, b.a + Math.PI + i * Math.PI / 2);
      m.c = STONE_LT; teeth(m, -w + R + 0.4, w - R - 0.4, H, w - 0.55, w, 0.9);
    }
    m.at(cx, cy, c.h, b.a + Math.PI);
    m.c = TIMBER_DK; m.drum(5, 0, 0, 0.3, 0.19, H, H + 11.5, null);
    out.flags.push({ town: c.id, x: cx, y: cy, top: c.h + H + 11.5, w: 10.5, hgt: 6.5, drop: 4.8 });
    info.mob = [cx - Math.cos(b.a) * (fx + 4.2), cy - Math.sin(b.a) * (fx + 4.2)];
    info.face = b.a;
  }

  // A town's church: nave, slate roof, and a tower with a short spire at the end that faces the square.
  function church(m, c, b) {
    const s = b.s, cx = c.x + b.x, cy = c.y + b.y;
    m.at(cx, cy, c.h, b.a + Math.PI);
    m.c = CHURCH;
    m.box(-5.7 * s, -0.4, -2.1 * s, 2.6 * s, 4.4, 2.1 * s, null);
    m.box(2.4 * s, -0.4, -1.65 * s, 5.7 * s, 8.8, 1.65 * s, null);
    m.c = SLATE;
    m.gable(-5.7 * s, -2.1 * s, 2.6 * s, 2.1 * s, 4.4, 3.3, 0.35, CHURCH);
    m.hip(2.4 * s, -1.65 * s, 5.7 * s, 1.65 * s, 8.8, 4.6, 0.3, 1.65 * s);
    m.core(0, 2, 0);
    m.c = TIMBER_DK; m.pane(5.7 * s + 0.07, 0, -0.6, 5.7 * s + 0.07, 2.1, 0.6);
    m.c = PANE;
    for (const sz of [-1, 1]) {
      for (const x of [-4.5, -2.6, -0.7]) { m.glow = 0.05 + 0.35 * c.rnd(); m.pane(x * s - 0.3, 1.4, sz * (2.1 * s + 0.07), x * s + 0.3, 3.3, sz * (2.1 * s + 0.07)); }
      m.glow = 0; m.pane(4.05 * s - 0.35, 6.4, sz * (1.65 * s + 0.07), 4.05 * s + 0.35, 7.7, sz * (1.65 * s + 0.07));
    }
    m.pane(5.7 * s + 0.07, 6.4, -0.35, 5.7 * s + 0.07, 7.7, 0.35);
    m.glow = 0;
  }

  // A city's cathedral: a long nave crossed by a transept, and at the west end a tower under a tall spire.
  function cathedral(m, c, b) {
    const s = b.s, cx = c.x + b.x, cy = c.y + b.y, wh = 6.6;
    m.at(cx, cy, c.h, b.a + Math.PI);
    m.c = CHURCH;
    m.box(-10 * s, -0.4, -2.8 * s, 5.6 * s, wh, 2.8 * s, null);
    m.box(-7.6 * s, -0.4, -5.7 * s, -2.8 * s, wh, 5.7 * s, null);
    m.box(5.4 * s, -0.4, -2.3 * s, 10 * s, 13.5, 2.3 * s, null);
    m.c = STONE_LT;
    m.box(5.4 * s - 0.25, 12.4, -2.3 * s - 0.25, 10 * s + 0.25, 13.5, 2.3 * s + 0.25, WALK, 0.7);
    m.c = SLATE;
    m.gable(-10 * s, -2.8 * s, 5.6 * s, 2.8 * s, wh, 4.2, 0.35, CHURCH);
    m.cone(8, 7.7 * s, 0, 2.5 * s, 13.5, 27, Math.PI / 8, true);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.cone(4, 7.7 * s + sx * 2.0 * s, sz * 2.0 * s, 0.62, 13.5, 16.4, Math.PI / 4, true);
    m.core(0, 3, 0);
    m.c = TIMBER_DK; m.pane(10 * s + 0.07, 0, -0.95, 10 * s + 0.07, 3.1, 0.95);
    m.c = PANE;
    m.glow = 0.08; m.pane(10 * s + 0.07, 5.6, -0.8, 10 * s + 0.07, 8, 0.8);
    for (const sz of [-1, 1]) {
      for (const x of [-9, 0, 2, 4]) { m.glow = 0.05 + 0.3 * c.rnd(); m.pane(x * s - 0.38, 2, sz * (2.8 * s + 0.07), x * s + 0.38, 5.2, sz * (2.8 * s + 0.07)); }
      m.glow = 0.12; m.pane(-5.2 * s - 0.6, 2, sz * (5.7 * s + 0.07), -5.2 * s + 0.6, 5.4, sz * (5.7 * s + 0.07));
    }
    m.glow = 0;
    m.at(cx, cy, c.h, b.a + Math.PI + Math.PI / 2);            // a quarter turn, for the roof that runs across
    m.c = SLATE;
    m.gable(-5.7 * s, 2.8 * s, 5.7 * s, 7.6 * s, wh, 3.8, 0.3, CHURCH);
  }

  // A dwelling: a thatched cottage in a village (kind 0), a plastered house under tiles in a town (kind 1).
  // The ridge runs along `yaw`. `front` says which wall has the door: 1 or -1 for a long side, 2 or -2 for a gable end.
  function house(m, c, x, y, yaw, w, d, wh, rise, kind, front) {
    const rnd = c.rnd, wall = tint(pick(kind ? PLASTER : DAUB, rnd()), 0.95 + rnd() * 0.08);
    const wx = c.x + x, wy = c.y + y, thr = rnd() < 0.56 ? 0.06 + 0.9 * rnd() : 0;
    const side = front > 0 ? 1 : -1, end = Math.abs(front) === 2, storeys = Math.max(1, Math.floor((wh - 0.3) / 2.1));
    m.at(wx, wy, c.h, yaw);
    m.char = thr;
    m.c = wall;
    m.box(-w / 2, -0.4, -d / 2, w / 2, wh, d / 2, null);
    m.c = tint(pick(kind ? TILE : THATCH, rnd()), 0.92 + rnd() * 0.14);
    if (kind) m.gable(-w / 2, -d / 2, w / 2, d / 2, wh, rise, 0.32, wall);
    else m.hip(-w / 2, -d / 2, w / 2, d / 2, wh, rise, 0.45, w * 0.26);
    // Door and windows: `put` lays a panel on the front wall, `u` along it, whichever wall that is.
    const span = end ? d : w, off = side * ((end ? w : d) / 2 + 0.07), door = (rnd() - 0.5) * span * 0.36;
    const put = (u0, y0, u1, y1, back) => (end ? m.pane(back ? -off : off, y0, u0, back ? -off : off, y1, u1) : m.pane(u0, y0, back ? -off : off, u1, y1, back ? -off : off));
    m.core(0, 1, 0);
    m.c = TIMBER_DK; put(door - 0.42, 0, door + 0.42, 1.6);
    m.c = PANE;
    for (let lvl = 0; lvl < storeys; lvl++) {
      for (const sx of [-1, 1]) {
        const px = sx * span * 0.31;
        if (lvl === 0 && Math.abs(px - door) < 0.85) continue;
        m.glow = 0.04 + 0.96 * rnd();
        put(px - 0.3, 1.05 + lvl * 2.1, px + 0.3, 1.78 + lvl * 2.1);
      }
    }
    m.glow = 0.04 + 0.96 * rnd();
    put(-0.3, 1.05, 0.3, 1.78, true);
    m.glow = 0;
    if (!kind) c.chimneys.push([wx, wy, c.h + wh + rise]);
    else if (rnd() < 0.45) {
      const hx = (rnd() < 0.5 ? -1 : 1) * w * 0.27, top = wh + rise + 0.55;
      m.c = STONE_DK; m.box(hx - 0.3, wh + rise * 0.3, -0.3, hx + 0.3, top, 0.3);
      c.chimneys.push([wx + hx * Math.cos(yaw), wy + hx * Math.sin(yaw), c.h + top]);
    }
    if (thr > 0) c.burnable.push([thr, wx, wy, c.h + wh + rise * 0.7]);
    m.char = 0;
  }

  // A market stall. It is built under the ground and lifted into place by the same value that opens the gates,
  // so the market packs up when the town is shut.
  function stall(m, c, x, y, yaw, canvas) {
    m.at(c.x + x, c.y + y, c.h - 3.4, yaw);
    m.shift(0, 3.4, 0);
    m.c = TIMBER; m.box(-0.95, 0, -0.45, 0.95, 0.75, 0.45);
    m.c = TIMBER_DK;
    for (const sx of [-1, 1]) m.box(sx * 0.95 - 0.07, 0, -0.62, sx * 0.95 + 0.07, 2.05, -0.48, null);
    m.core(0, -50, 0);
    m.c = canvas; m.snow = 0.9;
    m.quad(m.v(-1.15, 2.1, -0.7), m.v(1.15, 2.1, -0.7), m.v(1.15, 1.55, 0.85, 0.92), m.v(-1.15, 1.55, 0.85, 0.92));
    m.snow = 0;
    m.shift(0, 0, 0);
  }

  // Something for the square: a well on a village green, a market cross in a town, a fountain in a city.
  function landmark(m, c, x, y) {
    m.at(c.x + x, c.y + y, c.h, 0.4);
    if (c.tier === 1) {
      m.c = STONE; m.drum(6, 0, 0, 0.95, 0.95, -0.3, 0.85, WATER, 0);
      m.c = TIMBER_DK; m.box(-1.0, 0, -0.1, -0.8, 2.3, 0.1, null); m.box(0.8, 0, -0.1, 1.0, 2.3, 0.1, null);
      m.c = THATCH[1]; m.gable(-1.15, -0.6, 1.15, 0.6, 2.25, 0.7, 0.12, null);
    } else if (c.tier === 2) {
      m.c = STONE; m.box(-1.3, -0.3, -1.3, 1.3, 0.4, 1.3, undefined, 0.6); m.box(-0.8, 0.4, -0.8, 0.8, 0.8, 0.8, undefined, 0.6);
      m.c = STONE_LT; m.drum(4, 0, 0, 0.3, 0.2, 0.8, 3.7, null, 0, Math.PI / 4); m.box(-0.75, 2.85, -0.15, 0.75, 3.2, 0.15);
    } else {
      m.c = STONE; m.drum(8, 0, 0, 2.3, 2.3, -0.3, 0.75, WATER, 0.3, Math.PI / 8);
      m.c = STONE_LT; m.drum(6, 0, 0, 0.5, 0.36, 0.3, 2.4, null); m.drum(6, 0, 0, 1.05, 1.05, 2.05, 2.4, WATER, 0.3);
    }
  }

  // The ground inside the walls: paving on the square, cobbles or turf out to the foot of the wall, and a street of
  // trodden earth from every gate to the square. The roads of the land stop at the walls; the streets carry them in.
  function floor(m, c, reach, gates) {
    const N = 40, sq = c.sq, pave = c.tier === 1 ? EARTH : PAVING, ground = c.tier === 1 ? TURF : COBBLE;
    m.at(c.x, c.y, c.h + c.lift, 0);
    m.core(0, -1e5, 0);
    m.snow = 0.62;                         // trodden, so never as white as the roofs
    m.c = pave;
    const hub = m.v(0, 0, 0), base = m.n;
    for (let i = 0; i < N; i++) {
      const a = i / N * TAU, ca = Math.cos(a), sa = Math.sin(a), R = reach(a)[0], k = 0.95 + 0.1 * hash(c.id + 7, i);
      m.c = pave; m.v(ca * sq, 0, sa * sq, k);
      m.c = ground; m.v(ca * sq, 0, sa * sq, k); m.v(ca * (R - 3), 0, sa * (R - 3), k * 0.97); m.v(ca * R, 0, sa * R, k * 0.8);
    }
    for (let i = 0; i < N; i++) {
      const p = base + i * 4, q = base + ((i + 1) % N) * 4;
      m.tri(hub, p, q); m.quad(p + 1, q + 1, q + 2, p + 2); m.quad(p + 2, q + 2, q + 3, p + 3);
    }
    m.snow = 0;                            // streets stay mud all winter, as the roads do
    m.c = STREET;
    for (const g of gates) {
      m.at(c.x, c.y, c.h + c.lift + 0.12, g.a);
      m.core(0, -1e5, 0);
      const x0 = sq - 0.5, x1 = c.r - 1.2, id = [];
      for (const x of [x0, x1]) for (const z of [-2.4, -1.5, 1.5, 2.4]) id.push(m.v(x, 0, z, Math.abs(z) > 2 ? 0.84 : 1));
      for (let i = 0; i < 3; i++) m.quad(id[i], id[i + 1], id[i + 5], id[i + 4]);
    }
  }

  /* ----- laying out one settlement ----- */

  // Where roads cross a town's wall line (as map angles), and the stretches of road inside it.
  function roadsAt(site, land, Rw) {
    const angles = [], lanes = [];
    for (const road of land.roads || []) {
      if (road.a !== site.id && road.b !== site.id) continue;
      const pts = road.pts, n = pts.length, rev = road.b === site.id;
      let px = 0, py = 0, pd = -1;
      for (let j = 0; j < n; j++) {
        const p = pts[rev ? n - 1 - j : j], x = p[0] - site.x, y = p[1] - site.y, d = Math.hypot(x, y);
        if (d >= Rw) {
          if (pd >= 0) {
            const t = (Rw - pd) / Math.max(1e-6, d - pd), hx = px + (x - px) * t, hy = py + (y - py) * t;
            angles.push(Math.atan2(hy, hx)); lanes.push([px, py, hx, hy]);
          } else if (d < site.r + 12) angles.push(Math.atan2(y, x));        // a road that stops at the wall still wants a gate
          break;
        }
        if (pd >= 0) lanes.push([px, py, x, y]);
        px = x; py = y; pd = d;
      }
    }
    return { angles: angles, lanes: lanes };
  }

  function layTown(m, site, k, land, seed, out) {
    const tier = clamp(k.tier | 0, 1, 3), S = SPEC[tier], Rw = site.r - S.inset, rnd = stream(seed * 131 + site.id * 7919 + 17);
    const c = { id: site.id, tier: tier, S: S, x: site.x, y: site.y, h: site.h, r: site.r, Rw: Rw, sq: S.square, rnd: rnd,
      lift: 0.14, towers: 0, chimneys: [], burnable: [] };
    const info = { x: site.x, y: site.y, h: site.h, r: site.r, tier: tier, sq: S.square, top: 0, torches: [], chimneys: [], burn: [],
      walkers: [], mob: [site.x, site.y], face: 0, seed: rnd() * 40 };
    out.towns[site.id] = info;
    info.f0 = out.flags.length;                // this town's banners are flags f0 up to f1
    m.town = site.id; m.snow = 0; m.char = 0; m.glow = 0; m.shift(0, 0, 0);

    // The town floor has to clear whatever the ground does inside the walls, without burying the road.
    for (let i = 0; i < 24; i++) {
      const a = i / 24 * TAU;
      for (const f of [0.45, 0.8, 1]) c.lift = Math.max(c.lift, land.heightAt(site.x + Math.cos(a) * Rw * f, site.y + Math.sin(a) * Rw * f) - site.h + 0.1);
    }
    c.lift = Math.min(c.lift, 0.28);

    // Gates: the main one where the site says, lesser ones wherever another road meets the wall.
    const ga = Math.atan2(site.gate[1], site.gate[0]), roads = roadsAt(site, land, Rw);
    const gates = [{ a: ga, main: true, hw: S.mainHw }];
    let off = 0.6;                              // the main gate stands astride the road it serves, if one comes in on that side
    for (const a of roads.angles) if (Math.abs(wrap(a - ga)) < off) { off = Math.abs(wrap(a - ga)); gates[0].a = a; }
    for (const a of roads.angles) {
      if (gates.some((g) => Math.abs(wrap(a - g.a)) * Rw < g.hw + S.sideHw + 0.5)) continue;   // no room for two gates side by side
      gates.push({ a: a, main: false, hw: S.sideHw });
    }
    gates.sort((p, q) => p.a - q.a);
    // Streets to keep clear: a straight one from every gate to the square, and any stretch of road that strays from those.
    const lanes = gates.map((g) => [0, 0, Math.cos(g.a) * Rw, Math.sin(g.a) * Rw]), straight = lanes.length;
    const laneDist = (x, y, upTo) => {
      let best = 1e9;
      for (let i = 0; i < (upTo || lanes.length); i++) {
        const l = lanes[i], ex = l[2] - l[0], ey = l[3] - l[1], t = clamp(((x - l[0]) * ex + (y - l[1]) * ey) / (ex * ex + ey * ey || 1), 0, 1);
        const dx = l[0] + ex * t - x, dy = l[1] + ey * t - y, d = dx * dx + dy * dy;
        if (d < best) best = d;
      }
      return Math.sqrt(best);
    };
    for (const l of roads.lanes) if (laneDist(l[0], l[1], straight) > 0.6 || laneDist(l[2], l[3], straight) > 0.6) lanes.push(l);

    // The ring: from each gate to the next, with towers (or just bends, for a palisade) spaced evenly between.
    const jamb = (g, side) => [Math.cos(g.a) * Rw - Math.sin(g.a) * side * g.hw, Math.sin(g.a) * Rw + Math.cos(g.a) * side * g.hw];
    const runs = [], nodes = [], segs = [];
    for (let i = 0; i < gates.length; i++) {
      const g0 = gates[i], g1 = gates[(i + 1) % gates.length];
      const a0 = g0.a + Math.atan2(g0.hw, Rw), a1 = g1.a - Math.atan2(g1.hw, Rw) + (i + 1 === gates.length ? TAU : 0);
      const span = a1 - a0, A = jamb(g0, 1), B = jamb(g1, -1);
      segs.push([jamb(g0, -1), A]);                       // the gate itself closes the ring
      if (span < 0.03) continue;
      const count = Math.max(0, Math.round(span * Rw / S.spacing) - 1);
      let prev = A;
      for (let j = 1; j <= count + 1; j++) {
        let p = B;
        if (j <= count) {
          const a = a0 + span * j / (count + 1), rr = Rw * (tier === 1 ? 1 - 0.08 * rnd() : 1);
          p = [Math.cos(a) * rr, Math.sin(a) * rr];
          nodes.push(p);
        }
        runs.push([prev, p]); segs.push([prev, p]);
        prev = p;
      }
    }

    // How far the wall is from the centre along a bearing, and which way that stretch of wall runs.
    const reach = (ang) => {
      const dx = Math.cos(ang), dy = Math.sin(ang);
      let best = 1e9, dir = ang + Math.PI / 2;
      for (const s of segs) {
        const px = s[0][0], py = s[0][1], ex = s[1][0] - px, ey = s[1][1] - py, den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const dist = (px * ey - py * ex) / den, along = (px * dy - py * dx) / den;
        if (dist > 0 && dist < best && along > -0.01 && along < 1.01) { best = dist; dir = Math.atan2(ey, ex); }
      }
      return [best > 1e8 ? Rw : best, dir];
    };

    // Plots: every rectangle of ground that is spoken for, `bd` deep along its bearing `a` and `bw` wide across it.
    const plots = [];
    const claim = (a, x, y, bd, bw) => {
      const b = { a: a, x: x, y: y, bd: bd, bw: bw, ca: Math.cos(a), sa: Math.sin(a), rad: Math.hypot(bd, bw) };
      plots.push(b);
      return b;
    };
    const taken = (x, y, pad) => {
      for (let i = 0; i < plots.length; i++) {
        const b = plots[i], dx = x - b.x, dy = y - b.y, far = b.rad + pad;
        if (dx * dx + dy * dy > far * far) continue;
        if (Math.abs(dx * b.ca + dy * b.sa) < b.bd + pad && Math.abs(dy * b.ca - dx * b.sa) < b.bw + pad) return true;
      }
      return false;
    };
    const fits = (a, d, bw, bd, tuck) => {
      if (d - bd < c.sq + 0.6) return false;
      const ca = Math.cos(a), sa = Math.sin(a);
      for (let i = 0; i < 12; i++) {
        // sample the plot's edge: the inner edge closely (streets fan out from the centre), then the sides and the back
        const u = i < 5 ? -1 : i < 9 ? (i < 7 ? -0.3 : 0.5) : 1, v = i < 5 ? (i - 2) / 2 : i < 9 ? (i % 2 ? 1 : -1) : i - 10;
        const x = ca * (d + u * bd) - sa * v * bw, y = sa * (d + u * bd) + ca * v * bw;
        if (laneDist(x, y) < S.lane + 0.3 || taken(x, y, 1.2)) return false;
        if (u === 1 && Math.hypot(x, y) > reach(Math.atan2(y, x))[0] - S.wallT / 2 + tuck) return false;
      }
      return true;
    };
    // Find room between the streets: the bearing nearest `want`, pushed out and shrunk only as far as it has to be.
    const place = (bw, bd, want, d0, d1, tuck) => {
      let at = want, far = (d0 + d1) / 2, size = 0.7, score = -1e9;
      for (let sc = 1; sc > 0.7 && score < 0; sc -= 0.13) {          // full size anywhere beats a cramped one in the best spot
        for (let i = 0; i < 72; i++) {
          const a = want + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * TAU / 72;
          for (let q = 0; q < 4; q++) {
            const d = d0 + (d1 - d0) * q / 3, v = 40 - Math.abs(wrap(a - want)) * 9 - q * 1.5;
            if (v > score && fits(a, d, bw * sc, bd * sc, tuck)) { score = v; at = a; far = d; size = sc; }
          }
        }
      }
      const b = claim(at, Math.cos(at) * far, Math.sin(at) * far, bd * size, bw * size);
      b.s = size;
      return b;
    };

    // Walls, towers and gates.
    for (const r of runs) (tier === 1 ? palisade : curtain)(m, c, r[0], r[1]);
    if (tier > 1) for (const p of nodes) tower(m, c, p, out);
    for (const g of gates) {
      if (tier === 1) {
        timberGate(m, c, g);
        if (g.main) { const p = lookout(m, c, g, out); claim(0, p[0], p[1], 2, 2); }
      } else if (g.main) gatehouse(m, c, g, out, info);
      else postern(m, c, g);
    }
    floor(m, c, reach, gates);

    // The big buildings, opposite the gate if there is room there.
    if (tier === 1) hall(m, c, place(4.8, 2.6, ga + Math.PI, c.sq + 3.3, Rw - 5.2, 0), out, info);
    else if (tier === 2) {
      const kp = place(4.5, 4.5, ga + Math.PI, c.sq + 5.2, Rw - 5.6, 1.4);
      keepTower(m, c, kp, out, info);
      church(m, c, place(2.5, 5.9, kp.a + (rnd() < 0.5 ? 1.7 : -1.7), c.sq + 6.6, Rw - 7.6, 0));
    } else {
      const kp = place(6.6, 6.6, ga + Math.PI, c.sq + 7.4, Rw - 6.2, 1.8);
      citadel(m, c, kp, out, info);
      cathedral(m, c, place(5.9, 10.3, kp.a + (rnd() < 0.5 ? 1.9 : -1.9), c.sq + 10.9, Rw - 11.6, 0));
    }

    // Something on the square, to one side so that columns can march straight through the middle.
    let la = ga + 2, lbest = -1;
    for (let i = 0; i < 24; i++) {
      const a = i / 24 * TAU, d = laneDist(Math.cos(a) * c.sq * 0.62, Math.sin(a) * c.sq * 0.62);
      if (d > lbest) { lbest = d; la = a; }
    }
    landmark(m, c, Math.cos(la) * c.sq * 0.62, Math.sin(la) * c.sq * 0.62);
    claim(la, Math.cos(la) * c.sq * 0.62, Math.sin(la) * c.sq * 0.62, 1.6, 1.6);
    if (tier > 1) {
      for (let i = 0, made = 0; i < 40 && made < tier + 1; i++) {
        const a = la + 0.9 + i * 0.71, d = c.sq - 1.1, x = Math.cos(a) * d, y = Math.sin(a) * d;
        if (laneDist(x, y) < S.lane + 1.2 || taken(x, y, 1.4)) continue;
        stall(m, c, x, y, a + Math.PI / 2, CANVAS[made % CANVAS.length]);
        claim(a, x, y, 1, 1.3);
        made++;
      }
    }

    // Dwellings. A house may stand where its whole footprint is clear of streets, plots, other houses and the wall.
    const free = (x, y, yaw, w, d, pad) => {
      const tx = Math.cos(yaw), ty = Math.sin(yaw);
      for (let j = 0; j < 9; j++) {
        // the middle first (it fails soonest), then the corners, then the sides
        const i = SPOTS[j], u = (i % 3 - 1) * w / 2, v = (Math.floor(i / 3) - 1) * d / 2, px = x + tx * u - ty * v, py = y + ty * u + tx * v, far = Math.hypot(px, py);
        if (far < c.sq + pad || taken(px, py, pad) || laneDist(px, py) < S.lane + pad) return false;
        if (far > reach(Math.atan2(py, px))[0] - S.wallT / 2 - 0.4) return false;
      }
      return true;
    };
    const walls = (near) => (rnd() < (tier === 3 ? (near ? 0.55 : 0.25) : near ? 0.2 : 0.06) ? 4.5 + rnd() * 0.5 : 2.5 + rnd() * 0.45);
    const gap = () => (rnd() < 0.12 ? 1.8 : tier === 3 ? 0.25 + rnd() * 0.3 : 0.4 + rnd() * 0.7);
    let homes = 0;
    // First the streets: houses down both sides of every road from the square to the wall. In a town they stand shoulder
    // to shoulder, many with a gable to the street; in a village they stand apart, each at its own angle.
    for (const g of gates) {
      const ca = Math.cos(g.a), sa = Math.sin(g.a);
      for (const side of [-1, 1]) {
        for (let t = c.sq + 0.5 + (tier === 1 ? rnd() * 2.5 : 0), guard = 0; t < Rw && guard < 80; guard++) {
          const endOn = tier > 1 && rnd() < 0.42, along = endOn ? 2.7 + rnd() * 0.6 : 3 + rnd() * (tier === 1 ? 1 : 1.5), back = endOn ? 3.4 + rnd() * 0.9 : 2.6 + rnd() * 0.5;
          const yaw = g.a + (tier === 1 ? (rnd() - 0.5) * 0.5 : 0), room = tier === 1 ? 0.5 : 0;
          const off = side * (S.lane + back / 2 + (tier === 1 ? 0.9 + rnd() * 0.8 : 0.4)), mid = t + along / 2, x = ca * mid - sa * off, y = sa * mid + ca * off;
          if ((tier === 1 && homes >= 12) || !free(x, y, yaw, along + room, back + room, 0.3)) { t += 0.9; continue; }
          if (tier === 1) house(m, c, x, y, yaw, along, back, 2.1 + rnd() * 0.3, 1.9 + rnd() * 0.5, 0, -side);
          else if (endOn) house(m, c, x, y, g.a + Math.PI / 2, back, along, walls(t < Rw * 0.6), 1.9 + rnd() * 0.5, 1, -2 * side);
          else house(m, c, x, y, g.a, along, back, walls(t < Rw * 0.6), 1.7 + rnd() * 0.5, 1, -side);
          claim(yaw, x, y, (along + room) / 2, (back + room) / 2);
          homes++;
          t += along + (tier === 1 ? 1.4 + rnd() * 2.6 : gap());
        }
      }
    }
    if (tier === 1) {
      // Then cottages wherever there is still room, working round the ring so that every quarter of the village gets some.
      for (let i = 0; i < 300 && homes < 12; i++) {
        const a = i * 2.39996 + rnd() * 0.5, far = reach(a)[0] - 2.5, near = Math.max(c.sq + 2, far - 7);
        if (far < near) continue;
        const d = lerp(near, far, Math.sqrt(rnd())), x = Math.cos(a) * d, y = Math.sin(a) * d;
        const yaw = a + Math.PI / 2 + (rnd() - 0.5) * 0.9, w = 3 + rnd(), dp = 2.6 + rnd() * 0.4;
        if (!free(x, y, yaw, w + 0.6, dp + 0.6, 0.3)) continue;
        house(m, c, x, y, yaw, w, dp, 2.1 + rnd() * 0.3, 1.9 + rnd() * 0.5, 0, 1);
        claim(yaw, x, y, w / 2 + 0.3, dp / 2 + 0.3);
        homes++;
      }
      // and a few haystacks between them
      for (let i = 0, made = 0; i < 60 && made < 4; i++) {
        const a = rnd() * TAU, d = lerp(c.sq + 2, reach(a)[0] - 2.2, rnd()), x = Math.cos(a) * d, y = Math.sin(a) * d;
        if (!free(x, y, 0, 2.6, 2.6, 0.3)) continue;
        claim(0, x, y, 1.3, 1.3);
        m.at(c.x + x, c.y + y, c.h, 0);
        m.c = THATCH[2]; m.cone(7, 0, 0, 1.15 + rnd() * 0.3, -0.2, 1.8 + rnd() * 0.5, 0, true);
        made++;
      }
    } else {
      // Then rows that follow the wall, ring inside ring, wherever the streets left room.
      const depth = 2.9;
      for (let ring = 0; ring < 6; ring++) {
        const inset = S.wallT / 2 + 0.75 + depth / 2 + ring * 5.2, start = rnd() * TAU;
        if (Rw - 2 - inset < c.sq + depth / 2) break;
        for (let a = start, guard = 0; a < start + TAU && guard < 600; guard++) {
          const hit = reach(a), rho = hit[0] - inset, w = 3 + rnd() * 1.5, d = depth + (rnd() - 0.5) * 0.5, x = Math.cos(a) * rho, y = Math.sin(a) * rho;
          if (rho < c.sq + 2 || !free(x, y, hit[1], w, d, 0.3)) { a += 0.7 / Math.max(6, rho); continue; }
          house(m, c, x, y, hit[1], w, d, walls(ring > 1), 1.7 + rnd() * 0.5, 1, ring % 2 ? -1 : 1);
          claim(hit[1], x, y, w / 2, d / 2);
          a += (w + gap()) / rho;
        }
      }
    }

    // What the running game needs to know about this town.
    const wantSmoke = tier === 1 ? 3 : tier === 2 ? 4 : 6, wantFire = tier === 1 ? 4 : tier === 2 ? 6 : 9;
    for (let i = 0; i < wantSmoke && c.chimneys.length; i++) {
      const p = c.chimneys[Math.floor(i * c.chimneys.length / wantSmoke) % c.chimneys.length];
      info.chimneys.push([p[0], p[1], p[2], rnd()]);
    }
    c.burnable.sort((p, q) => p[0] - q[0]);
    for (let i = 0; i < wantFire && i < c.burnable.length; i++) { const p = c.burnable[i]; info.burn.push([p[1], p[2], p[3], rnd()]); }
    info.f1 = out.flags.length;
    info.wallR = Rw; info.wallH = S.wallH; info.gates = gates.map((g) => g.a); info.gate = gates.find((g) => g.main).a;
    for (let i = info.f0; i < info.f1; i++) info.top = Math.max(info.top, out.flags[i].top - site.h);
    for (let i = 0; i < tier * 3 + 1; i++) {
      const a = rnd() * TAU, d = c.sq * (0.3 + 0.55 * rnd());
      info.walkers.push([site.x + Math.cos(a) * d, site.y + Math.sin(a) * d, 0.8 + rnd() * 1.6, 0.6 + rnd() * 1.2, (rnd() < 0.5 ? -1 : 1) * (0.25 + rnd() * 0.3), rnd() * TAU]);
    }
  }

  /* ----- shaders: small additions to three's own Lambert material, so fog and light stay in step with the land ----- */

  const STATIC_HEAD = (n) => [
    'attribute vec4 aFx;', 'attribute vec4 aMove;',
    'uniform vec4 uTown[' + (n * 2) + '];', 'uniform float uSnow;', 'uniform float uTime;',
    'varying vec3 vLit;', ''].join('\n');
  const STATIC_COLOUR = [
    'int bcTown = int(aFx.x * 255.0 + 0.5) * 2;',
    'vec4 bcA = uTown[bcTown];            // scorch, hunger, lights, gates shut',
    'vec4 bcB = uTown[bcTown + 1];        // fire',
    'float bcSeed = position.x * 3.1 + position.z * 2.3;',
    '// soot on whatever can burn, worst on the roofs; then snow; then the grey of a town with nothing to eat',
    'float bcBurnt = aFx.z > 0.0 ? smoothstep(aFx.z - 0.05, aFx.z, bcA.x) : 0.0;',
    'vColor.rgb = mix(vColor.rgb, vec3(0.17, 0.15, 0.14) + vColor.rgb * 0.12, bcBurnt * (0.5 + 0.42 * aFx.y));',
    'vColor.rgb = mix(vColor.rgb, vec3(0.94, 0.96, 0.97), aFx.y * uSnow * (1.0 - bcBurnt));',
    'float bcGrey = dot(vColor.rgb, vec3(0.3, 0.59, 0.11));',
    'vColor.rgb = mix(vColor.rgb, vec3(bcGrey) * vec3(0.86, 0.84, 0.8), bcA.y * 0.72);',
    '// lit windows, and roofs that are alight',
    'float bcWin = aFx.w > 0.0 ? step(aFx.w * 2.3, bcA.z) : 0.0;',
    'vLit = vec3(1.0, 0.72, 0.34) * bcWin * (0.86 + 0.14 * sin(uTime * 2.7 + bcSeed));',
    'float bcFlare = max(0.0, sin(uTime * 8.0 + bcSeed * 1.7) * sin(uTime * 4.7 + bcSeed * 0.6) + 0.25);',
    'vLit += mix(vec3(0.5, 0.09, 0.02), vec3(1.0, 0.6, 0.14), min(1.0, bcFlare)) * (0.2 + bcFlare) * bcBurnt * bcB.x * step(0.4, aFx.y);',
    ''].join('\n');
  const STATIC_MOVE = 'transformed += aMove.xyz * (' + MOVE.toFixed(1) + ' * (1.0 - bcA.w));\n';

  const FLAG_WAVE = [
    '#ifdef USE_INSTANCING',
    'vec3 bcAt = instanceMatrix[3].xyz;',
    '#else',
    'vec3 bcAt = vec3(0.0);',
    '#endif',
    'float bcPh = bcAt.x * 0.37 + bcAt.z * 0.23;',
    '// From far off a banner is drawn larger than life, growing up and out from the foot of its hoist,',
    '// so that who holds a town can be read with the whole realm in view.',
    'float bcGrow = clamp(length((modelViewMatrix * vec4(bcAt, 1.0)).xyz) / 400.0, 1.0, 5.0);',
    'float bcU = position.x;              // 0 at the hoist, 1 at the fly',
    'float bcRip = sin(bcU * 6.2 - uTime * 5.0 + bcPh + position.y * 1.1) * 0.17 + sin(bcU * 11.0 - uTime * 7.7 + bcPh * 1.7) * 0.05;',
    'float bcSway = sin(uTime * 0.8 + bcPh) * 0.16 + sin(uTime * 2.1 + bcPh * 1.3) * 0.05;',
    'transformed.z += bcRip * smoothstep(0.0, 0.35, bcU) + bcSway * bcU;',
    'transformed.y += (sin(uTime * 2.6 + bcPh) * 0.04 - 0.09 * bcU) * bcU;',
    'transformed.xz *= bcGrow;',
    'transformed.y = (transformed.y + 0.5) * bcGrow - 0.5;',
    ''].join('\n');

  /* ----- the module ----- */

  class Towns {
    constructor(THREE, scene, game, terrain) {
      const T = (this.T = THREE);
      this.scene = scene; this.game = game; this.land = terrain; this.theme = null;
      this.group = new T.Group();
      scene.add(this.group);
      this.calm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      this.clock = -1e9; this.snow = 0;
      this.M = new T.Matrix4(); this.q = new T.Quaternion(); this.p = new T.Vector3(); this.s = new T.Vector3(); this.C = new T.Color();
      this.up = new T.Vector3(0, 1, 0); this.eye = new T.Vector3(0, 400, 0); this.lens = new T.Matrix4();
      this.nSmoke = 0; this.nFlame = 0; this.nFolk = 0; this.nGlow = 0;
      this.build();
    }

    build() {
      const T = this.T, L = this.land, g = this.game, m = new Mesher(), n = g.keeps.length;
      const out = { towns: [], flags: [] };
      for (const site of L.sites) layTown(m, site, g.keeps[site.id], L, g.seed | 0, out);
      this.towns = out.towns;
      this.state = g.keeps.map((k) => ({ owner: k.owner, shown: k.owner, wave: 0, shut: 0, hunger: 0, fire: 0, mob: 0, lights: 0, scorch: 0 }));
      this.uni = { uTime: { value: 0 }, uSnow: { value: 0 }, uTown: { value: new Float32Array(n * 8) } };
      const uni = this.uni;

      // Everything that stands still, in one mesh.
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(new Float32Array(m.pos), 3));
      geo.setAttribute('color', new T.BufferAttribute(new Uint8Array(new Uint8ClampedArray(m.col).buffer), 3, true));
      geo.setAttribute('aFx', new T.BufferAttribute(new Uint8Array(new Uint8ClampedArray(m.fx).buffer), 4, true));
      geo.setAttribute('aMove', new T.BufferAttribute(new Int8Array(m.mv), 4, true));
      geo.setIndex(new T.BufferAttribute(m.n > 65535 ? new Uint32Array(m.idx) : new Uint16Array(m.idx), 1));
      const mat = new T.MeshLambertMaterial({ vertexColors: true, flatShading: true });
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uTown = uni.uTown; sh.uniforms.uSnow = uni.uSnow; sh.uniforms.uTime = uni.uTime;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\n' + STATIC_HEAD(n))
          .replace('#include <color_vertex>', '#include <color_vertex>\n' + STATIC_COLOUR)
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + STATIC_MOVE);
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vLit;')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vLit;');
      };
      mat.customProgramCacheKey = () => 'bc-towns-' + n;
      this.fabric = new T.Mesh(geo, mat);
      this.fabric.frustumCulled = false;         // one mesh spans the whole realm, so there is nothing to cull
      this.fabric.castShadow = this.fabric.receiveShadow = true;     // costs nothing unless somebody turns shadow maps on
      // update() is not told where the camera is, but small things are only worth drawing near it and fires are
      // drawn larger far from it. Three hands us the camera here, a frame late, which is near enough.
      this.fabric.onBeforeRender = (renderer, scene, camera) => {
        this.eye.setFromMatrixPosition(camera.matrixWorld);
        this.lens.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      };

      // Banners: one instance each, rippled in the vertex shader so the wind costs nothing.
      const cloth = new T.PlaneGeometry(1, 1, 6, 2); cloth.translate(0.5, 0, 0);
      const cp = cloth.attributes.position;
      for (let i = 0; i < cp.count; i++) if (cp.getX(i) > 0.99 && Math.abs(cp.getY(i)) < 0.01) cp.setX(i, 0.74);     // a swallow tail
      const flagMat = new T.MeshLambertMaterial({ side: T.DoubleSide, flatShading: true });
      flagMat.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = uni.uTime;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + FLAG_WAVE);
        // Keep the cloth close to its true colour in any light, so a banner reads the same as its plate on the map.
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.34;\ndiffuseColor.rgb *= 0.7;');
      };
      flagMat.customProgramCacheKey = () => 'bc-flags';
      this.flagList = out.flags;
      this.flags = new T.InstancedMesh(cloth, flagMat, Math.max(1, out.flags.length));
      this.flags.count = out.flags.length;
      this.q.setFromAxisAngle(this.up, -WIND);
      for (let i = 0; i < out.flags.length; i++) { this.setFlag(i, 1); this.flags.setColorAt(i, this.C.setRGB(0.7, 0.7, 0.66)); }

      // Smoke: faceted puffs, in keeping with the rest of the map, and just thin enough to see through.
      this.smoke = new T.InstancedMesh(new T.IcosahedronGeometry(1, 0), new T.MeshLambertMaterial({ flatShading: true, transparent: true, opacity: 0.82 }), MAX_SMOKE);
      this.smoke.renderOrder = 3;
      this.spin = [];
      for (let i = 0; i < 8; i++) this.spin.push(new T.Matrix4().makeRotationFromEuler(new T.Euler(i * 1.3, i * 2.1, i * 0.7)));

      // Flames: burning roofs, gate torches, the torches of a mob. Unlit, so they glow at dusk.
      const tongue = new T.ConeGeometry(0.42, 1.5, 5); tongue.translate(0, 0.75, 0);
      this.flames = new T.InstancedMesh(tongue, new T.MeshBasicMaterial(), MAX_FLAME);

      // Townsfolk: a body and a head, in drab cloth so nobody takes them for soldiers.
      const fm = new Mesher();
      fm.box(-0.38, 0, -0.26, 0.38, 1.5, 0.26); fm.box(-0.22, 1.5, -0.22, 0.22, 1.95, 0.22);
      const body = new T.BufferGeometry();
      body.setAttribute('position', new T.BufferAttribute(new Float32Array(fm.pos), 3));
      body.setIndex(fm.idx);
      this.folk = new T.InstancedMesh(body, new T.MeshLambertMaterial({ flatShading: true }), MAX_FOLK);

      // Light on the ground: under a burning town, round a torchlit crowd, in the streets at dusk.
      // The brightness of an instance's colour says how strongly it lies there.
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      const ctx = cv.getContext('2d'), grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.45, 'rgba(255,255,255,0.55)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, 64, 64);
      this.glowTex = new T.CanvasTexture(cv);
      const disc = new T.PlaneGeometry(1, 1); disc.rotateX(-Math.PI / 2);
      const glowMat = new T.MeshBasicMaterial({ map: this.glowTex, transparent: true, depthWrite: false });
      glowMat.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', [
          '#include <color_fragment>',
          '#ifdef USE_COLOR',
          'float bcStrength = max(vColor.r, max(vColor.g, vColor.b));',
          'diffuseColor.rgb /= max(bcStrength, 0.001);',
          'diffuseColor.a *= min(1.0, bcStrength);',
          '#endif', ''].join('\n'));
      };
      glowMat.customProgramCacheKey = () => 'bc-glow';
      this.glow = new T.InstancedMesh(disc, glowMat, Math.max(1, n * 3));
      this.glow.renderOrder = 2;

      this.parts = [this.fabric, this.flags, this.smoke, this.flames, this.folk, this.glow];
      for (const o of this.parts) {
        if (o.isInstancedMesh) {
          o.frustumCulled = false;
          if (o !== this.flags) { o.setColorAt(0, this.C.setRGB(1, 1, 1)); o.count = 0; }
        }
        this.group.add(o);
      }
    }

    /** Put banner `i` where it flies. `u` is 1 when fully hoisted, 0 when it has come down the pole. */
    setFlag(i, u) {
      const f = this.flagList[i];
      this.p.set(f.x, f.top - f.hgt / 2 - (1 - u) * f.drop, f.y);
      this.s.set(f.w * (0.3 + 0.7 * u), f.hgt * (0.5 + 0.5 * u), f.w);
      this.flags.setMatrixAt(i, this.M.compose(this.p, this.q, this.s));
    }

    /** Colour every banner of town `i` for the owner it is showing. */
    paintFlags(i) {
      const th = this.theme, owner = this.state[i].shown, f = owner >= 0 && this.game.factions[owner];
      const c = f ? th.f[f.color] || th.free : th.free;
      this.C.setRGB(c[0] / 255, c[1] / 255, c[2] / 255);
      for (let j = this.towns[i].f0; j < this.towns[i].f1; j++) this.flags.setColorAt(j, this.C);
      this.flags.instanceColor.needsUpdate = true;
    }

    setTheme(theme) {
      this.theme = theme;
      for (let i = 0; i < this.state.length; i++) this.paintFlags(i);
    }

    /** One puff of a smoke column: it swells as it climbs and leans downwind, then thins away. `age` runs 0 to 1. */
    puff(x, y, z, age, rise, size, drift, dark, turn) {
      if (this.nSmoke >= MAX_SMOKE) return;
      const sc = size * (0.34 + 0.76 * age) * (0.82 + 0.36 * hash(turn, 7)) * Math.min(1, age * 6) * Math.min(1, (1 - age) * 3.2);
      if (sc < 0.03) return;
      const e = age * age * drift, g = dark ? lerp(0.17, 0.5, age) : lerp(0.7, 0.86, age);
      this.M.copy(this.spin[turn & 7]).scale(this.s.set(sc, sc, sc)).setPosition(x + Math.cos(WIND) * e, y + rise * age, z + Math.sin(WIND) * e);
      this.smoke.setMatrixAt(this.nSmoke, this.M);
      this.smoke.setColorAt(this.nSmoke++, this.C.setRGB(g, g, g * 1.03));
    }

    flame(x, y, z, size, turn, hot) {
      if (this.nFlame >= MAX_FLAME || size < 0.05) return;
      this.M.makeRotationY(turn).scale(this.s.set(size, size * (1.1 + 0.25 * Math.sin(turn * 3.7)), size)).setPosition(x, y, z);
      this.flames.setMatrixAt(this.nFlame, this.M);
      this.flames.setColorAt(this.nFlame++, hot ? this.C.setRGB(1, 0.84, 0.36) : this.C.setRGB(1, 0.5, 0.13));
    }

    person(x, y, z, face, c, k) {
      if (this.nFolk >= MAX_FOLK) return;
      this.M.makeRotationY(-face).setPosition(x, y, z);
      this.folk.setMatrixAt(this.nFolk, this.M);
      this.folk.setColorAt(this.nFolk++, this.C.setRGB(c[0] / 255 * k, c[1] / 255 * k, c[2] / 255 * k));
    }

    light(x, y, z, size, r, g, b, strength) {
      if (this.nGlow >= this.glow.instanceMatrix.count || strength < 0.01) return;
      this.M.makeScale(size, 1, size).setPosition(x, y, z);
      this.glow.setMatrixAt(this.nGlow, this.M);
      this.glow.setColorAt(this.nGlow++, this.C.setRGB(r * strength, g * strength, b * strength));
    }

    /**
     * Town `id` as it was built, for anything that wants to stand a figure or a label against it:
     * { x, y, h, r, tier, wallR (radius of the wall line), wallH (its height), gate (map angle of the main gate),
     * gates (map angles of every gate), top (height above h of the highest banner) }. Do not change it.
     */
    site(id) { return this.towns[id] || null; }

    /** Called every frame: `t` is seconds since the view started. */
    update(dt, game, t) {
      const th = this.theme;
      if (!th) return;
      const K = game.keeps, n = Math.min(K.length, this.state.length), U = this.uni.uTown.value, E = this.lens.elements;
      // After a fast-forward or a restart there is nothing to animate from: show things as they now are.
      const jump = Math.abs(game.time - this.clock) > 1.2;
      this.clock = game.time;
      const wt = this.calm ? 0 : t, bob = this.calm ? 0 : 1, winter = game.season === 3 ? 1 : 0;
      this.snow = jump ? winter : toward(this.snow, winter, dt / 3.5);
      this.uni.uTime.value = wt; this.uni.uSnow.value = this.snow * 0.94;
      this.nSmoke = this.nFlame = this.nFolk = this.nGlow = 0;
      let hoisting = false;

      for (let i = 0; i < n; i++) {
        const k = K[i], s = this.state[i], tw = this.towns[i];
        if (!tw) continue;
        const shut = k.camp ? 1 : 0, hungry = k.hungry ? 1 : 0, sack = Math.max(0, k.sacked || 0);
        const fire = clamp((sack - 6) / 10, 0, 1), mob = k.owner >= 0 ? clamp((k.unrest - 0.68) / 0.24, 0, 1) : 0;
        const lights = !th.dark ? 0 : fire > 0.2 ? 0.2 : hungry ? 0.3 : shut ? 0.62 : 1;
        if (jump) { s.shut = shut; s.hunger = hungry; s.fire = fire; s.mob = mob; s.lights = lights; s.scorch = sack > 0 ? 1 : 0; }
        else {
          s.shut = toward(s.shut, shut, dt * 1.8); s.hunger = toward(s.hunger, hungry, dt * 0.5);
          s.fire = toward(s.fire, fire, dt * 0.8); s.mob = toward(s.mob, mob, dt * 0.7); s.lights = toward(s.lights, lights, dt * 0.9);
          s.scorch = sack > 0 ? toward(s.scorch, 1, dt * 0.3) : toward(s.scorch, 0, dt / 45);     // roofs stay black long after the fires are out
        }
        const o = i * 8;
        U[o] = s.scorch; U[o + 1] = s.hunger; U[o + 2] = s.lights; U[o + 3] = s.shut; U[o + 4] = s.fire;
        // Where the camera is decides what is worth drawing: hearth smoke and people only show close to, and on screen.
        const range = Math.hypot(this.eye.x - tw.x, this.eye.y - tw.h, this.eye.z - tw.y);
        const cx = E[0] * tw.x + E[4] * tw.h + E[8] * tw.y + E[12], cy = E[1] * tw.x + E[5] * tw.h + E[9] * tw.y + E[13], cw = E[3] * tw.x + E[7] * tw.h + E[11] * tw.y + E[15];
        const close = cw > 0 && Math.abs(cx) < cw * 1.8 && Math.abs(cy) < cw * 1.8 ? clamp((FAR - range) / 160, 0, 1) : 0;

        // The banner follows the owner: the old colours come down, the new ones go up.
        if (s.owner !== k.owner) {
          s.owner = k.owner;
          if (jump || this.calm) { s.shown = k.owner; s.wave = 0; this.paintFlags(i); } else if (!(s.wave > 0)) s.wave = 1e-6;
        }
        if (s.wave > 0) {
          s.wave += dt;
          if (s.wave >= DROP && s.shown !== s.owner) { s.shown = s.owner; this.paintFlags(i); }
          let u = s.wave < DROP ? 1 - s.wave / DROP : Math.min(1, (s.wave - DROP) / RISE);
          if (s.wave >= DROP + RISE) { u = 1; s.wave = 0; }
          u = u * u * (3 - 2 * u);
          for (let j = tw.f0; j < tw.f1; j++) this.setFlag(j, u);
          hoisting = true;
        }

        // Hearth smoke, unless the town has nothing to cook or is on fire.
        const hearth = (1 - s.hunger) * (1 - s.fire) * close;
        if (hearth > 0.05) {
          for (let q = 0; q < tw.chimneys.length; q++) {
            const ch = tw.chimneys[q];
            for (let j = 0; j < 6; j++) this.puff(ch[0], ch[2] - 0.2, ch[1], frac(wt * 0.11 + ch[3] + j / 6), 4.6 + 2 * this.snow, 0.62 * hearth * (1 + 0.4 * this.snow), 2.6, false, q * 6 + j);
          }
        }

        // A sack: roofs alight, a column of dark smoke, firelight on the ground. Then it smoulders.
        // Like the banners, fire and its smoke are drawn larger from far off, so a sack shows with the whole realm in view.
        const reek = sack > 0 ? clamp(sack / 9, 0.3, 1) : clamp(s.scorch * 1.4 - 0.95, 0, 0.3);
        const big = 1 + 0.75 * (clamp(range / 480, 1, 4.5) - 1);
        if (reek > 0.02) {
          // every other burning roof sends up a column; the puffs overlap, so each reads as one billowing mass
          const live = Math.ceil(tw.burn.length * Math.min(1, reek + 0.2));
          for (let q = 0; q < live; q += 2) {
            const b = tw.burn[q];
            for (let j = 0; j < 8; j++) this.puff(b[0], b[2] - 0.5, b[1], frac(wt * 0.075 + b[3] + j / 8), (20 + 4 * tw.tier) * (0.7 + 0.3 * big), (2 + 0.5 * tw.tier) * (0.5 + 0.5 * reek) * big, 11 * big, true, q * 8 + j);
          }
        }
        if (s.fire > 0.03) {
          for (let q = 0; q < tw.burn.length; q++) {
            const b = tw.burn[q], f = s.fire * big * (0.78 + 0.22 * Math.sin(wt * 12 + q * 2.4) * Math.sin(wt * 7.3 + q));
            this.flame(b[0], b[2] - 0.6, b[1], (1.9 + 0.5 * tw.tier) * f, wt * 3 + q, 0);
            this.flame(b[0] + 0.7, b[2] - 1, b[1] - 0.5, (1.2 + 0.35 * tw.tier) * f, wt * 4 + q * 1.7, 1);
            this.flame(b[0] - 0.6, b[2] - 1.1, b[1] + 0.6, (1 + 0.3 * tw.tier) * f, wt * 5 + q * 2.3, 1);
          }
          this.light(tw.x, tw.h + 0.5, tw.y, tw.r * (1.7 + 0.3 * s.fire + 0.08 * Math.sin(wt * 9)), 1, 0.45, 0.12, s.fire * (th.dark ? 0.85 : 0.5));
        }

        // Lamplight in the streets at dusk, as far as the town can afford it; it is what shows a town from across the realm.
        if (s.lights > 0.03 && s.fire < 0.5) this.light(tw.x, tw.h + 0.42, tw.y, tw.r * 2.3, 1, 0.74, 0.4, 0.36 * s.lights);

        // Torches by the gate at dusk, and day and night while the town is under siege.
        if (th.dark || s.shut > 0.5) {
          for (let q = 0; q < tw.torches.length; q++) { const p = tw.torches[q]; this.flame(p[0], p[2], p[1], 0.5 + 0.1 * Math.sin(wt * 14 + q * 3 + i), wt * 4 + q + i, q & 1); }
        }

        // A town close to revolt: a crowd before the keep, torches over their heads.
        if (s.mob > 0.02) {
          const count = Math.round((8 + 22 * s.mob) * (0.7 + 0.3 * tw.tier));
          for (let j = 0; j < count; j++) {
            const rr = 0.8 * Math.sqrt(j + 0.6), a = j * 2.39996 + tw.seed;
            const x = tw.mob[0] + Math.cos(a) * rr + Math.sin(wt * 2.3 + j * 1.9) * 0.16 * bob, y = tw.mob[1] + Math.sin(a) * rr + Math.cos(wt * 1.9 + j * 2.7) * 0.16 * bob;
            this.person(x, tw.h + c0(Math.sin(wt * 6 + j * 2.2)) * 0.28 * bob, y, tw.face, FOLK[j % FOLK.length], 0.72);
            if (j % 4 === 1) this.flame(x, tw.h + 2.3, y, 0.42 + 0.1 * Math.sin(wt * 15 + j), wt * 5 + j, j & 1);
          }
          this.light(tw.mob[0], tw.h + 0.47, tw.mob[1], (11 + 8 * s.mob) * (1 + 0.06 * Math.sin(wt * 8)), 1, 0.3, 0.12, (0.35 + 0.3 * s.mob) * (th.dark ? 1.2 : 0.85));
        }

        // People about their business on the square, while the gates are open and there is bread.
        const stroll = close > 0 ? (1 - s.shut) * (1 - 0.7 * s.hunger) * (1 - s.mob) * (s.fire > 0.1 ? 0 : 1) : 0;
        for (let j = Math.round(tw.walkers.length * stroll) - 1; j >= 0; j--) {
          const w = tw.walkers[j], ph = wt * w[4] + w[5];
          this.person(w[0] + Math.cos(ph) * w[2], tw.h, w[1] + Math.sin(ph) * w[3], Math.atan2(Math.cos(ph) * w[3] * w[4], -Math.sin(ph) * w[2] * w[4]), FOLK[(i + j) % FOLK.length], 1);
        }
      }

      if (hoisting) this.flags.instanceMatrix.needsUpdate = true;
      this.commit(this.smoke, this.nSmoke); this.commit(this.flames, this.nFlame);
      this.commit(this.folk, this.nFolk); this.commit(this.glow, this.nGlow);
    }

    /** Hand this frame's instances to the GPU: only as many as are in use, not the whole buffer. */
    commit(mesh, count) {
      mesh.count = count;
      if (!count) return;
      mesh.instanceMatrix.updateRange.count = count * 16; mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.updateRange.count = count * 3; mesh.instanceColor.needsUpdate = true;
    }

    dispose() {
      this.scene.remove(this.group);
      for (const o of this.parts) {
        o.geometry.dispose(); o.material.dispose();
        if (o.isInstancedMesh) o.dispose();
      }
      this.glowTex.dispose();
    }
  }

  BC.Towns = Towns;
})();
