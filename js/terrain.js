/*
 * Borrowed Crown: the lie of the land.
 *
 * Turns the simulation's flat map (towns and the roads between them) into a height field
 * with a coast, plains, hills, mountains, woods and farmland. No rendering in here and no
 * DOM, so it runs under Node as well. The simulation never reads any of this: terrain is
 * for the eye. Everything comes out of game.seed, so the same seed is always the same land.
 *
 * The shape of it: towns and roads stand in low, gentle country, because armies have to
 * walk there. Relief grows with the distance from both, and the biggest empty gaps between
 * the road corridors are filled with mountain masses instead of water.
 *
 * Coordinates: (x, y) are the simulation's map coordinates, h is height above sea level.
 * In the 3D scene that is (x, h, y).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  /** 0 at `a`, 1 at `b`, eased; `a` may be the larger of the two. */
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const SITE_R = [0, 20, 27, 36];           // footprint of a village, a town, a city

  function hash(ix, iy, seed) {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function noise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  /** Noise folded about its middle: sharp crests where the plain noise crosses one half. */
  function ridged(x, y, seed) {
    const v = 1 - Math.abs(2 * noise(x, y, seed) - 1);
    return v * v;
  }

  /**
   * @param {object} game  a BC.Game (only W, H, seed, keeps and roads are read)
   * @returns {object} terrain:
   *   W, H, cell, nx, nz           grid: nx by nz vertices, `cell` map units apart (the last row and column stop at the map edge)
   *   height   Float32Array        metres above sea level per vertex; below 0 is sea bed
   *   land     Uint8Array          1 where the vertex is dry land
   *   water    Uint8Array          0 dry land, 1 open sea, 2 lake (water shut in by land)
   *   province Uint8Array          index of the nearest town, i.e. whose land this is
   *   shore    Float32Array        signed distance to the coast per vertex, roughly in map units: below 0 inland, above 0 out at sea
   *   fromRoad Float32Array        distance from each vertex to the nearest road
   *   split    Uint8Array          per grid cell (nx - 1 by nz - 1): which diagonal cuts it into its two triangles.
   *                                1 runs from the cell's first vertex to the one diagonally opposite, 0 the other way
   *   heightAt(x, y)               height at any map point, on those triangles: the ground exactly as it is drawn
   *   shoreAt(x, y)                the shore distance at any map point (bilinear)
   *   roads    [{ a, b, pts }]     one per simulation road; pts is [[x, y, h], ...] draped on the ground.
   *                                The ground is levelled across every road and never steep along one
   *   sites    [{ id, x, y, h, r, gate: [dx, dy], yard: [x, y] }]   per town: level ground of radius r,
   *                                the way its gate faces, and where its garrison musters
   *   trees    Float32Array        x, y, h, scale, kind (0 conifer, 1 broadleaf), five numbers per tree
   *   fields   [{ x, y, h, w, d, rot, crop, town }]   farm plots round the towns: w along the direction `rot`, d across it
   *   hedges   Float32Array        x, y, h, length, rot, five numbers per hedge, along some of the field edges
   *   rocks    Float32Array        x, y, h, scale, four numbers per rock
   *   borders  [{ a, b, pts }]     where the lands of towns a and b meet, dry land only: pts is [[x, y, h], ...]
   *                                on the ground, a few paces apart. A border crossed by the sea comes as several runs
   *   peaks    [{ x, y, h }]       the summit of each mountain mass
   */
  function buildTerrain(game) {
    const W = game.W, H = game.H, K = game.keeps, seed = game.seed | 0;
    const cell = Math.max(6, Math.sqrt(W * H / 26000));
    const nx = Math.ceil(W / cell) + 1, nz = Math.ceil(H / cell) + 1, n = nx * nz;
    const height = new Float32Array(n), land = new Uint8Array(n), province = new Uint8Array(n), shore = new Float32Array(n);
    const water = new Uint8Array(n), fromRoad = new Float32Array(n);
    const segs = game.roads.map((r) => {
      const a = K[r.a], b = K[r.b], dx = b.x - a.x, dy = b.y - a.y;
      return [a.x, a.y, dx, dy, dx * dx + dy * dy];
    });

    // Distance to the nearest town and the nearest road, and whose province a point is in.
    // The answer is left in `sv` so the inner loops do not allocate.
    const sv = { dk: 0, dr: 0, id: 0, road: 0 };
    function survey(wx, wy) {
      let dk = 1e12, id = 0;
      for (let k = 0; k < K.length; k++) {
        const dx = K[k].x - wx, dy = K[k].y - wy, d = dx * dx + dy * dy;
        if (d < dk) { dk = d; id = k; }
      }
      let dr = 1e12, road = 0;
      for (let r = 0; r < segs.length; r++) {
        const s = segs[r];
        const t = clamp(((wx - s[0]) * s[2] + (wy - s[1]) * s[3]) / s[4], 0, 1);
        const ex = s[0] + s[2] * t - wx, ey = s[1] + s[3] * t - wy, d = ex * ex + ey * ey;
        if (d < dr) { dr = d; road = r; }
      }
      sv.dk = Math.sqrt(dk); sv.dr = Math.sqrt(dr); sv.id = id; sv.road = road;
    }
    /** How far a surveyed point is from anything an army has to cross: 0 on roads and round towns. */
    const wildness = () => Math.max(0, Math.min(sv.dk - SITE_R[K[sv.id].tier] - 44, sv.dr - 20));

    // True when towns stand all round a point, i.e. it is inside the realm and not off its outer coast.
    function ringed(x, y) {
      const angs = [];
      for (const k of K) if (Math.hypot(k.x - x, k.y - y) < 460) angs.push(Math.atan2(k.y - y, k.x - x));
      if (angs.length < 3) return false;
      angs.sort((p, q) => p - q);
      let gap = angs[0] + TAU - angs[angs.length - 1];
      for (let i = 1; i < angs.length; i++) gap = Math.max(gap, angs[i] - angs[i - 1]);
      return gap < 3.75;
    }

    // Mountain masses go where there is most room between the road corridors: the widest gaps first,
    // well apart from each other, so some gaps are left as lakes and bays.
    const massifs = [];
    {
      const step = 20, gaps = [];
      for (let y = step; y < H; y += step) for (let x = step; x < W; x += step) {
        survey(x, y);
        gaps.push([Math.min(sv.dk - 86, sv.dr - 32), x, y, Math.min(x, y, W - x, H - y)]);
      }
      const most = clamp(Math.round(W * H / 190000), 2, 6);
      // First ask for real room, well inside the realm. A crowded little map may have no gap that wide;
      // then smaller hills nearer the coast will do, so that every land has some high ground.
      for (const ask of [[22, 96, true, most], [10, 70, false, 2]]) {
        const cands = [];
        for (const c of gaps) { const room = Math.min(c[0], c[3] - ask[1]); if (room >= ask[0]) cands.push([room, c[1], c[2]]); }
        cands.sort((p, q) => q[0] - p[0] || p[2] - q[2] || p[1] - q[1]);
        for (const c of cands) {
          if (massifs.length >= ask[3]) break;
          if (massifs.some((m) => Math.hypot(m.x - c[1], m.y - c[2]) < m.room + c[0] + 110) || (ask[2] && !ringed(c[1], c[2]))) continue;
          massifs.push({ x: c[1], y: c[2], room: c[0], r: c[0] + 60, top: clamp(27 + c[0], 44, 104) });
        }
      }
    }

    // The coast is the one the flat map draws (land hugs the towns and the roads), with three additions:
    // mountain country fills the gap it stands in, and no road or town is ever left standing in the water.
    function coast(wx, wy) {
      const rim = Math.min(wx, wy, W - wx, H - wy);
      const wob = (noise(wx / 150, wy / 150, seed) - 0.5) * 70 + (noise(wx / 50 + 7.3, wy / 50 + 1.9, seed + 11) - 0.5) * 30;
      let f = Math.min(sv.dk - 108, sv.dr - 30) + wob;
      for (const m of massifs) f = Math.min(f, Math.hypot(wx - m.x, wy - m.y) - m.room - 46 + wob * 0.45);
      f = Math.min(f, sv.dr - 13 + wob * 0.1, sv.dk - SITE_R[K[sv.id].tier] - 46);
      // The sea always wins near the edge of the world, along a line that wanders rather than a ruled one.
      return f + Math.max(0, 28 + 44 * noise(wx / 95 + 0.4, wy / 95 + 5.8, seed + 13) - rim) * 2.2;
    }

    // Height of a surveyed point whose shore distance is f.
    function relief(wx, wy, f) {
      if (f >= 0) {
        // Sea bed: a shelf of shallows, wider in some bays than others, then the drop.
        const shelf = noise(wx / 130 + 2.2, wy / 130 + 7.7, seed + 91);
        return -Math.min(18, 0.4 + f * (0.16 + 0.16 * shelf) + f * f * 0.006);
      }
      const cd = -f, wild = smooth(0, 42, wildness());
      // Hills may come closer to a road than mountains do: a road runs along the valley between them.
      const rolling = smooth(0, 34, Math.min(sv.dk - SITE_R[K[sv.id].tier] - 36, sv.dr - 13));
      // Mountains: a broad swell over each mass, cut into crests, spurs and gullies by ridged noise.
      const wx2 = wx + (noise(wx / 90 + 6.6, wy / 90 + 1.2, seed + 81) - 0.5) * 56, wy2 = wy + (noise(wx / 90 + 3.9, wy / 90 + 8.4, seed + 83) - 0.5) * 56;
      let dome = 0;
      for (const m of massifs) {
        const u = Math.hypot(wx2 - m.x, wy2 - m.y) / m.r;
        if (u < 1) dome = Math.max(dome, m.top * smooth(1, 0.28, u) * (0.82 + 0.18 * (1 - u * u)));
      }
      const crest = 0.64 * ridged(wx / 78 + 3.1, wy / 78 + 8.7, seed + 21) + 0.36 * ridged(wx / 33 + 5.5, wy / 33 + 1.4, seed + 23);
      const mountain = dome * (0.36 + 0.64 * crest);
      // Hills: here and there in any wild country.
      const downs = noise(wx / 88 + 1.7, wy / 88 + 5.3, seed + 31);
      const hills = 34 * smooth(0.36, 0.74, downs) * (0.75 + 0.5 * noise(wx / 31, wy / 31, seed + 33)) * rolling;
      const rough = (noise(wx / 15, wy / 15, seed + 35) - 0.5) * (2 + dome * 0.09) * wild;
      const upland = Math.max(mountain * wild, hills) + Math.min(mountain * wild, hills) * 0.3 + rough;
      // Most shores are beaches; where the cliff noise runs high the upland comes straight down to the sea.
      const lip = lerp(36, 7, smooth(0.5, 0.66, noise(wx / 120 + 9.1, wy / 120 + 2.3, seed + 41)));
      // Low country: a beach, then a plain that rolls a little and sits higher in some regions than others.
      const plain = 0.7 + 2.3 * smooth(0, 22, cd)
        + (6.5 * smooth(0.32, 0.8, noise(wx / 340 + 0.6, wy / 340 + 4.2, seed + 71)) + 2.6 * (noise(wx / 72 + 4.4, wy / 72 + 6.1, seed + 73) - 0.5)) * smooth(8, 70, cd);
      return Math.max(0.6, plain + upland * smooth(-1, lip, cd));
    }

    for (let z = 0, i = 0; z < nz; z++) for (let x = 0; x < nx; x++, i++) {
      const wx = Math.min(W, x * cell), wy = Math.min(H, z * cell);
      survey(wx, wy);
      const f = coast(wx, wy);
      shore[i] = f; province[i] = sv.id; land[i] = f < 0 ? 1 : 0; fromRoad[i] = sv.dr;
      height[i] = relief(wx, wy, f);
    }

    // Open sea is whatever water the edge of the map can reach; the rest is lakes. Ponds too small to
    // read as water are filled in as low, wet ground.
    {
      const queue = new Int32Array(n);
      const flood = (start, mark) => {
        let head = 0, tail = 0;
        queue[tail++] = start; water[start] = mark;
        while (head < tail) {
          const i = queue[head++], x = i % nx;
          if (x > 0 && !land[i - 1] && !water[i - 1]) { water[i - 1] = mark; queue[tail++] = i - 1; }
          if (x < nx - 1 && !land[i + 1] && !water[i + 1]) { water[i + 1] = mark; queue[tail++] = i + 1; }
          if (i >= nx && !land[i - nx] && !water[i - nx]) { water[i - nx] = mark; queue[tail++] = i - nx; }
          if (i < n - nx && !land[i + nx] && !water[i + nx]) { water[i + nx] = mark; queue[tail++] = i + nx; }
        }
        return tail;
      };
      for (let i = 0; i < n; i++) {
        const x = i % nx, z = (i - x) / nx;
        if ((x === 0 || z === 0 || x === nx - 1 || z === nz - 1) && !land[i] && !water[i]) flood(i, 1);
      }
      for (let i = 0; i < n; i++) {
        if (land[i] || water[i]) continue;
        const size = flood(i, 2);
        if (size >= 9) continue;
        for (let q = 0; q < size; q++) { const v = queue[q]; water[v] = 0; land[v] = 1; shore[v] = -1.5; height[v] = 0.7; }
      }
    }

    function sample(grid, x, y) {
      const gx = clamp(x / cell, 0, nx - 1.001), gz = clamp(y / cell, 0, nz - 1.001);
      const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz, i = iz * nx + ix;
      const a = grid[i], b = grid[i + 1], c = grid[i + nx], d = grid[i + nx + 1];
      return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
    }
    // While the land is still being shaped, heights are read smoothly; once it is settled, heightAt below
    // is switched to read the flat triangles the ground is drawn with.
    let heightAt = (x, y) => sample(height, x, y);
    const shoreAt = (x, y) => sample(shore, x, y);

    // Level the ground each town stands on, and ease the country round it down to that level.
    const sites = K.map((k) => {
      const r = SITE_R[k.tier];
      const h = clamp(heightAt(k.x, k.y) + 0.5, 2.2, 13);
      const to = K[k.adj[0]];
      const gl = Math.hypot(to.x - k.x, to.y - k.y) || 1, gx = (to.x - k.x) / gl, gy = (to.y - k.y) / gl;
      return { id: k.id, x: k.x, y: k.y, h: h, r: r, gate: [gx, gy], yard: [k.x + gx * (r + 15) - gy * 17, k.y + gy * (r + 15) + gx * 17] };
    });
    // Neighbouring towns are kept near enough in height that the road between them need not be steep.
    for (let pass = 0; pass < 40; pass++) {
      for (const r of game.roads) {
        const a = sites[r.a], b = sites[r.b];
        const over = Math.abs(a.h - b.h) - 0.06 * Math.max(10, Math.hypot(b.x - a.x, b.y - a.y) - a.r - b.r - 12);
        if (over > 0) { const d = (a.h > b.h ? 0.5 : -0.5) * over; a.h -= d; b.h += d; }
      }
    }
    for (const s of sites) {
      const flat = s.r + 6, reach = s.r * 1.6 + 42;
      const x0 = Math.max(0, Math.floor((s.x - reach) / cell)), x1 = Math.min(nx - 1, Math.ceil((s.x + reach) / cell));
      const z0 = Math.max(0, Math.floor((s.y - reach) / cell)), z1 = Math.min(nz - 1, Math.ceil((s.y + reach) / cell));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const i = z * nx + x;
        if (!land[i]) continue;
        height[i] += (s.h - height[i]) * smooth(reach, flat, Math.hypot(x * cell - s.x, z * cell - s.y));
      }
    }

    // Road beds. Each road gets a smoothed profile along its length, and the ground within a few paces
    // is brought to that profile, so a road is level from side to side and never steep from end to end.
    {
      const bedD = new Float32Array(n).fill(1e9), bedH = new Float32Array(n), reach = 21;
      for (const r of game.roads) {
        const a = K[r.a], b = K[r.b], len = Math.hypot(b.x - a.x, b.y - a.y), m = Math.max(4, Math.round(len / 3));
        let prof = new Float32Array(m + 1), next = new Float32Array(m + 1);
        for (let i = 0; i <= m; i++) prof[i] = Math.max(1.3, heightAt(a.x + (b.x - a.x) * i / m, a.y + (b.y - a.y) * i / m));
        // Smooth it well, holding each end at the level of the town it runs into, then fill any dip
        // that would still make the men climb: a causeway is better than a scramble.
        const ia = Math.ceil((sites[r.a].r + 6) / len * m), ib = m - Math.ceil((sites[r.b].r + 6) / len * m);
        for (let pass = 0; pass < 6; pass++) {
          for (let i = 0; i <= m; i++) {
            let sum = 0;
            for (let j = i - 6; j <= i + 6; j++) sum += prof[clamp(j, 0, m)];
            next[i] = i <= ia ? sites[r.a].h : i >= ib ? sites[r.b].h : sum / 13;
          }
          const t = prof; prof = next; next = t;
        }
        const fall = 0.075 * len / m;
        for (let i = 1; i <= m; i++) prof[i] = Math.max(prof[i], prof[i - 1] - fall);
        for (let i = m - 1; i >= 0; i--) prof[i] = Math.max(prof[i], prof[i + 1] - fall);
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 0; i <= m; i++) next[i] = i <= ia || i >= ib ? prof[i] : (prof[i - 1] + prof[i] * 2 + prof[i + 1]) / 4;
          const t = prof; prof = next; next = t;
        }
        for (let i = 0; i <= m; i++) {
          const px = a.x + (b.x - a.x) * i / m, py = a.y + (b.y - a.y) * i / m;
          const x0 = Math.max(0, Math.floor((px - reach) / cell)), x1 = Math.min(nx - 1, Math.ceil((px + reach) / cell));
          const z0 = Math.max(0, Math.floor((py - reach) / cell)), z1 = Math.min(nz - 1, Math.ceil((py + reach) / cell));
          for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
            const v = z * nx + x, d = Math.hypot(x * cell - px, z * cell - py);
            if (d < bedD[v]) { bedD[v] = d; bedH[v] = prof[i]; }
          }
        }
      }
      for (let i = 0; i < n; i++) if (land[i] && bedD[i] < reach) height[i] += (bedH[i] - height[i]) * smooth(reach, 8.5, bedD[i]);
    }

    // The land is settled. Cut every cell along its flatter diagonal, so ridges and gullies keep their line,
    // and from here on read heights off those triangles: what stands on the land stands on what is drawn.
    const split = new Uint8Array((nx - 1) * (nz - 1));
    for (let z = 0; z < nz - 1; z++) for (let x = 0; x < nx - 1; x++) {
      const i = z * nx + x;
      split[z * (nx - 1) + x] = Math.abs(height[i] - height[i + nx + 1]) < Math.abs(height[i + 1] - height[i + nx]) ? 1 : 0;
    }
    heightAt = function (x, y) {
      const gx = clamp(x / cell, 0, nx - 1.001), gz = clamp(y / cell, 0, nz - 1.001);
      const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz, i = iz * nx + ix;
      const a = height[i], b = height[i + 1], c = height[i + nx], d = height[i + nx + 1];
      if (split[iz * (nx - 1) + ix]) return fz >= fx ? a + (d - c) * fx + (c - a) * fz : a + (b - a) * fx + (d - b) * fz;
      return fx + fz <= 1 ? a + (b - a) * fx + (c - a) * fz : d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
    };

    const roads = game.roads.map((r) => {
      const a = K[r.a], b = K[r.b], steps = Math.max(2, Math.round(r.len / 6)), pts = [];
      for (let i = 0; i <= steps; i++) {
        const x = a.x + (b.x - a.x) * i / steps, y = a.y + (b.y - a.y) * i / steps;
        pts.push([x, y, Math.max(0.5, heightAt(x, y)) + 0.35]);
      }
      return { a: r.a, b: r.b, pts: pts };
    });

    /** Steepness of the ground at a point: rise over run. */
    function slopeAt(x, y) {
      return Math.hypot(heightAt(x + cell, y) - heightAt(x - cell, y), heightAt(x, y + cell) - heightAt(x, y - cell)) / (2 * cell);
    }
    /** True when (x, y) lies on one of the ways into a town, where a besieging army pitches its camp. */
    function approach(s, x, y) {
      const dx = x - s.x, dy = y - s.y, d = Math.hypot(dx, dy) || 1;
      for (const j of K[s.id].adj) {
        const ex = K[j].x - s.x, ey = K[j].y - s.y;
        if ((dx * ex + dy * ey) / (d * Math.hypot(ex, ey)) > 0.36) return true;
      }
      return false;
    }

    // A patchwork of fields round every town, bigger towns with more of it. Fields come in blocks
    // of long strips, the way a village shares out its ground, with a hedge along some of the edges.
    const fields = [], hedges = [], blocks = [];
    function blockFits(x, y, bw, bd, rot, s) {
      const cx = Math.cos(rot), sx = Math.sin(rot), h0 = heightAt(x, y);
      for (let iu = -2; iu <= 2; iu++) for (let iv = -2; iv <= 2; iv++) {
        const u = iu * bw / 4, v = iv * bd / 4, px = x + cx * u - sx * v, py = y + sx * u + cx * v;
        if (px < 24 || py < 24 || px > W - 24 || py > H - 24 || shoreAt(px, py) > -9) return false;
        survey(px, py);
        if (sv.dr < 7.5 || sv.dk < SITE_R[K[sv.id].tier] + 9) return false;
        if (Math.hypot(px - s.yard[0], py - s.yard[1]) < 27 || Math.abs(heightAt(px, py) - h0) > 1.7) return false;
      }
      // No two blocks overlap: test the corners of each against the other, a little oversize.
      for (const o of blocks) {
        if (Math.hypot(o.x - x, o.y - y) > (o.w + o.d + bw + bd) * 0.75) continue;
        const co = Math.cos(o.rot), so = Math.sin(o.rot);
        for (let iu = -2; iu <= 2; iu++) for (let iv = -2; iv <= 2; iv++) {
          let ex = x + cx * iu * bw / 4 - sx * iv * bd / 4 - o.x, ey = y + sx * iu * bw / 4 + cx * iv * bd / 4 - o.y;
          if (Math.abs(ex * co + ey * so) < o.w / 2 + 2.6 && Math.abs(-ex * so + ey * co) < o.d / 2 + 2.6) return false;
          ex = o.x + co * iu * o.w / 4 - so * iv * o.d / 4 - x; ey = o.y + so * iu * o.w / 4 + co * iv * o.d / 4 - y;
          if (Math.abs(ex * cx + ey * sx) < bw / 2 + 2.6 && Math.abs(-ex * sx + ey * cx) < bd / 2 + 2.6) return false;
        }
      }
      return true;
    }
    for (const s of sites) {
      const want = 3 + K[s.id].tier * 3;
      for (let i = 0, made = 0; i < want * 14 && made < want; i++) {
        const ang = hash(s.id, i, seed + 61) * TAU, dist = s.r + 21 + Math.pow(hash(s.id, i, seed + 63), 1.4) * 60;
        const x = s.x + Math.cos(ang) * dist, y = s.y + Math.sin(ang) * dist;
        const bw = 20 + hash(s.id, i, seed + 65) * 15, bd = 13 + hash(s.id, i, seed + 67) * 12;
        // Fields lie along a road where there is one, and otherwise ring the town.
        survey(x, y);
        const lane = segs[sv.road];
        const rot = sv.dr < 36 ? Math.atan2(lane[3], lane[2]) : ang + Math.PI / 2 + (hash(s.id, i, seed + 69) - 0.5) * 0.5;
        if (!blockFits(x, y, bw, bd, rot, s)) continue;
        blocks.push({ x: x, y: y, w: bw, d: bd, rot: rot });
        made++;
        // Strips across the block, each under its own crop.
        const cx = Math.cos(rot), sx = Math.sin(rot), strips = Math.max(2, Math.round(bd / 6.5)), sd = bd / strips;
        const first = Math.floor(hash(s.id, i, seed + 71) * 3);
        for (let j = 0; j < strips; j++) {
          const v = -bd / 2 + sd * (j + 0.5), fx = x - sx * v, fy = y + cx * v;
          fields.push({ x: fx, y: fy, h: heightAt(fx, fy) + 0.25, w: bw, d: sd, rot: rot, crop: (first + j + (hash(i, j, seed + 73) < 0.3 ? 1 : 0)) % 3, town: s.id });
        }
        // Hedges on most sides of the block, but none where a battle line or a siege camp would stand in them.
        for (let e = 0; e < 4; e++) {
          if (hash(s.id * 4 + e, i, seed + 75) < 0.28) continue;
          const along = e < 2, off = (e % 2 ? 1 : -1) * ((along ? bd : bw) / 2 + 0.7);
          const hx = along ? x - sx * off : x + cx * off, hy = along ? y + cx * off : y + sx * off;
          survey(hx, hy);
          if (sv.dr < 9.5 || (Math.hypot(hx - s.x, hy - s.y) < s.r + 30 && approach(s, hx, hy))) continue;
          hedges.push(hx, hy, heightAt(hx, hy), (along ? bw : bd) + 1.4, along ? rot : rot + Math.PI / 2);
        }
      }
    }
    function inBlock(x, y, pad) {
      for (const o of blocks) {
        const ex = x - o.x, ey = y - o.y;
        if (Math.abs(ex) + Math.abs(ey) > o.w + o.d) continue;
        const co = Math.cos(o.rot), so = Math.sin(o.rot);
        if (Math.abs(ex * co + ey * so) < o.w / 2 + pad && Math.abs(-ex * so + ey * co) < o.d / 2 + pad) return true;
      }
      return false;
    }

    // Woods and rocks, on a jittered grid so they never look planted. Woods thicken away from the roads,
    // turn to pine as the ground climbs, and stop at the tree line; above it there is only rock.
    const trees = [], rocks = [];
    const step = 7.9;
    for (let gy = 0; gy * step < H; gy++) for (let gx = 0; gx * step < W; gx++) {
      const x = (gx + hash(gx, gy, seed + 41)) * step, y = (gy + hash(gx, gy, seed + 43)) * step;
      if (x >= W || y >= H || shoreAt(x, y) > -6) continue;
      survey(x, y);
      const site = sites[sv.id];
      // Clear of the roads (a battle line needs the room), the town, its muster ground and its siege lines.
      if (sv.dr < 14 || sv.dk < site.r + 12 || Math.hypot(x - site.yard[0], y - site.yard[1]) < 28) continue;
      if (sv.dk < site.r + 50 && approach(site, x, y)) continue;
      const h = heightAt(x, y), steep = slopeAt(x, y), wild = smooth(0, 46, wildness()), roll = hash(gx, gy, seed + 47);
      if (h > 43 + noise(x / 40, y / 40, seed + 45) * 12 || steep > 1.05) {
        if (roll < (h > 43 ? 0.2 : 0.1)) rocks.push(x, y, h, 1.3 + hash(gx, gy, seed + 49) * 2.6);
        continue;
      }
      if (h < 1.9 || inBlock(x, y, 3.2)) continue;
      const wood = noise(x / 75 + 11.3, y / 75 + 4.9, seed + 51) + wild * 0.3 + smooth(9, 24, h) * 0.2;
      let chance = wood > 0.55 ? 0.93 : wood > 0.45 ? 0.5 : 0.04 + wild * 0.1;
      if (sv.dr < 21) chance *= 0.45;
      if (steep > 0.75) chance *= 0.5;
      if (roll > chance) {
        if (wild > 0.5 && roll > 0.985) rocks.push(x, y, h, 1 + hash(gx, gy, seed + 49) * 1.6);
        continue;
      }
      const pine = h > 24 + (noise(x / 55, y / 55, seed + 53) - 0.5) * 22 || noise(x / 110 + 3.3, y / 110 + 9.9, seed + 55) > 0.64;
      const size = 0.78 + hash(gx, gy, seed + 57) * 0.62;
      trees.push(x, y, h, size * (h > 36 ? 0.8 : 1), pine ? 0 : 1);
    }

    // Borders: the edges of the towns' provinces (each point of land belongs to its nearest town), walked
    // a few paces at a time and kept only where they run over dry land.
    const borders = [];
    for (let i = 0; i < K.length; i++) for (let j = i + 1; j < K.length; j++) {
      const a = K[i], b = K[j], dl = Math.hypot(b.x - a.x, b.y - a.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, ux = -(b.y - a.y) / dl, uy = (b.x - a.x) / dl;
      // The stretch of the bisector that is nearer to a and b than to any other town, inside the map.
      let t0 = -1e6, t1 = 1e6;
      if (Math.abs(ux) > 1e-9) { const p = -mx / ux, q = (W - mx) / ux; t0 = Math.max(t0, Math.min(p, q)); t1 = Math.min(t1, Math.max(p, q)); }
      if (Math.abs(uy) > 1e-9) { const p = -my / uy, q = (H - my) / uy; t0 = Math.max(t0, Math.min(p, q)); t1 = Math.min(t1, Math.max(p, q)); }
      for (let c = 0; c < K.length && t1 - t0 > 3; c++) {
        if (c === i || c === j) continue;
        const ex = K[c].x - a.x, ey = K[c].y - a.y;
        const rhs = (ex * ex + ey * ey) / 2 - ((mx - a.x) * ex + (my - a.y) * ey), den = ux * ex + uy * ey;
        if (Math.abs(den) < 1e-9) { if (rhs < 0) t1 = t0; } else if (den > 0) t1 = Math.min(t1, rhs / den); else t0 = Math.max(t0, rhs / den);
      }
      if (t1 - t0 <= 3) continue;
      const m = Math.max(1, Math.ceil((t1 - t0) / 3.5));
      const dry = (t) => shoreAt(mx + ux * t, my + uy * t) < -0.6;
      const edge = (wet, ok) => { for (let q = 0; q < 8; q++) { const mid = (wet + ok) / 2; if (dry(mid)) ok = mid; else wet = mid; } return ok; };
      const at = (t) => { const x = mx + ux * t, y = my + uy * t; return [x, y, Math.max(0.4, heightAt(x, y))]; };
      let run = null, was = false, prev = t0;
      for (let q = 0; q <= m; q++) {
        const t = t0 + (t1 - t0) * q / m, ok = dry(t);
        if (ok && !was) { run = [at(q ? edge(prev, t) : t)]; if (q) run.push(at(t)); }
        else if (ok) run.push(at(t));
        else if (was) { run.push(at(edge(t, prev))); if (run.length > 1) borders.push({ a: i, b: j, pts: run }); run = null; }
        was = ok; prev = t;
      }
      if (run && run.length > 1) borders.push({ a: i, b: j, pts: run });
    }

    const peaks = massifs.map((m) => {
      let best = [m.x, m.y, heightAt(m.x, m.y)];
      for (let y = m.y - m.r; y <= m.y + m.r; y += cell) for (let x = m.x - m.r; x <= m.x + m.r; x += cell) {
        const h = heightAt(x, y);
        if (h > best[2]) best = [x, y, h];
      }
      return { x: best[0], y: best[1], h: best[2] };
    });

    return {
      W: W, H: H, cell: cell, nx: nx, nz: nz, height: height, land: land, water: water, province: province, shore: shore,
      fromRoad: fromRoad, split: split, heightAt: heightAt, shoreAt: shoreAt, roads: roads, sites: sites, trees: new Float32Array(trees), fields: fields,
      hedges: new Float32Array(hedges), rocks: new Float32Array(rocks), borders: borders, peaks: peaks,
    };
  }

  return { buildTerrain: buildTerrain, SITE_R: SITE_R };
});
