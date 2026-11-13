/*
 * Borrowed Crown: the lie of the land.
 *
 * Turns the simulation's flat map (towns and the roads between them) into a height field
 * with a coast, hills, forests and farmland. No rendering in here and no DOM, so it runs
 * under Node as well. The simulation never reads any of this: terrain is for the eye.
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

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
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

  /**
   * @param {object} game  a BC.Game (only W, H, seed, keeps and roads are read)
   * @returns {object} terrain:
   *   W, H, cell, nx, nz           grid: nx by nz vertices, `cell` map units apart
   *   height   Float32Array        metres above sea level per vertex; below 0 is sea bed
   *   land     Uint8Array          1 where the vertex is dry land
   *   province Uint8Array          index of the nearest town, i.e. whose land this is
   *   heightAt(x, y)               height at any map point (bilinear)
   *   roads    [{ a, b, pts }]     one per simulation road; pts is [[x, y, h], ...] draped on the ground
   *   sites    [{ id, x, y, h, r, gate: [dx, dy], yard: [x, y] }]   per town: level ground of radius r,
   *                                the way its gate faces, and where its garrison musters
   *   trees    Float32Array        x, y, h, scale, kind (0 conifer, 1 broadleaf), five numbers per tree
   *   fields   [{ x, y, h, w, d, rot, crop }]   farm plots round the towns
   *   rocks    Float32Array        x, y, h, scale, four numbers per rock
   */
  function buildTerrain(game) {
    const W = game.W, H = game.H, K = game.keeps, seed = game.seed | 0;
    const cell = Math.max(6, Math.sqrt(W * H / 26000));
    const nx = Math.ceil(W / cell) + 1, nz = Math.ceil(H / cell) + 1, n = nx * nz;
    const height = new Float32Array(n), land = new Uint8Array(n), province = new Uint8Array(n);
    const segs = game.roads.map((r) => {
      const a = K[r.a], b = K[r.b], dx = b.x - a.x, dy = b.y - a.y;
      return [a.x, a.y, dx, dy, dx * dx + dy * dy];
    });

    // Distance to the nearest town and the nearest road, and whose province a point is in.
    function survey(wx, wy) {
      let dk = 1e12, id = 0;
      for (let k = 0; k < K.length; k++) {
        const dx = K[k].x - wx, dy = K[k].y - wy, d = dx * dx + dy * dy;
        if (d < dk) { dk = d; id = k; }
      }
      let dr = 1e12;
      for (let r = 0; r < segs.length; r++) {
        const s = segs[r];
        const t = clamp(((wx - s[0]) * s[2] + (wy - s[1]) * s[3]) / s[4], 0, 1);
        const ex = s[0] + s[2] * t - wx, ey = s[1] + s[3] * t - wy, d = ex * ex + ey * ey;
        if (d < dr) dr = d;
      }
      return [Math.sqrt(dk), Math.sqrt(dr), id];
    }

    // The coast is the same one the flat map draws: land hugs the towns and the roads.
    function shore(wx, wy, dk, dr) {
      const rim = Math.min(wx, wy, W - wx, H - wy);
      return Math.min(dk - 108, dr - 30)
        + (noise(wx / 150, wy / 150, seed) - 0.5) * 70 + (noise(wx / 50 + 7.3, wy / 50 + 1.9, seed + 11) - 0.5) * 30
        + Math.max(0, 46 - rim) * 2.2;
    }

    function rawHeight(wx, wy) {
      const s = survey(wx, wy), f = shore(wx, wy, s[0], s[1]);
      if (f >= 0) return [-Math.min(14, 1.2 + f * 0.14), s[2], f];
      const inland = clamp(-f / 55, 0, 1);                               // 0 on the beach
      const wild = clamp(Math.min(s[0] - 50, s[1] - 18) / 75, 0, 1);     // 0 on roads and in towns, 1 deep in the hills
      const ridge = noise(wx / 95 + 3.1, wy / 95 + 8.7, seed + 21), rough = noise(wx / 26, wy / 26, seed + 31);
      const h = 1.0 + inland * 5 + wild * wild * (16 + ridge * ridge * 78) * (0.5 + 0.5 * inland) + (rough - 0.5) * 5 * (0.25 + wild);
      return [Math.max(0.6, h), s[2], f];
    }

    for (let z = 0, i = 0; z < nz; z++) for (let x = 0; x < nx; x++, i++) {
      const r = rawHeight(Math.min(W, x * cell), Math.min(H, z * cell));
      height[i] = r[0]; province[i] = r[1]; land[i] = r[2] < 0 ? 1 : 0;
    }

    function heightAt(x, y) {
      const gx = clamp(x / cell, 0, nx - 1.001), gz = clamp(y / cell, 0, nz - 1.001);
      const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz, i = iz * nx + ix;
      const a = height[i], b = height[i + 1], c = height[i + nx], d = height[i + nx + 1];
      return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
    }

    // Level the ground each town stands on.
    const sites = K.map((k) => {
      const r = SITE_R[k.tier];
      const h = Math.max(1.5, heightAt(k.x, k.y));
      const to = K[k.adj[0]];
      const gl = Math.hypot(to.x - k.x, to.y - k.y) || 1, gx = (to.x - k.x) / gl, gy = (to.y - k.y) / gl;
      return { id: k.id, x: k.x, y: k.y, h: h, r: r, gate: [gx, gy], yard: [k.x + gx * (r + 15) - gy * 17, k.y + gy * (r + 15) + gx * 17] };
    });
    for (const s of sites) {
      const reach = s.r * 1.9 + 14;
      const x0 = Math.max(0, Math.floor((s.x - reach) / cell)), x1 = Math.min(nx - 1, Math.ceil((s.x + reach) / cell));
      const z0 = Math.max(0, Math.floor((s.y - reach) / cell)), z1 = Math.min(nz - 1, Math.ceil((s.y + reach) / cell));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const i = z * nx + x;
        if (!land[i]) continue;
        const d = Math.hypot(x * cell - s.x, z * cell - s.y);
        const t = clamp((reach - d) / (reach - s.r), 0, 1), e = t * t * (3 - 2 * t);
        height[i] += (s.h - height[i]) * e;
      }
    }

    // Roads, draped over the ground a pace at a time.
    const roads = game.roads.map((r) => {
      const a = K[r.a], b = K[r.b], steps = Math.max(2, Math.round(r.len / 6)), pts = [];
      for (let i = 0; i <= steps; i++) {
        const x = a.x + (b.x - a.x) * i / steps, y = a.y + (b.y - a.y) * i / steps;
        pts.push([x, y, Math.max(0.5, heightAt(x, y)) + 0.35]);
      }
      return { a: r.a, b: r.b, pts: pts };
    });

    // Woods, on a jittered grid so they never look planted.
    const trees = [], rocks = [];
    const step = 13;
    for (let gy = 0; gy * step < H; gy++) for (let gx = 0; gx * step < W; gx++) {
      const x = (gx + hash(gx, gy, seed + 41)) * step, y = (gy + hash(gx, gy, seed + 43)) * step;
      if (x >= W || y >= H) continue;
      const s = survey(x, y), f = shore(x, y, s[0], s[1]);
      if (f > -7) continue;
      const h = heightAt(x, y), site = sites[s[2]];
      if (s[1] < 9 || s[0] < site.r + 9 || Math.hypot(x - site.yard[0], y - site.yard[1]) < 26) continue;
      if (h > 58) { if (hash(gx, gy, seed + 47) < 0.3) rocks.push(x, y, h, 1.5 + hash(gx, gy, seed + 49) * 3); continue; }
      const wood = noise(x / 70 + 11.3, y / 70 + 4.9, seed + 51);
      if (wood < 0.47 + (h < 6 ? 0.1 : 0)) continue;
      trees.push(x, y, h, 0.8 + hash(gx, gy, seed + 53) * 0.7, h > 26 || hash(gx, gy, seed + 55) < 0.3 ? 0 : 1);
    }

    // A patchwork of fields round every town, bigger towns with more of it.
    const fields = [];
    for (const s of sites) {
      const k = K[s.id], want = 4 + k.tier * 3;
      for (let i = 0, made = 0; i < want * 6 && made < want; i++) {
        const ang = hash(s.id, i, seed + 61) * Math.PI * 2, dist = s.r + 16 + hash(s.id, i, seed + 63) * 52;
        const x = s.x + Math.cos(ang) * dist, y = s.y + Math.sin(ang) * dist;
        if (x < 20 || y < 20 || x > W - 20 || y > H - 20) continue;
        const v = survey(x, y);
        if (shore(x, y, v[0], v[1]) > -16 || v[1] < 11 || Math.hypot(x - s.yard[0], y - s.yard[1]) < 30) continue;
        const h = heightAt(x, y);
        if (Math.abs(h - s.h) > 5) continue;
        const w = 15 + hash(s.id, i, seed + 65) * 13, d = 10 + hash(s.id, i, seed + 67) * 9;
        if (fields.some((o) => Math.hypot(o.x - x, o.y - y) < (o.w + w) * 0.62)) continue;
        fields.push({ x: x, y: y, h: h + 0.25, w: w, d: d, rot: ang + Math.PI / 2 + (hash(s.id, i, seed + 69) - 0.5) * 0.5, crop: Math.floor(hash(s.id, i, seed + 71) * 3) });
        made++;
      }
    }

    return {
      W: W, H: H, cell: cell, nx: nx, nz: nz, height: height, land: land, province: province, heightAt: heightAt,
      roads: roads, sites: sites, trees: new Float32Array(trees), fields: fields, rocks: new Float32Array(rocks),
    };
  }

  return { buildTerrain: buildTerrain, SITE_R: SITE_R };
});
