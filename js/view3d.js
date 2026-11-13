/*
 * Borrowed Crown: the 3D view.
 *
 * Owns the WebGL renderer, the camera, and a 2D canvas laid over the scene for everything
 * that has to stay crisp: names, head counts, granary bars, rings on the ground, order
 * previews. It offers the same surface as the flat map (BC.Renderer) so the page can drive
 * either one.
 *
 * The camera is a rig (a point on the ground, a distance, a yaw and a pitch) that eases
 * toward a goal. It is kept over the island, above the ground and clear of the hills, and
 * it tilts lower as it comes closer. The overlay keeps one small record per town and per
 * army and reuses it every frame, so drawing the labels allocates nothing.
 *
 * Needs THREE (three.js r149) plus BC.buildTerrain, BC.Scenery, BC.Towns and BC.Units.
 * Map (x, y) with height h sits at scene (x, h, y).
 */
(function () {
  'use strict';
  const BC = (window.BC = window.BC || {});
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  const NEAR = 95;                       // the closest the camera comes to the point it looks at
  const PITCH_MAX = 1.42;                // almost straight down
  const CLEAR = 12;                      // the least height of the camera above the ground under it
  const SIGHT = [0, 0.05, 0.1, 0.16, 0.23, 0.31, 0.4, 0.5, 0.6];      // where along its line of sight the camera must clear the hills
  const FLAG_H = [0, 3.2, 5.2, 6.5];     // height of a village, town and city banner (they are drawn larger from afar)
  const TOP = [0, 12.6, 21, 26.5];       // height of the highest banner, if the towns module does not say
  const N_RING = 48;                     // points in a ring drawn on the ground
  const COS = new Float32Array(N_RING + 1), SIN = new Float32Array(N_RING + 1);
  for (let i = 0; i <= N_RING; i++) { COS[i] = Math.cos(i / N_RING * TAU - Math.PI / 2); SIN[i] = Math.sin(i / N_RING * TAU - Math.PI / 2); }

  function rgb(hex) {
    hex = hex.trim().replace('#', '');
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const n = parseInt(hex.slice(0, 6), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const solid = (c) => 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
  const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  const fmt = (n) => (n >= 10000 ? Math.round(n / 1000) + 'k' : String(n));
  /** The number in a selection key such as 'k12', read without making a new string. */
  function keyId(key) {
    let id = 0;
    for (let i = 1; i < key.length; i++) id = id * 10 + key.charCodeAt(i) - 48;
    return id;
  }

  /** A lozenge, begun at the middle of its top edge and drawn clockwise. */
  function pill(ctx, x, y, w, h) {
    const r = Math.min(h, w) / 2;
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w - r, y);
    ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(x + r, y + h);
    ctx.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
    ctx.closePath();
  }
  /** A swallow-tailed pennant: what a column on the march carries. */
  function pennant(ctx, x, y, w, h, tail) {
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + w + tail, y); ctx.lineTo(x + w, y + h / 2); ctx.lineTo(x + w + tail, y + h); ctx.lineTo(x, y + h);
    ctx.closePath();
  }

  class View3D {
    /** True when three.js loaded and this browser will give us a WebGL context. */
    static supported() {
      if (typeof THREE === 'undefined') return false;
      try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
    }

    constructor(glCanvas, hudCanvas) {
      this.is3d = true;
      this.gl = glCanvas; this.canvas = hudCanvas; this.ctx = hudCanvas.getContext('2d');
      this.renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, powerPreference: 'high-performance' });
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(34, 1, 4, 9000);
      this.w = 1; this.h = 1; this.dpr = 1; this.u = 1; this.s = 1; this.focal = 1;
      this.pad = { t: 4, r: 4, b: 4, l: 4 };
      this.game = null; this.land = null; this.t = 0; this.frame = 0;
      this.sel = new Set();        // 'k<id>' towns, 'c<id>' camps, 'a<id>' columns on the march
      this.hover = null; this.aim = null; this.box = null; this.pull = null; this.quietMap = false;
      this.floats = []; this.rings = []; this.marks = [];
      this.cam = { x: 0, y: 0, dist: 1200, yaw: 0, pitch: 0.93 };      // what the camera is doing now
      this.goal = { x: 0, y: 0, dist: 1200, yaw: 0, pitch: 0.93 };     // where it is easing to
      this.rest = { x: 0, y: 0, dist: 1200, yaw: 0, pitch: 0.93 };     // the pose that frames the whole realm
      this.far = 2000;                                                  // the distance that frames the whole realm
      this.zoom = 0;                                                    // 0 with the whole realm in view, 1 as close as it goes
      this.v = new THREE.Vector3(); this.vp = new THREE.Matrix4();
      this.px = 0; this.py = 0; this.pw = 0; this.gx = 0; this.gy = 0; this.cx = 0; this.cy = 0;
      this.anchor = { on: false, px: 0, py: 0, x: 0, y: 0 };            // the ground a zoom is holding under the pointer
      this.heads = new Float32Array(3 * 16);
      this.isle = { x0: 0, y0: 0, x1: 1, y1: 1, pts: [] }; this.maxH = 120;
      this.tl = []; this.al = new Map(); this.bl = new Map(); this.order = [];
      this.rx = new Float32Array(4 * 256); this.nr = 0;                 // rectangles already taken by labels this frame
      this.path = new Float32Array(3 * 512); this.ends = new Int32Array(64); this.np = 0; this.aimSeen = null; this.aimOk = false; this.aimW = 0;
      this.fonts = new Map(); this.fam = 'sans-serif'; this.rankKey = -1;
      const mm = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
      this.calm = mm('(prefers-reduced-motion: reduce)');
      this.coarse = mm('(pointer: coarse)');
      // Losing the WebGL context (a phone put to sleep, a driver reset) must not stop the game: three.js
      // rebuilds what it needs when the context comes back, and until then the labels stay up.
      this.lost = false;
      this.glr = 1; this.cap = 2; this.clock = 0; this.slow = 16; this.slowFor = 0;      // the scene's pixel ratio, and the watch kept on the frame time
      glCanvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; }, false);
      glCanvas.addEventListener('webglcontextrestored', () => { this.lost = false; this.readTheme(); this.resize(); }, false);
      this.drawSel = (key) => this.selRing(key);
      this.reap = (r, id, map) => { if (r.seen < this.frame - 1) map.delete(id); };
      this.byRank = (a, b) => this.weight(b) - this.weight(a);
      this.readTheme();
    }

    /* ----- setup ----- */

    readTheme() {
      const cs = getComputedStyle(document.documentElement);
      const v = (name) => rgb(cs.getPropertyValue(name) || '#888888');
      const th = {
        sea: v('--sea'), outline: v('--outline'), free: v('--free'), grain: v('--grain'),
        f: [0, 1, 2, 3, 4, 5, 6].map((i) => v('--f' + i)),
        paper: v('--paper'), text: v('--text'), muted: v('--muted'),
        brass: v('--brass'), bad: v('--bad'), good: v('--good'), omen: v('--omen'),
      };
      th.dark = lum(th.paper) < 0.4;
      const fam = (cs.getPropertyValue('--body') || 'sans-serif').trim();
      th.font = (w, px) => w + ' ' + px.toFixed(1) + 'px ' + fam;
      this.theme = th;
      // The overlay paints with these every frame, so they are made once here and not per label.
      const on = (c) => (lum(c) > 0.42 ? solid(th.outline) : '#ffffff');
      this.ink = {
        f: th.f.map(solid), on: th.f.map(on), free: solid(th.free), onFree: on(th.free),
        outline: solid(th.outline), paper: solid(th.paper), text: solid(th.text), muted: solid(th.muted),
        brass: solid(th.brass), bad: solid(th.bad), good: solid(th.good), omen: solid(th.omen), grain: solid(th.grain),
      };
      this.fam = fam; this.fonts.clear();
      for (const r of this.tl) { r.fk = 0; r.nfk = 0; }
      this.al.clear(); this.bl.clear(); this.aimSeen = null;
      for (const r of this.rings) r.nw = 0;
      if (this.scenery) { this.scenery.setTheme(th); this.towns.setTheme(th); this.units.setTheme(th); }
    }

    /** A canvas font string, made once for each weight and size. */
    font(weight, px) {
      const key = weight * 4096 + Math.round(px * 4);
      let f = this.fonts.get(key);
      if (!f) { f = weight + ' ' + (Math.round(px * 4) / 4) + 'px ' + this.fam; this.fonts.set(key, f); }
      return f;
    }

    setGame(game) {
      if (this.scenery) { this.scenery.dispose(); this.towns.dispose(); this.units.dispose(); }
      this.game = game;
      this.hover = null; this.aim = null; this.box = null; this.pull = null;
      this.floats.length = this.rings.length = this.marks.length = 0;
      this.land = BC.buildTerrain(game);
      this.scenery = new BC.Scenery(THREE, this.scene, game, this.land);
      this.towns = new BC.Towns(THREE, this.scene, game, this.land);
      this.units = new BC.Units(THREE, this.scene, game, this.land);
      this.scenery.setTheme(this.theme); this.towns.setTheme(this.theme); this.units.setTheme(this.theme);
      this.survey();
      this.home(true);
    }

    /** Things worked out once per map: the shape of the island, the roads by their ends, a label record per town. */
    survey() {
      const g = this.game, L = this.land, isle = this.isle;
      const dirs = 20, best = new Float32Array(dirs).fill(-1e9), pts = [];
      for (let d = 0; d < dirs; d++) pts.push([g.W / 2, g.H / 2, 0]);
      isle.x0 = isle.y0 = 1e9; isle.x1 = isle.y1 = -1e9;
      for (let iz = 0; iz < L.nz; iz++) for (let ix = 0; ix < L.nx; ix++) {
        if (!L.land[iz * L.nx + ix]) continue;
        const x = Math.min(g.W, ix * L.cell), y = Math.min(g.H, iz * L.cell);
        if (x < isle.x0) isle.x0 = x; if (x > isle.x1) isle.x1 = x;
        if (y < isle.y0) isle.y0 = y; if (y > isle.y1) isle.y1 = y;
        for (let d = 0; d < dirs; d++) {
          const dot = x * COS[d * 2] + y * SIN[d * 2];        // 20 of the ring's 48 directions are plenty
          if (dot > best[d]) { best[d] = dot; pts[d][0] = x; pts[d][1] = y; }
        }
      }
      if (isle.x1 < isle.x0) { isle.x0 = 0; isle.y0 = 0; isle.x1 = g.W; isle.y1 = g.H; }
      this.maxH = 30;
      for (const p of L.peaks || []) { pts.push([p.x, p.y, p.h]); this.maxH = Math.max(this.maxH, p.h); }
      this.maxH += 8;
      isle.pts = pts;

      const n = g.keeps.length;
      this.roadOf = new Int16Array(n * n);                     // road index + 1 from a to b, negative when it runs b to a
      L.roads.forEach((r, i) => { this.roadOf[r.a * n + r.b] = i + 1; this.roadOf[r.b * n + r.a] = -(i + 1); });
      this.tl = g.keeps.map((k) => {
        const s = this.towns && this.towns.site && this.towns.site(k.id);
        return { key: 'k' + k.id, top: s && s.top ? s.top : TOP[k.tier], on: false, ax: 0, ay: 0, x0: 0, y0: 0, w: 0, h: 0, px: 10, men: -1, txt: '', tw: 0, fk: 0, nw: 0, nfk: 0, npx: 10, nameOn: false, na: 0, ny: 0, stack: 0 };
      });
      this.order = g.keeps.map((k) => k.id);
      this.rankKey = -1;
      this.al.clear(); this.bl.clear();
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
      const dev = window.devicePixelRatio || 1, area = this.w * this.h;
      // The overlay is cheap and text wants to be sharp, so it follows the screen up to 3x. The scene is what costs:
      // it gets a budget of pixels, tighter on phones and tablets, and is never drawn above 2x.
      this.dpr = Math.min(dev, 3, Math.max(1, Math.sqrt(3.6e6 / area)));
      this.glr = Math.min(dev, this.cap, Math.max(1, Math.sqrt((this.coarse ? 1.9e6 : 4.2e6) / area)));
      this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr);
      this.renderer.setPixelRatio(this.glr);
      this.renderer.setSize(this.w, this.h, false);
      this.camera.aspect = this.w / this.h;
      this.camera.updateProjectionMatrix();
      this.focal = this.camera.projectionMatrix.elements[5] * this.h / 2;
      this.u = clamp(Math.min(this.w, this.h) / 620, this.coarse ? 1 : 0.92, 1.15);
      if (this.game) this.home(false, true);
    }

    layout() { /* the flat map lays itself out here; the camera does that job for us */ }

    /* ----- camera ----- */

    /** Put the camera where a rig says: never under the ground, never with a hill between it and what it looks at. */
    place(c) {
      const L = this.land, cam = this.camera;
      const ty = L ? Math.max(1, L.heightAt(c.x, c.y)) * 0.5 + 2 : 2;
      const cp = Math.cos(c.pitch), ox = c.dist * cp * Math.sin(c.yaw), oz = c.dist * cp * Math.cos(c.yaw);
      let y = ty + c.dist * Math.sin(c.pitch);
      if (L && y < this.maxH + CLEAR + 60) {
        // A point a share f of the way down the line of sight must be clear of the ground by CLEAR * (1 - f).
        for (let i = 0; i < SIGHT.length; i++) {
          const f = SIGHT[i], need = (Math.max(0, L.heightAt(c.x + ox * (1 - f), c.y + oz * (1 - f))) + CLEAR * (1 - f) - ty * f) / (1 - f);
          if (need > y) y = need;
        }
      }
      cam.position.set(c.x + ox, y, c.y + oz);
      cam.lookAt(c.x, ty, c.y);
      cam.updateMatrixWorld();
      this.vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    }

    /** Scene point to screen pixels, left in this.px and this.py; this.pw is its depth (not in front if below 4). */
    proj(x, h, y) {
      const e = this.vp.elements, w = e[3] * x + e[7] * h + e[11] * y + e[15], k = w > 1e-6 || w < -1e-6 ? 1 / w : 1e6;
      this.px = ((e[0] * x + e[4] * h + e[8] * y + e[12]) * k * 0.5 + 0.5) * this.w;
      this.py = (-(e[1] * x + e[5] * h + e[9] * y + e[13]) * k * 0.5 + 0.5) * this.h;
      this.pw = w;
    }

    /** The pitch the camera takes of its own accord at a distance: lower, and more dramatic, close in. */
    tilt(dist) {
      const t = clamp(Math.log(dist / NEAR) / Math.log(Math.max(1.5, this.far / NEAR)), 0, 1);
      return 0.56 + (this.rest.pitch - 0.56) * t;
    }
    /** How low the camera may be swung at a distance: close to the horizon only when close to the ground. */
    pitchMin(dist) { return 0.3 + 0.3 * clamp((dist - 150) / Math.max(1, this.far * 0.8 - 150), 0, 1); }

    /** Frame the whole realm. `snap` jumps there; `keep` only refreshes the far limit (after a resize). */
    home(snap, keep) {
      const g = this.game, p = this.pad, isle = this.isle;
      if (!g) return;
      this.anchor.on = false;
      // Room for the labels that stand over the northern towns, and a little air all round.
      const x0 = p.l + 18, x1 = this.w - p.r - 18, y0 = p.t + 40, y1 = this.h - p.b - 16;
      const tall = (isle.y1 - isle.y0) > (isle.x1 - isle.x0) * 1.15;
      const c = { x: (isle.x0 + isle.x1) / 2, y: (isle.y0 + isle.y1) / 2, dist: 1200, yaw: 0, pitch: tall ? 1.02 : 0.93 };
      let bx0 = 0, bx1 = 0, by0 = 0, by1 = 0;
      const span = (dist) => {
        c.dist = dist; this.place(c);
        bx0 = by0 = 1e9; bx1 = by1 = -1e9;
        for (const q of isle.pts) {
          this.proj(q[0], q[2], q[1]);
          if (this.px < bx0) bx0 = this.px; if (this.px > bx1) bx1 = this.px;
          if (this.py < by0) by0 = this.py; if (this.py > by1) by1 = this.py;
        }
      };
      // Find the closest distance at which the island is no bigger than the room for it, slide the
      // look-at point until the island sits in the middle of that room, and do both again until it settles.
      let hi = 2000;
      for (let round = 0; round < 4; round++) {
        let lo = 150; hi = 9000;
        for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; span(mid); if (bx1 - bx0 <= x1 - x0 && by1 - by0 <= y1 - y0) hi = mid; else lo = mid; }
        span(hi);
        const per = 2 * hi * Math.tan(this.camera.fov * Math.PI / 360) / this.h;
        c.x += ((bx0 + bx1) / 2 - (x0 + x1) / 2) * per;
        c.y += ((by0 + by1) / 2 - (y0 + y1) / 2) * per / Math.sin(c.pitch);
      }
      c.dist = hi;
      const wasHome = Math.abs(this.goal.x - this.rest.x) + Math.abs(this.goal.y - this.rest.y) < 2 && Math.abs(this.goal.dist - this.rest.dist) < 2;
      this.far = hi;
      Object.assign(this.rest, c);
      if (!keep || wasHome) {
        const yaw = keep ? this.goal.yaw : 0;
        Object.assign(this.goal, c); this.goal.yaw = yaw;
        // Come back round the short way.
        this.cam.yaw -= Math.round((this.cam.yaw - yaw) / TAU) * TAU;
        if (snap) Object.assign(this.cam, this.goal);
      } else { this.goal.dist = Math.min(this.goal.dist, this.far * 1.12); this.bound(this.goal.x, this.goal.y); }
      this.place(this.cam);
    }

    /** Drag the ground by a number of screen pixels. */
    pan(dx, dy) {
      const c = this.goal, per = 2 * c.dist * Math.tan(this.camera.fov * Math.PI / 360) / this.h;
      const rx = Math.cos(c.yaw), ry = -Math.sin(c.yaw), fx = -Math.sin(c.yaw), fy = -Math.cos(c.yaw);
      const deep = per / Math.max(0.3, Math.sin(c.pitch));
      const ox = c.x, oy = c.y;
      this.anchor.on = false;
      c.x -= rx * dx * per; c.y -= ry * dx * per;
      c.x -= fx * dy * deep; c.y -= fy * dy * deep;
      this.bound(ox, oy);
    }

    /** Zoom by `factor` (below 1 is closer), keeping the ground under (px, py) where it is. */
    zoomAt(px, py, factor) {
      const c = this.goal, before = c.dist, to = clamp(before * factor, NEAR, this.far * 1.12);
      if (Math.abs(to - before) < 1e-3) return;
      // Work on the pose the camera is easing to, not the one on screen: that is the one this zoom changes.
      this.place(c);
      const held = this.groundPt(px, py), hx = this.gx, hy = this.gy, ox = c.x, oy = c.y;
      c.dist = to;
      c.pitch = clamp(c.pitch + this.tilt(to) - this.tilt(before), this.pitchMin(to), PITCH_MAX);
      if (held) {
        // Slide until the same piece of ground is under the pointer again. Twice, because the land is not flat.
        for (let i = 0; i < 2; i++) { this.place(c); if (!this.groundPt(px, py)) break; c.x += hx - this.gx; c.y += hy - this.gy; }
      }
      const wx = c.x, wy = c.y, a = this.anchor;
      if (to < before) this.bound(ox, oy); else this.bound();
      // The camera eases to that pose, and on the way it holds the same ground under the pointer too
      // (unless the edge of the island got in the way, when it just eases).
      a.on = held && Math.abs(c.x - wx) + Math.abs(c.y - wy) < 0.5;
      a.px = px; a.py = py; a.x = hx; a.y = hy;
      this.place(this.cam);
    }

    /** Swing the camera round the point it is looking at. */
    orbit(dyaw, dpitch) {
      this.anchor.on = false;
      this.goal.yaw += dyaw;
      this.goal.pitch = clamp(this.goal.pitch + dpitch, this.pitchMin(this.goal.dist), PITCH_MAX);
    }

    /** Look at a map point. It may be any point on the island, whatever the zoom. */
    focus(x, y) {
      const isle = this.isle, c = this.goal;
      this.anchor.on = false;
      c.x = clamp(x, isle.x0, isle.x1); c.y = clamp(y, isle.y0, isle.y1);
    }

    /**
     * Look at a thing: { type: 'keep' | 'camp' | 'army', id }, or a selection key such as 'k3'.
     * `dist` (optional) also sets how close. Returns false if there is no such thing.
     */
    focusOn(what, dist) {
      const g = this.game;
      if (!g || !what) return false;
      const kind = typeof what === 'string' ? what[0] : what.type === 'keep' ? 'k' : what.type === 'camp' ? 'c' : 'a';
      const id = typeof what === 'string' ? keyId(what) : what.id;
      if (kind === 'k') { const k = g.keeps[id]; if (!k) return false; this.focus(k.x, k.y); }
      else {
        const a = g.armies.find((x) => x.id === id);
        if (!a) return false;
        if (kind === 'c' && a.at >= 0 && g.keeps[a.at]) { this.spot(a); this.focus(this.cx, this.cy); } else this.focus(a.x, a.y);
      }
      if (dist) { this.goal.dist = clamp(dist, NEAR, this.far * 1.12); this.goal.pitch = clamp(this.goal.pitch, this.pitchMin(this.goal.dist), PITCH_MAX); }
      return true;
    }

    /**
     * Keep the look-at point over the island. Close in it may go anywhere on it; far out it is drawn in to
     * the middle, so that zooming right out always ends on the whole realm. Given where the point was before
     * a move (`ox`, `oy`), it is only stopped from going further out and never pulled back: that is for
     * dragging and for zooming in, which must not fight the hand.
     */
    bound(ox, oy) {
      const c = this.goal, isle = this.isle, rest = this.rest;
      const out = clamp(c.dist / this.far, 0, 1), room = clamp(1.4 - 1.36 * out, 0.04, 1);
      const mx = (isle.x0 + isle.x1) / 2 + (rest.x - (isle.x0 + isle.x1) / 2) * out, my = (isle.y0 + isle.y1) / 2 + (rest.y - (isle.y0 + isle.y1) / 2) * out;
      const hx = (isle.x1 - isle.x0) / 2 * room, hy = (isle.y1 - isle.y0) / 2 * room;
      let x0 = mx - hx, x1 = mx + hx, y0 = my - hy, y1 = my + hy;
      if (ox !== undefined) { x0 = Math.min(x0, ox); x1 = Math.max(x1, ox); y0 = Math.min(y0, oy); y1 = Math.max(y1, oy); }
      c.x = clamp(c.x, x0, x1); c.y = clamp(c.y, y0, y1);
      c.pitch = clamp(c.pitch, this.pitchMin(c.dist), PITCH_MAX);
    }

    /* ----- where things are ----- */

    /** Map point to screen pixels. `lift` raises it above the ground. Returns [px, py, inFront]. */
    at(x, y, lift) {
      const h = this.land ? Math.max(0, this.land.heightAt(x, y)) : 0;
      this.proj(x, h + (lift || 0), y);
      return [this.px, this.py, this.pw > 4];
    }

    /** Screen pixels to the map point on the ground under them, or null if the ray misses. */
    ground(px, py) { return this.groundPt(px, py) ? [this.gx, this.gy] : null; }

    /** The same, left in this.gx and this.gy. Walks the ray down onto the real ground, hills and all. */
    groundPt(px, py) {
      const cam = this.camera, o = cam.position, v = this.v, L = this.land;
      v.set((px / this.w) * 2 - 1, -(py / this.h) * 2 + 1, 0.5).unproject(cam).sub(o).normalize();
      if (v.y > -0.02) return false;                               // at or above the horizon
      const hgt = (t) => o.y + v.y * t - (L ? Math.max(0, L.heightAt(o.x + v.x * t, o.z + v.z * t)) : 2);
      let t = o.y > this.maxH ? (this.maxH - o.y) / v.y : 0, last = t;
      for (let i = 0; i < 48; i++) {
        const gap = hgt(t);
        if (gap < 0.05) {
          if (gap < -0.4) {                                        // stepped through a slope: close in on where
            let a = last, b = t;
            for (let j = 0; j < 8; j++) { const m = (a + b) / 2; if (hgt(m) < 0) b = m; else a = m; }
            t = (a + b) / 2;
          }
          break;
        }
        last = t; t += clamp(gap / -v.y * 0.8, 0.4, 60);
      }
      this.gx = o.x + v.x * t; this.gy = o.z + v.z * t;
      return true;
    }

    /** Where a siege camp stands on the map: outside the walls, on the side it marched in from. Left in this.cx, this.cy. */
    spot(c) {
      const site = this.land.sites[c.at], ang = Math.atan2(c.y - site.y, c.x - site.x), r = site.r + 20;
      this.cx = site.x + Math.cos(ang) * r; this.cy = site.y + Math.sin(ang) * r;
    }
    campSpot(c) { this.spot(c); return [this.cx, this.cy]; }
    campAt(c) { this.spot(c); return this.at(this.cx, this.cy, 3); }
    armyAt(a) { return this.at(a.x, a.y, 3); }
    /** Where a town's plate hangs: over its highest banner. */
    townAt(k) { const r = this.tl[k.id]; return this.at(k.x, k.y, (r ? r.top : TOP[k.tier]) + 5); }

    /** How many screen pixels one map unit covers at a map point. */
    scaleAt(x, y) {
      this.proj(x, this.land ? Math.max(0, this.land.heightAt(x, y)) : 0, y);
      return this.pw > 1 ? this.focal / this.pw : 0;
    }

    isCamp(a) { return a.state === 'camp' || (a.state === 'fight' && a.was === 'camp'); }

    /**
     * What is under a screen point: { type: 'camp' | 'army' | 'keep', id } or null.
     * Everything is scored by how far the point is from it, as a share of its reach, and the lowest
     * score wins: a plate counts as its own rectangle, men and towns as the ground they stand on.
     */
    pick(px, py) {
      const g = this.game, L = this.land;
      if (!g || !L) return null;
      const u = this.u, slop = (this.coarse ? 15 : 8) * u, fresh = this.frame;
      const e = this.camera.matrixWorld.elements, sinp = clamp(e[9], 0.25, 1), cosp = Math.sqrt(1 - sinp * sinp);
      let type = null, id = -1, bd = 1;
      for (const a of g.armies) {
        if (a.men < 1) continue;
        const camp = this.isCamp(a);
        let x = a.x, y = a.y;
        if (camp) { this.spot(a); x = this.cx; y = this.cy; }
        this.proj(x, Math.max(0, L.heightAt(x, y)) + 2, y);
        if (this.pw <= 4) continue;
        const sc = this.focal / this.pw, hx = this.px, hy = this.py;
        const reach = Math.max((this.coarse ? 22 : 15) * u, (camp ? 15 : 7) * sc) + slop;
        let d = Math.hypot(hx - px, hy - py);
        if (!camp && a.state === 'march' && a.path && a.path[a.i + 1] !== undefined) {
          // A column is strung out behind its head: the men a little way back count too.
          const from = g.keeps[a.path[a.i]], to = g.keeps[a.path[a.i + 1]], len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
          const back = Math.min(a.d || 0, clamp(a.men / 18, 4, 34));
          const tx = a.x - (to.x - from.x) / len * back, ty = a.y - (to.y - from.y) / len * back;
          this.proj(tx, Math.max(0, L.heightAt(tx, ty)) + 2, ty);
          if (this.pw > 4) {
            const sx = this.px - hx, sy = this.py - hy, l2 = sx * sx + sy * sy;
            const f = l2 > 0 ? clamp(((px - hx) * sx + (py - hy) * sy) / l2, 0, 1) : 0;
            d = Math.min(d, Math.hypot(hx + sx * f - px, hy + sy * f - py));
          }
        }
        let score = d / reach;
        const r = this.al.get(a.id);
        if (r && r.on && r.seen === fresh) score = Math.min(score, this.plateScore(px, py, r.x0, r.y0, r.x0 + r.w, r.y0 + r.h + 4 * u, slop));
        if (score < bd) { bd = score; type = camp ? 'camp' : 'army'; id = a.id; }
      }
      for (const k of g.keeps) {
        const s = L.sites[k.id], r = this.tl[k.id], top = r ? r.top : TOP[k.tier];
        this.proj(k.x, s.h + top * 0.35, k.y);
        if (this.pw <= 4) continue;
        const sc = this.focal / this.pw, least = (this.coarse ? 25 : 19) * u;
        const rx = Math.max(least, s.r * sc) + slop, ry = Math.max(least, s.r * sc * sinp + top * 0.5 * sc * cosp) + slop;
        let score = Math.hypot((this.px - px) / rx, (this.py - py) / ry);
        if (r && r.on && r.seen === fresh) score = Math.min(score, this.plateScore(px, py, r.x0, r.nameOn ? r.ny : r.y0, r.x0 + r.w, r.ay, slop));
        if (score < bd) { bd = score; type = 'keep'; id = k.id; }
      }
      return type ? { type: type, id: id } : null;
    }

    /** A plate's score for pick(): next to nothing inside it, rising to 1 at `slop` pixels outside. */
    plateScore(px, py, x0, y0, x1, y1, slop) {
      const dx = Math.max(x0 - px, 0, px - x1), dy = Math.max(y0 - py, 0, py - y1), out = Math.hypot(dx, dy);
      if (out > 0) return 0.35 + 0.65 * out / slop;
      return 0.1 * Math.min(1, Math.hypot(px - (x0 + x1) / 2, py - (y0 + y1) / 2) / (Math.hypot(x1 - x0, y1 - y0) / 2 + 1));
    }

    /* ----- effects fed by the simulation ----- */

    tone(name) {
      const ink = this.ink;
      return name === 'good' ? ink.good : name === 'bad' ? ink.bad : name === 'crown' ? ink.brass : name === 'omen' ? ink.omen : ink.text;
    }

    ping(id, tone) {
      const k = this.game.keeps[id];
      if (!k) return;
      // The ring closes on the town in a second or so; the arrow at the edge of the screen stays longer,
      // so that news of a town that is out of view can still be followed.
      this.rings.push({ x: k.x, y: k.y, h: this.land.sites[id].h + 0.6, life: 1.3, max: 1.3, big: true, hold: 7, c: this.tone(tone), name: k.name, nw: 0 });
    }

    ingest(list) {
      const g = this.game, ink = this.ink, L = this.land;
      for (const e of list) {
        if (e.type === 'take') {
          const k = g.keeps[e.k];
          this.rings.push({ x: k.x, y: k.y, h: L.sites[e.k].h + 0.6, life: 0.8, max: 0.8, big: false, hold: 0, c: e.owner < 0 ? ink.free : ink.f[g.factions[e.owner].color], name: '', nw: 0 });
        } else if (e.type === 'revolt') {
          const k = g.keeps[e.k];
          this.rings.push({ x: k.x, y: k.y, h: L.sites[e.k].h + 0.6, life: 0.9, max: 0.9, big: false, hold: 0, c: ink.bad, name: '', nw: 0 });
        } else if (e.type === 'float') this.floats.push({ x: e.x, y: e.y, text: e.text, tone: e.tone, life: 2.8, max: 2.8 });
      }
      if (this.units) this.units.ingest(list);
    }

    /* ----- the frame ----- */

    draw(dt) {
      const g = this.game;
      if (!g) return;
      this.t += dt;
      // A device that cannot keep up at this sharpness gets a softer scene and a steadier game. It steps down
      // only after seconds of slow frames, never below 1x, and the labels stay as sharp as they were.
      const now = performance.now(), gap = now - this.clock;
      this.clock = now;
      if (gap > 0 && gap < 250 && this.glr > 1) {
        this.slow += (gap - this.slow) * 0.05;
        if (this.slow < 42) this.slowFor = 0;
        else if (++this.slowFor > 100) {
          this.cap = this.glr = Math.max(1, this.glr - 0.5);
          this.renderer.setPixelRatio(this.glr);
          this.slowFor = 0; this.slow = 16;
        }
      }
      // The page gives an order preview as screen points. Turn it into a path on the map now, while
      // the camera is still where the page saw it, so the line can follow the road as the camera moves.
      if (this.aim !== this.aimSeen) this.readAim();
      const k = this.calm ? 1 : 1 - Math.exp(-dt * 9), c = this.cam, to = this.goal;
      c.x += (to.x - c.x) * k; c.y += (to.y - c.y) * k; c.dist += (to.dist - c.dist) * k;
      c.yaw += (to.yaw - c.yaw) * k; c.pitch += (to.pitch - c.pitch) * k;
      const a = this.anchor;
      if (a.on) {
        for (let i = 0; i < 2; i++) { this.place(c); if (!this.groundPt(a.px, a.py)) break; c.x += a.x - this.gx; c.y += a.y - this.gy; }
        if (Math.abs(c.dist - to.dist) < to.dist * 0.003 && Math.abs(c.pitch - to.pitch) < 0.003) a.on = false;
      }
      this.place(c);
      this.scenery.update(dt, g, this.t, this);
      this.towns.update(dt, g, this.t, this);
      this.units.update(dt, g, this.t, this);
      if (!this.lost) this.renderer.render(this.scene, this.camera);
      this.overlay(dt);
    }

    /* ----- the overlay: laying the labels out ----- */

    /** Is this rectangle clear of every label placed so far? Returns the index of the first one in the way, or -1. */
    hit(x0, y0, x1, y1) {
      const rx = this.rx;
      for (let i = 0, n = this.nr * 4; i < n; i += 4) if (x0 < rx[i + 2] && x1 > rx[i] && y0 < rx[i + 3] && y1 > rx[i + 1]) return i;
      return -1;
    }
    take(x0, y0, x1, y1) {
      if (this.nr >= 256) return;
      const rx = this.rx, i = this.nr++ * 4;
      rx[i] = x0; rx[i + 1] = y0; rx[i + 2] = x1; rx[i + 3] = y1;
    }

    /** Set a record's head count and measure it, only when the number or the size of the type has changed. */
    count(r, men, px) {
      men = Math.floor(men);
      if (men !== r.men) { r.men = men; r.txt = fmt(men); r.fk = 0; }
      const fk = Math.round(px * 4);
      if (fk !== r.fk) { this.ctx.font = this.font(700, px); r.tw = this.ctx.measureText(r.txt).width; r.fk = fk; }
    }

    layTowns() {
      const g = this.game, L = this.land, u = this.u, cp = this.camera.position, bar = 5.2 * u, notch = 5 * u;
      for (const k of g.keeps) {
        const r = this.tl[k.id], s = L.sites[k.id];
        // Banners are drawn up to five times larger from far off: hang the plate above the cloth, not on it.
        const grow = clamp(Math.hypot(cp.x - k.x, cp.y - s.h, cp.z - k.y) / 400, 1, 5);
        this.proj(k.x, s.h + r.top + FLAG_H[k.tier] * (grow - 1) + 3.5, k.y);
        r.seen = this.frame;
        r.on = this.pw > 4 && this.px > -70 && this.px < this.w + 70 && this.py > -10 && this.py < this.h + 90;
        if (!r.on) { r.na = 0; r.nameOn = false; continue; }
        const px = (10.6 + 2.6 * this.zoom + k.tier * 0.5) * u;
        this.count(r, k.men, px);
        r.px = px; r.h = px * 1.5; r.w = Math.max(r.h * 1.7, r.tw + px * 1.15);
        r.ax = this.px; r.ay = this.py;
        r.x0 = r.ax - r.w / 2; r.y0 = r.ay - notch - bar - r.h;
        this.take(r.x0 - 2, r.y0 - 1, r.x0 + r.w + 2, r.ay);
      }
    }

    layArmies() {
      const g = this.game, L = this.land, u = this.u, bar = 4.6 * u, notch = 4.5 * u;
      for (const a of g.armies) {
        if (a.men < 1) continue;
        let r = this.al.get(a.id);
        if (!r) { r = { seen: 0, on: false, camp: false, pinned: false, gx: 0, gy: 0, gh: 0, ax: 0, ay: 0, x0: 0, y0: 0, w: 0, h: 0, px: 10, men: -1, txt: '', tw: 0, fk: 0 }; this.al.set(a.id, r); }
        const camp = this.isCamp(a), b = a.state === 'fight' && !camp ? a.battle : null;
        let x = a.x, y = a.y;
        if (camp) { this.spot(a); x = this.cx; y = this.cy; }
        r.seen = this.frame; r.camp = camp; r.gx = x; r.gy = y; r.gh = Math.max(0, L.heightAt(x, y));
        const px = (9.6 + 2.8 * this.zoom) * u;
        this.count(r, a.men, px);
        r.px = px; r.h = px * 1.42; r.w = Math.max(r.h * 1.5, r.tw + px * (camp ? 1.9 : 1));
        r.pinned = !!b;
        if (b) { r.on = false; continue; }                        // two columns that have met: layBattles sets their plates
        this.proj(x, r.gh + (camp ? 12 : 11), y);
        r.ax = this.px; r.ay = this.py;
        r.x0 = r.ax - r.w / 2; r.y0 = r.ay - notch - bar - r.h;
        // A plate that would cover another steps aside (up, right, left or down), but never far from its men:
        // if there is no room close by it stays where it is and overlaps.
        const wide = r.w + (camp ? 0 : r.h * 0.36), j = this.hit(r.x0 - 1, r.y0 - 1, r.x0 + wide + 1, r.y0 + r.h + bar);
        if (j >= 0) {
          const ox = r.x0, oy = r.y0, rx = this.rx;
          for (let i = 0; i < 4; i++) {
            r.x0 = i === 1 ? rx[j + 2] + 3 : i === 2 ? rx[j] - wide - 3 : ox;
            r.y0 = i === 0 ? rx[j + 1] - r.h - bar - 2 : i === 3 ? rx[j + 3] + 3 : oy;
            if (Math.abs(r.x0 - ox) + Math.abs(r.y0 - oy) <= 30 * u && this.hit(r.x0 - 1, r.y0 - 1, r.x0 + wide + 1, r.y0 + r.h + bar) < 0) break;
            if (i === 3) { r.x0 = ox; r.y0 = oy; }
          }
        }
        r.on = this.pw > 4 && r.x0 > -90 && r.x0 < this.w + 40 && r.y0 > -40 && r.y0 < this.h + 40;
        if (r.on) this.take(r.x0 - 1, r.y0 - 1, r.x0 + wide + 1, r.y0 + r.h + bar);
      }
      if (this.frame % 240 === 0) { this.al.forEach(this.reap); this.bl.forEach(this.reap); }
    }

    /** The marker over each battle, stepped up over any plate in its way, and the plates of the columns fighting it. */
    layBattles() {
      const g = this.game, L = this.land, u = this.u, rad = 10.5 * u;
      for (const b of g.battles) {
        let r = this.bl.get(b.id);
        if (!r) { r = { seen: 0, on: false, x: 0, y: 0, a: -1, d: -1, at: '', dt: '' }; this.bl.set(b.id, r); }
        r.seen = this.frame;
        this.proj(b.x, Math.max(0, L.heightAt(b.x, b.y)) + 17, b.y);
        r.on = this.pw > 4 && this.px > -60 && this.px < this.w + 60 && this.py > -60 && this.py < this.h + 60;
        r.x = this.px; r.y = this.py;
        if (!r.on) continue;
        for (let i = 0; i < 3; i++) {
          const j = this.hit(r.x - rad - 2, r.y - rad - 2, r.x + rad + 2, r.y + rad + 14 * u);
          if (j < 0) break;
          r.y = this.rx[j + 1] - rad - 15 * u;
        }
        this.take(r.x - rad - 2, r.y - rad - 2, r.x + rad + 2, r.y + rad + 14 * u);
        // Two columns that have met stand on one spot: their plates go either side of the crossed blades.
        this.pin(b.att.army, r, -1); this.pin(b.def.army, r, 1);
      }
    }
    pin(a, at, side) {
      const r = a && a.men >= 1 ? this.al.get(a.id) : null, u = this.u;
      if (!r || !r.pinned || r.seen !== this.frame) return;
      r.ax = at.x; r.ay = at.y;
      r.x0 = side < 0 ? at.x - 15 * u - r.w - r.h * 0.36 : at.x + 15 * u; r.y0 = at.y - r.h / 2;
      r.on = true;
      this.take(r.x0 - 1, r.y0 - 1, r.x0 + r.w + r.h * 0.36 + 1, r.y0 + r.h + 5 * u);
    }

    /** How much a town's name matters when two names want the same room. */
    weight(id) {
      const g = this.game, k = g.keeps[id];
      let w = k.tier * 10 - id * 0.01;
      if (k.owner === (BC.PLAYER || 0)) w += 100;
      if (g.crown >= 0 && g.factions[g.crown].seat === id) w += 60;
      if (k.owner >= 0 && g.factions[k.owner].seat === id) w += 25;
      return w;
    }

    /** Names go where there is room for them: every plate first, then the names in order of importance. */
    layNames(dt) {
      const g = this.game, u = this.u, ctx = this.ctx, hov = this.hover, aim = this.aim;
      const key = g.version * 16 + g.crown + 1;
      if (key !== this.rankKey) { this.rankKey = key; this.order.sort(this.byRank); }
      const npx = (10.2 + 2.2 * this.zoom) * u, nfk = Math.round(npx * 4), ease = this.calm ? 1 : Math.min(1, dt * 9);
      for (let i = 0; i < this.order.length; i++) {
        const id = this.order[i], k = g.keeps[id], r = this.tl[id];
        if (!r.on) continue;
        if (r.nfk !== nfk) { ctx.font = this.font(600, npx); r.nw = ctx.measureText(k.name).width; r.nfk = nfk; }
        r.npx = npx;
        const y1 = r.y0 - 2.5 * u, y0 = y1 - npx * 1.2, x0 = r.ax - r.nw / 2 - 3, x1 = r.ax + r.nw / 2 + 3;
        const must = !this.quietMap && ((hov && hov.type === 'keep' && hov.id === id) || (aim && aim.target === id) || this.sel.has(r.key));
        // A name that is already showing holds its ground a little, so names do not flicker as things drift past.
        const give = r.nameOn ? 3 : 0;
        r.nameOn = must || this.hit(x0 + give, y0 + give, x1 - give, y1) < 0;
        if (r.nameOn) this.take(x0, y0, x1, y1);
        r.na += ((r.nameOn ? 1 : 0) - r.na) * ease;
        r.ny = y0;
        r.stack = r.nameOn ? y0 : r.y0;
      }
    }

    /* ----- the overlay: drawing ----- */

    label(text, x, y, px, color, weight, align) {
      const ctx = this.ctx;
      ctx.font = this.font(weight || 600, px);
      ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2.5, px * 0.3);
      ctx.strokeStyle = this.ink.paper;
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * 0.85; ctx.strokeText(text, x, y);
      ctx.globalAlpha = a;
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    }

    /** A strip that shows a share: the granary of a town, the bread of an army. */
    bar(x, y, w, h, share, color) {
      const ctx = this.ctx;
      ctx.fillStyle = this.ink.outline; ctx.globalAlpha *= 0.7; ctx.fillRect(x - 1, y - 1, w + 2, h + 2); ctx.globalAlpha /= 0.7;
      ctx.fillStyle = color; ctx.fillRect(x, y, w * clamp(share, 0, 1), h);
    }

    /** Trace a ring lying on the ground at height h, from step n0 to n1 of N_RING. False if any of it is behind the camera. */
    ring(x, y, h, radius, n0, n1) {
      const ctx = this.ctx;
      ctx.beginPath();
      for (let i = n0; i <= n1; i++) {
        this.proj(x + COS[i] * radius, h, y + SIN[i] * radius);
        if (this.pw < 4) return false;
        if (i === n0) ctx.moveTo(this.px, this.py); else ctx.lineTo(this.px, this.py);
      }
      return true;
    }

    /** The brass ring round one selected thing. */
    selRing(key) {
      const g = this.game, ctx = this.ctx, u = this.u, id = keyId(key);
      let x, y, h, rad;
      if (key[0] === 'k') { const s = this.land.sites[id]; if (!s) return; x = s.x; y = s.y; h = s.h + 0.6; rad = s.r + 6; void g; }
      else {
        const r = this.al.get(id);
        if (!r || r.seen !== this.frame) return;
        x = r.gx; y = r.gy; h = r.gh + 0.6; rad = r.camp ? 19 : 12;
      }
      if (!this.ring(x, y, h, rad, 0, N_RING)) return;
      ctx.setLineDash([]); ctx.strokeStyle = this.ink.outline; ctx.globalAlpha = 0.45; ctx.lineWidth = 5.5 * u; ctx.stroke();
      ctx.globalAlpha = 1; ctx.strokeStyle = this.ink.brass; ctx.lineWidth = 3 * u;
      ctx.setLineDash(this.dashSel); ctx.lineDashOffset = this.calm ? 0 : -this.t * 9 * u;
      ctx.stroke();
      ctx.setLineDash(this.dashNone); ctx.lineDashOffset = 0;
    }

    /** A plain ring round a town, or round men in the field: what the pointer is over, or where an order is aimed. */
    hoverRing(id, army) {
      const ctx = this.ctx, s = army ? null : this.land.sites[id], r = army ? this.al.get(id) : null;
      if (army) { if (!r || r.seen !== this.frame || !this.ring(r.gx, r.gy, r.gh + 0.6, r.camp ? 19 : 12, 0, N_RING)) return; }
      else if (!s || !this.ring(s.x, s.y, s.h + 0.6, s.r + 6, 0, N_RING)) return;
      ctx.strokeStyle = this.ink.paper; ctx.globalAlpha = 0.55; ctx.lineWidth = 4 * this.u; ctx.stroke();
      ctx.strokeStyle = this.ink.text; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.6 * this.u; ctx.stroke();
      ctx.globalAlpha = 1;
    }

    drawGround(dt) {
      const g = this.game, ctx = this.ctx, u = this.u, L = this.land, ink = this.ink;
      ctx.lineCap = 'butt';
      // Sieges: a ring in the besieger's colour round the walls, and how far the walls are breached as a solid arc on it.
      for (const k of g.keeps) {
        const c = k.camp;
        if (!c || c.men < 1) continue;
        const s = L.sites[k.id], col = ink.f[g.factions[c.owner].color];
        if (!this.ring(s.x, s.y, s.h + 0.6, s.r + 3, 0, N_RING)) continue;
        ctx.strokeStyle = ink.outline; ctx.globalAlpha = 0.45; ctx.lineWidth = 6.4 * u; ctx.stroke();
        ctx.strokeStyle = col; ctx.globalAlpha = 1; ctx.lineWidth = 3.8 * u; ctx.stroke();
        ctx.strokeStyle = ink.paper; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5 * u;
        ctx.setLineDash(this.dashSiege); ctx.lineDashOffset = this.calm ? 0 : this.t * 6 * u;
        ctx.stroke();
        ctx.setLineDash(this.dashNone); ctx.lineDashOffset = 0; ctx.globalAlpha = 1;
        const n = Math.round(clamp(c.breach || 0, 0, 1) * N_RING);
        if (n > 0 && this.ring(s.x, s.y, s.h + 0.6, s.r + 3, 0, n)) { ctx.strokeStyle = col; ctx.lineWidth = 7.5 * u; ctx.stroke(); }
      }
      if (!this.quietMap) {
        this.sel.forEach(this.drawSel);
        const hov = this.hover, aim = this.aim;
        if (hov) this.hoverRing(hov.id, hov.type !== 'keep');
        if (aim && aim.target >= 0 && !(hov && hov.type === 'keep' && hov.id === aim.target)) this.hoverRing(aim.target);
      }
      // Rings thrown by events: a town changing hands, a rising, and the pings that go with the chronicle.
      const rings = this.rings;
      let keep = 0;
      for (let i = 0; i < rings.length; i++) {
        const r = rings[i];
        r.life -= dt; r.hold -= dt;
        if (r.life > 0) {
          const t = 1 - r.life / r.max;
          if (this.ring(r.x, r.y, r.h, r.big ? 30 + 44 * (1 - t) * (1 - 0.7 * this.zoom) : 20 + 42 * t * (1 - 0.5 * this.zoom), 0, N_RING)) {
            ctx.strokeStyle = r.c; ctx.globalAlpha = clamp(1 - t, 0, 1); ctx.lineWidth = 4.5 * u * (1 - t) + 1.2; ctx.stroke(); ctx.globalAlpha = 1;
          }
        }
        if (r.life > 0 || r.hold > 0) rings[keep++] = r;
      }
      rings.length = keep;
    }

    /** Work out, once for each new preview, the path on the map that its screen points stand for. */
    readAim() {
      const aim = this.aim, g = this.game, L = this.land;
      this.aimSeen = aim; this.aimOk = false; this.np = 0; this.aimW = 0;
      if (!aim || !aim.lines || !g) return;
      let n = 0, m = 0;
      for (const line of aim.lines) {
        let prev = -1, ox = 0, oy = 0;
        for (let i = 0; i < line.length; i++) {
          const p = line[i], id = this.townUnder(p[0], p[1]);
          let x, y;
          if (id >= 0) { x = g.keeps[id].x; y = g.keeps[id].y; }
          else if (i === 0 && this.armyUnder(p[0], p[1])) { x = this.cx; y = this.cy; }
          else return;                                             // not a place we know: the points are drawn as given
          if (n + 80 > this.path.length / 3) { const big = new Float32Array(this.path.length * 2); big.set(this.path); this.path = big; }
          if (i === 0) { this.path[n * 3] = x; this.path[n * 3 + 1] = y; this.path[n * 3 + 2] = Math.max(0, L.heightAt(x, y)) + 0.8; n++; }
          else {
            const road = prev >= 0 && id >= 0 ? this.roadOf[prev * g.keeps.length + id] : 0;
            // Stop the last leg at the walls, so the arrowhead is not lost under the town.
            const stop = i === line.length - 1 && id >= 0 ? L.sites[id].r + 5 : 0;
            if (road) {
              const pts = L.roads[Math.abs(road) - 1].pts, len = pts.length;
              for (let j = 1; j < len; j += 2) {
                const q = pts[road > 0 ? j : len - 1 - j];
                if (stop && Math.hypot(q[0] - x, q[1] - y) < stop) break;
                this.path[n * 3] = q[0]; this.path[n * 3 + 1] = q[1]; this.path[n * 3 + 2] = q[2] + 0.5; n++;
              }
            } else {
              const d = Math.hypot(x - ox, y - oy), steps = Math.max(1, Math.min(60, Math.round(d / 12)));
              for (let j = 1; j <= steps; j++) {
                const qx = ox + (x - ox) * j / steps, qy = oy + (y - oy) * j / steps;
                if (stop && Math.hypot(qx - x, qy - y) < stop) break;
                this.path[n * 3] = qx; this.path[n * 3 + 1] = qy; this.path[n * 3 + 2] = Math.max(0, L.heightAt(qx, qy)) + 0.8; n++;
              }
            }
          }
          prev = id; ox = x; oy = y;
        }
        if (m < this.ends.length) this.ends[m++] = n;
      }
      this.np = m; this.aimOk = m > 0;
    }

    /** The town whose centre the page projected to this screen point, or -1. */
    townUnder(px, py) {
      const g = this.game, L = this.land;
      for (const k of g.keeps) {
        this.proj(k.x, Math.max(0, L.heightAt(k.x, k.y)), k.y);
        if (Math.abs(this.px - px) < 1 && Math.abs(this.py - py) < 1) return k.id;
      }
      return -1;
    }
    /**
     * The camp or column the page projected to this screen point: its map position is left in this.cx, this.cy.
     * A column has marched a step since the page looked, so the nearest within a few pixels is taken.
     */
    armyUnder(px, py) {
      const g = this.game, L = this.land;
      let best = 8, bx = 0, by = 0;
      for (const a of g.armies) {
        if (a.men < 1) continue;
        let x = a.x, y = a.y;
        if (this.isCamp(a)) { this.spot(a); x = this.cx; y = this.cy; }
        this.proj(x, Math.max(0, L.heightAt(x, y)) + 3, y);
        const d = Math.hypot(this.px - px, this.py - py);
        if (d < best) { best = d; bx = x; by = y; }
      }
      this.cx = bx; this.cy = by;
      return best < 8;
    }

    /** The order preview: the road the men would take, and a line still being pulled out from a town. */
    drawAim() {
      const ctx = this.ctx, u = this.u, ink = this.ink, aim = this.aim, pull = this.pull;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (pull) {
        ctx.strokeStyle = ink.brass; ctx.globalAlpha = 0.85; ctx.lineWidth = 2.5 * u; ctx.setLineDash(this.dashPull);
        ctx.beginPath(); ctx.moveTo(pull.from[0], pull.from[1]); ctx.lineTo(pull.to[0], pull.to[1]); ctx.stroke();
        ctx.setLineDash(this.dashNone); ctx.globalAlpha = 1;
      }
      if (!aim || !aim.lines) return;
      const col = aim.tone === 'bad' ? ink.bad : ink.brass;
      ctx.beginPath();
      const heads = this.heads;
      let nh = 0;
      if (this.aimOk) {
        let i = 0;
        for (let m = 0; m < this.np; m++) {
          const end = this.ends[m];
          let pen = 0, x1 = 0, y1 = 0, x2 = 0, y2 = 0;
          for (; i < end; i++) {
            this.proj(this.path[i * 3], this.path[i * 3 + 2], this.path[i * 3 + 1]);
            if (this.pw < 4) { pen = 0; continue; }
            if (pen) ctx.lineTo(this.px, this.py); else ctx.moveTo(this.px, this.py);
            pen++; x2 = x1; y2 = y1; x1 = this.px; y1 = this.py;
          }
          if (pen > 1 && nh < 16 && (x1 !== x2 || y1 !== y2)) { heads[nh * 3] = x1; heads[nh * 3 + 1] = y1; heads[nh * 3 + 2] = Math.atan2(y1 - y2, x1 - x2); nh++; }
        }
      } else {
        for (const line of aim.lines) for (let i = 0; i < line.length; i++) { if (i) ctx.lineTo(line[i][0], line[i][1]); else ctx.moveTo(line[i][0], line[i][1]); }
      }
      ctx.strokeStyle = ink.outline; ctx.globalAlpha = 0.4; ctx.lineWidth = 6.5 * u; ctx.stroke();
      ctx.strokeStyle = col; ctx.globalAlpha = 1; ctx.lineWidth = 3.6 * u;
      ctx.setLineDash(this.dashAim); ctx.lineDashOffset = this.calm ? 0 : -this.t * 30 * u;
      ctx.stroke();
      ctx.setLineDash(this.dashNone); ctx.lineDashOffset = 0;
      for (let i = 0; i < nh; i++) {
        // An arrowhead where the road reaches the walls.
        const hx = heads[i * 3], hy = heads[i * 3 + 1], ang = heads[i * 3 + 2], k = 8 * u, ca = Math.cos(ang), sa = Math.sin(ang);
        ctx.beginPath();
        ctx.moveTo(hx + ca * k, hy + sa * k);
        ctx.lineTo(hx - ca * k * 0.7 - sa * k * 0.85, hy - sa * k * 0.7 + ca * k * 0.85);
        ctx.lineTo(hx - ca * k * 0.7 + sa * k * 0.85, hy - sa * k * 0.7 - ca * k * 0.85);
        ctx.closePath();
        ctx.fillStyle = col; ctx.fill();
        ctx.strokeStyle = ink.outline; ctx.lineWidth = 1.2 * u; ctx.stroke();
      }
    }

    drawTown(k, r) {
      const g = this.game, ctx = this.ctx, u = this.u, ink = this.ink, t = this.t;
      const fill = k.owner < 0 ? ink.free : ink.f[g.factions[k.owner].color], on = k.owner < 0 ? ink.onFree : ink.on[g.factions[k.owner].color];
      const x = r.x0, y = r.y0, w = r.w, h = r.h;
      // A small pointer down to the town the plate belongs to.
      ctx.beginPath(); ctx.moveTo(r.ax - 4 * u, r.ay - 5.4 * u); ctx.lineTo(r.ax + 4 * u, r.ay - 5.4 * u); ctx.lineTo(r.ax, r.ay); ctx.closePath();
      ctx.fillStyle = ink.outline; ctx.fill();
      // The granary: red, and blinking, when it is empty.
      const bw = w - h * 0.7;
      if (k.hungry) { if (this.calm || Math.sin(t * 9) > -0.3) this.bar(r.ax - bw / 2, y + h + 1.6 * u, bw, 2.6 * u, 1, ink.bad); else this.bar(r.ax - bw / 2, y + h + 1.6 * u, bw, 2.6 * u, 0, ink.bad); }
      else this.bar(r.ax - bw / 2, y + h + 1.6 * u, bw, 2.6 * u, k.cap > 0 ? k.food / k.cap : 0, ink.grain);
      pill(ctx, x, y, w, h);
      ctx.fillStyle = fill; ctx.fill();
      ctx.lineWidth = 1.5 * u; ctx.strokeStyle = ink.outline; ctx.stroke();
      // Unrest creeps round the plate in red, from the top, and closes the loop when the town rises.
      if (k.owner >= 0 && k.unrest >= 0.3) {
        const o = 2.4 * u, per = 2 * (w - h) + Math.PI * (h + 2 * o);
        pill(ctx, x - o, y - o, w + 2 * o, h + 2 * o);
        this.dashOne[0] = per * Math.min(1, k.unrest); this.dashOne[1] = per * 2;
        ctx.setLineDash(this.dashOne);
        ctx.strokeStyle = ink.bad; ctx.lineWidth = 2.6 * u;
        ctx.globalAlpha = k.unrest > 0.85 && !this.calm ? 0.6 + 0.4 * Math.sin(t * 7) : clamp(k.unrest + 0.3, 0.6, 1);
        ctx.stroke();
        ctx.setLineDash(this.dashNone); ctx.globalAlpha = 1;
      }
      ctx.font = this.font(700, r.px); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = on;
      ctx.fillText(r.txt, r.ax, y + h / 2 + r.px * 0.06);
      // Under siege: a badge in the besieger's colour hooked on the plate, with crossed blades in it.
      const c = k.camp;
      if (c && c.men >= 1) {
        const col = g.factions[c.owner].color, bx = x + w + 1.5 * u, by = y + h / 2, br = h * 0.46;
        ctx.beginPath(); ctx.arc(bx, by, br, 0, TAU);
        ctx.fillStyle = ink.f[col]; ctx.fill();
        ctx.lineWidth = 1.4 * u; ctx.strokeStyle = ink.outline; ctx.stroke();
        this.blades(bx, by, br * 0.5, ink.on[col], 1.5 * u);
      }
    }

    blades(x, y, s, color, width) {
      const ctx = this.ctx;
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    /** The hair line from a plate that stepped aside back to its men. Drawn before any plate, so it never crosses a number. */
    drawLead(r) {
      const ctx = this.ctx, u = this.u, mid = r.x0 + r.w / 2;
      if (r.pinned || Math.abs(r.ax - mid) + Math.abs(r.ay - (r.y0 + r.h + 9.1 * u)) <= 3 * u) return;
      ctx.strokeStyle = this.ink.outline; ctx.lineWidth = 1.3 * u;
      ctx.beginPath(); ctx.moveTo(mid, r.y0 + r.h / 2); ctx.lineTo(r.ax, r.ay); ctx.stroke();
      ctx.beginPath(); ctx.arc(r.ax, r.ay, 2 * u, 0, TAU); ctx.fillStyle = this.ink.outline; ctx.fill();
    }

    drawArmy(a, r) {
      const g = this.game, ctx = this.ctx, u = this.u, ink = this.ink;
      const col = g.factions[a.owner].color, x = r.x0, y = r.y0, w = r.w, h = r.h, mid = x + w / 2;
      ctx.globalAlpha = a.rout ? 0.5 : 1;                         // broken and running: a ghost of a plate
      if (!r.pinned) {
        // A pointer down to the men (a plate that had to step aside has a hair line back to them instead).
        const base = y + h + 4.6 * u;
        if (Math.abs(r.ax - mid) + Math.abs(r.ay - base - 4.5 * u) <= 3 * u) {
          ctx.beginPath(); ctx.moveTo(mid - 3.4 * u, base); ctx.lineTo(mid + 3.4 * u, base); ctx.lineTo(mid, base + 4.5 * u); ctx.closePath();
          ctx.fillStyle = ink.outline; ctx.fill();
        }
      }
      // Bread: what they carry, red when it has run out.
      const bw = w - (r.camp ? h * 0.7 : 2 * u);
      this.bar(r.camp ? mid - bw / 2 : x + 1 * u, y + h + 1.5 * u, bw, 2.2 * u, a.hungry ? 1 : a.food / Math.max(1, a.men * BC.CARRY), a.hungry ? ink.bad : ink.grain);
      // A camp is a lozenge with a tent on it, like a small town; a column carries a pennant.
      if (r.camp) pill(ctx, x, y, w, h); else pennant(ctx, x, y, w, h, h * 0.36);
      ctx.fillStyle = ink.f[col]; ctx.fill();
      ctx.lineWidth = 1.4 * u; ctx.strokeStyle = ink.outline; ctx.stroke();
      ctx.font = this.font(700, r.px); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = ink.on[col];
      if (r.camp) {
        const s = r.px * 0.36, tx = x + h * 0.5 + s * 0.2, ty = y + h / 2;
        ctx.beginPath(); ctx.moveTo(tx - s, ty + s * 0.8); ctx.lineTo(tx, ty - s * 0.9); ctx.lineTo(tx + s, ty + s * 0.8); ctx.closePath(); ctx.fill();
        ctx.fillText(r.txt, mid + r.px * 0.42, y + h / 2 + r.px * 0.06);
      } else ctx.fillText(r.txt, mid, y + h / 2 + r.px * 0.06);
      ctx.globalAlpha = 1;
    }

    /** Crossed blades over a battle, a ring that fills as it is fought out, and the dead on each side ticking up. */
    drawBattle(b) {
      const g = this.game, ctx = this.ctx, u = this.u, ink = this.ink, r = this.bl.get(b.id);
      if (!r || !r.on || r.seen !== this.frame) return;
      const x = r.x, y = r.y, rad = 10.5 * u, px = (11 + 1.5 * this.zoom) * u;
      const da = Math.floor(b.att.dead), dd = Math.floor(b.def.dead);
      if (da !== r.a) { r.a = da; r.at = '-' + fmt(da); }
      if (dd !== r.d) { r.d = dd; r.dt = '-' + fmt(dd); }
      ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU);
      ctx.fillStyle = ink.paper; ctx.fill();
      ctx.lineWidth = 3.4 * u; ctx.strokeStyle = ink.outline; ctx.globalAlpha = 0.35; ctx.stroke(); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(x, y, rad, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(b.t / (b.dur || 1), 0.02, 1));
      ctx.strokeStyle = ink.bad; ctx.lineWidth = 3.4 * u; ctx.stroke();
      const beat = this.calm ? 0 : Math.sin(this.t * 11 + b.id) * 0.6 * u;
      this.blades(x, y, 4.6 * u + beat, ink.bad, 2.3 * u);
      // The dead so far: the attacker's on the left in his colour, the defender's on the right.
      const ca = b.att.owner < 0 ? ink.free : ink.f[g.factions[b.att.owner].color], cd = b.def.owner < 0 ? ink.free : ink.f[g.factions[b.def.owner].color];
      this.label(r.at, x - 3 * u, y + rad + px * 0.9, px, ca, 700, 'right');
      this.label(r.dt, x + 3 * u, y + rad + px * 0.9, px, cd, 700, 'left');
    }

    crown(x, y) {
      const ctx = this.ctx, ink = this.ink, s = 7.5 * this.u;
      y -= this.calm ? 0 : Math.sin(this.t * 2.2) * 1.2;
      ctx.beginPath();
      ctx.moveTo(x - s, y + s * 0.55); ctx.lineTo(x - s, y - s * 0.5); ctx.lineTo(x - s * 0.45, y);
      ctx.lineTo(x, y - s * 0.75); ctx.lineTo(x + s * 0.45, y); ctx.lineTo(x + s, y - s * 0.5); ctx.lineTo(x + s, y + s * 0.55);
      ctx.closePath();
      ctx.fillStyle = ink.brass; ctx.fill();
      ctx.lineWidth = 1.3 * this.u; ctx.lineJoin = 'round'; ctx.strokeStyle = ink.outline; ctx.stroke();
    }

    /** An arrow at the edge of the screen toward a ping that is out of view, with the town's name by it. */
    drawArrows() {
      const ctx = this.ctx, u = this.u, ink = this.ink, p = this.pad, m = 22 * u;
      const x0 = p.l + m, x1 = this.w - p.r - m, y0 = p.t + m, y1 = this.h - p.b - m, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      for (const r of this.rings) {
        if (!r.big || r.hold <= 0) continue;
        this.proj(r.x, r.h, r.y);
        let dx = this.px - cx, dy = this.py - cy;
        if (this.pw < 4) { dx = -dx; dy = -dy; }                   // behind the camera the picture is turned round
        else if (this.px > p.l && this.px < this.w - p.r && this.py > p.t && this.py < this.h - p.b) continue;
        const s = Math.min(dx ? ((dx > 0 ? x1 : x0) - cx) / dx : 1e9, dy ? ((dy > 0 ? y1 : y0) - cy) / dy : 1e9);
        const ex = cx + dx * s, ey = cy + dy * s, ang = Math.atan2(dy, dx), ca = Math.cos(ang), sa = Math.sin(ang);
        const beat = this.calm ? 0 : (0.5 + 0.5 * Math.sin(this.t * 6)) * 4 * u, k = 10 * u;
        const tx = ex + ca * beat, ty = ey + sa * beat;
        ctx.globalAlpha = clamp(r.hold, 0, 1);
        ctx.beginPath();
        ctx.moveTo(tx + ca * k, ty + sa * k);
        ctx.lineTo(tx - ca * k * 0.75 - sa * k * 0.95, ty - sa * k * 0.75 + ca * k * 0.95);
        ctx.lineTo(tx - ca * k * 0.75 + sa * k * 0.95, ty - sa * k * 0.75 - ca * k * 0.95);
        ctx.closePath();
        ctx.fillStyle = r.c; ctx.fill();
        ctx.lineWidth = 2 * u; ctx.strokeStyle = ink.paper; ctx.stroke();
        if (r.name) {
          const px = 11 * u;
          if (!r.nw) { ctx.font = this.font(700, px); r.nw = ctx.measureText(r.name).width; }
          const lx = clamp(ex - ca * (k + 8 * u + r.nw / 2), p.l + r.nw / 2 + 6, this.w - p.r - r.nw / 2 - 6), ly = ey - sa * (k + 12 * u);
          this.label(r.name, lx, ly, px, ink.text, 700);
        }
        ctx.globalAlpha = 1;
      }
    }

    overlay(dt) {
      const g = this.game, ctx = this.ctx, u = this.u, ink = this.ink;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.lineJoin = 'round'; ctx.globalAlpha = 1;
      this.frame++;
      this.zoom = clamp(Math.log(this.far / this.cam.dist) / Math.log(Math.max(1.5, this.far / NEAR)), 0, 1);
      this.nr = 0;
      this.layTowns(); this.layArmies(); this.layBattles(); this.layNames(dt);

      this.drawGround(dt);
      if (!this.quietMap || this.aim) this.drawAim();

      // Towns: garrison, granary, unrest, siege; then the men in the field; then the battles on top of both.
      for (const a of g.armies) {
        const r = a.men >= 1 ? this.al.get(a.id) : null;
        if (r && r.on && r.seen === this.frame) this.drawLead(r);
      }
      for (const k of g.keeps) { const r = this.tl[k.id]; if (r.on) this.drawTown(k, r); }
      for (const a of g.armies) {
        if (a.men < 1) continue;
        const r = this.al.get(a.id);
        if (r && r.on && r.seen === this.frame) this.drawArmy(a, r);
      }
      for (const b of g.battles) this.drawBattle(b);

      // Names, where there was room, and the crown over the seat of whoever wears it.
      const seat = g.crown >= 0 ? g.factions[g.crown].seat : -1;
      for (const k of g.keeps) {
        const r = this.tl[k.id];
        if (!r.on) continue;
        if (r.na > 0.03) { ctx.globalAlpha = r.na; this.label(k.name, r.ax, r.ny + r.npx * 0.62, r.npx, ink.text, 600); ctx.globalAlpha = 1; }
        if (k.id === seat) this.crown(r.ax, (r.na > 0.5 ? r.ny : r.y0) - 7.5 * u);
      }

      // Words that rise off the map: the outcome of a battle, an order that could not be carried out.
      const floats = this.floats;
      let keep = 0;
      for (let i = 0; i < floats.length; i++) {
        const f = floats[i];
        f.life -= dt;
        if (f.life <= 0) continue;
        floats[keep++] = f;
        const t = 1 - f.life / f.max, px = 12.5 * u;
        if (f.w === undefined) { ctx.font = this.font(700, px); f.w = ctx.measureText(f.text).width; f.h = Math.max(0, this.land.heightAt(f.x, f.y)); }
        this.proj(f.x, f.h + 20, f.y);
        if (this.pw < 4) continue;
        ctx.globalAlpha = clamp(f.life * 1.5, 0, 1);
        this.label(f.text, clamp(this.px, f.w / 2 + 8, this.w - f.w / 2 - 8), this.py - 26 * u - t * 26 * u, px, f.tone === 'good' ? ink.good : f.tone === 'bad' ? ink.bad : ink.text, 700);
        ctx.globalAlpha = 1;
      }
      floats.length = keep;

      // What the order would do, on a slip of paper above everything the target town already shows.
      const aim = this.aim;
      if (aim && aim.text && aim.target >= 0 && this.tl[aim.target]) {
        const r = this.tl[aim.target], px = 12.5 * u;
        if (!this.aimW) { ctx.font = this.font(700, px); this.aimW = ctx.measureText(aim.text).width; }
        const w = this.aimW + 16 * u, h = px * 1.75, k = g.keeps[aim.target], site = this.land.sites[aim.target];
        const lx = this.pad.l + 4, hx = Math.max(lx, this.w - this.pad.r - w - 4), ly = this.pad.t + 4, hy = this.h - this.pad.b - h - 4;
        this.proj(k.x, site.h, k.y);
        const gy = this.py, below = this.pw > 4 ? (site.r + 10) * this.focal / this.pw : 40;
        let x = 0, y = 0;
        // Above the town's own labels if that is free, else below it, else to one side: wherever covers nothing.
        for (let i = 0; i < 4; i++) {
          const cx = !r.on ? this.px : i < 2 ? r.ax : i === 2 ? r.x0 + r.w + w / 2 + 12 * u : r.x0 - w / 2 - 12 * u;
          const cy = !r.on ? gy - 40 * u : i === 0 ? (aim.target === seat ? r.stack - 15 * u : r.stack) - h / 2 - 5 * u : i === 1 ? gy + below + h / 2 : r.y0 + r.h / 2;
          x = clamp(cx - w / 2, lx, hx); y = clamp(cy - h / 2, ly, hy);
          if (this.hit(x, y, x + w, y + h) < 0) break;
          if (i === 3) { x = clamp(r.ax - w / 2, lx, hx); y = clamp((aim.target === seat ? r.stack - 15 * u : r.stack) - h - 5 * u, ly, hy); }
        }
        const col = aim.tone === 'bad' ? ink.bad : aim.tone === 'good' ? ink.good : ink.text;
        pill(ctx, x, y, w, h);
        ctx.fillStyle = ink.paper; ctx.globalAlpha = 0.93; ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = 1.6 * u; ctx.strokeStyle = col; ctx.stroke();
        ctx.font = this.font(700, px); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = col;
        ctx.fillText(aim.text, x + w / 2, y + h / 2 + px * 0.06);
      }

      if (!this.quietMap) this.drawArrows();

      const b = this.box;
      if (b) {
        const x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1), w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0);
        ctx.fillStyle = ink.brass; ctx.globalAlpha = 0.12; ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = ink.brass; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5; ctx.setLineDash(this.dashBox);
        ctx.strokeRect(x, y, w, h); ctx.setLineDash(this.dashNone); ctx.globalAlpha = 1;
      }
      if (this.lost) this.label('The picture was lost. It will come back in a moment.', this.w / 2, this.pad.t + 24 * u, 13 * u, ink.text, 700);
    }
  }

  // Dash patterns, made once: setLineDash copies what it is given, so sharing them costs nothing.
  const P = View3D.prototype;
  P.dashNone = []; P.dashSel = [9, 6]; P.dashSiege = [3, 8]; P.dashAim = [11, 8]; P.dashPull = [6, 6]; P.dashBox = [5, 4];
  P.dashOne = [0, 0];

  BC.View3D = View3D;
})();
