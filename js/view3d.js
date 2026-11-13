/*
 * Borrowed Crown: the 3D view.
 *
 * Owns the WebGL renderer, the camera, and a 2D canvas laid over the scene for everything
 * that has to stay crisp: names, head counts, granary bars, order previews. It offers the
 * same surface as the flat map (BC.Renderer) so the page can drive either one.
 *
 * Needs THREE (three.js r149) plus BC.buildTerrain, BC.Scenery, BC.Towns and BC.Units.
 * Map (x, y) with height h sits at scene (x, h, y).
 */
(function () {
  'use strict';
  const BC = (window.BC = window.BC || {});
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function rgb(hex) {
    hex = hex.trim().replace('#', '');
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const n = parseInt(hex.slice(0, 6), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const css = (c, a) => 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + (a === undefined ? 1 : a) + ')';
  const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  const fmt = (n) => { n = Math.floor(n); return n >= 10000 ? Math.round(n / 1000) + 'k' : String(n); };

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
      this.w = 1; this.h = 1; this.dpr = 1; this.u = 1; this.s = 1;
      this.pad = { t: 4, r: 4, b: 4, l: 4 };
      this.game = null; this.land = null; this.t = 0;
      this.sel = new Set();        // 'k<id>' towns, 'c<id>' camps, 'a<id>' columns on the march
      this.hover = null; this.aim = null; this.box = null; this.pull = null; this.quietMap = false;
      this.floats = []; this.rings = []; this.marks = [];
      this.cam = { x: 0, y: 0, dist: 1200, yaw: 0, pitch: 0.96 };      // what the camera is doing now
      this.goal = { x: 0, y: 0, dist: 1200, yaw: 0, pitch: 0.96 };     // where it is easing to
      this.far = 2000;                                                  // the distance that frames the whole realm
      this.v = new THREE.Vector3(); this.ray = new THREE.Raycaster();
      this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -2);
      this.calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
      if (this.scenery) { this.scenery.setTheme(th); this.towns.setTheme(th); this.units.setTheme(th); }
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
      this.home(true);
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr);
      this.renderer.setPixelRatio(this.dpr);
      this.renderer.setSize(this.w, this.h, false);
      this.camera.aspect = this.w / this.h;
      this.camera.updateProjectionMatrix();
      this.u = clamp(Math.min(this.w, this.h) / 620, 0.82, 1.15);
      if (this.game) this.home(false, true);
    }

    layout() { /* the flat map lays itself out here; the camera does that job for us */ }

    /* ----- camera ----- */

    /** Put the camera where the rig says. */
    place(c) {
      const cp = Math.cos(c.pitch), ty = this.land ? Math.max(1, this.land.heightAt(c.x, c.y)) * 0.5 + 2 : 2;
      this.camera.position.set(c.x + c.dist * cp * Math.sin(c.yaw), ty + c.dist * Math.sin(c.pitch), c.y + c.dist * cp * Math.cos(c.yaw));
      this.camera.lookAt(c.x, ty, c.y);
      this.camera.updateMatrixWorld();
    }

    /** Frame the whole realm. `snap` jumps there; `keep` only refreshes the far limit (after a resize). */
    home(snap, keep) {
      const g = this.game, p = this.pad;
      const c = { x: g.W / 2, y: g.H / 2, dist: 400, yaw: 0, pitch: 0.96 };
      const inset = 40, pts = [[inset, inset], [g.W - inset, inset], [inset, g.H - inset], [g.W - inset, g.H - inset], [g.W / 2, inset], [g.W / 2, g.H - inset]];
      const fits = (dist) => {
        c.dist = dist; this.place(c);
        for (const q of pts) {
          this.v.set(q[0], 4, q[1]).project(this.camera);
          const px = (this.v.x * 0.5 + 0.5) * this.w, py = (-this.v.y * 0.5 + 0.5) * this.h;
          if (px < p.l + 8 || px > this.w - p.r - 8 || py < p.t + 8 || py > this.h - p.b - 8) return false;
        }
        return true;
      };
      // Slide the look-at point so the padded viewport is centred, then find the closest distance that fits.
      let lo = 150, hi = 9000;
      for (let i = 0; i < 22; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
      this.far = hi;
      c.dist = hi;
      if (!keep) { Object.assign(this.goal, c); if (snap) Object.assign(this.cam, c); }
      else { this.goal.dist = Math.min(this.goal.dist, this.far * 1.15); }
      this.place(this.cam);
    }

    /** Drag the ground by a number of screen pixels. */
    pan(dx, dy) {
      const c = this.goal, per = 2 * c.dist * Math.tan(this.camera.fov * Math.PI / 360) / this.h;
      const rx = Math.cos(c.yaw), ry = -Math.sin(c.yaw), fx = -Math.sin(c.yaw), fy = -Math.cos(c.yaw);
      c.x -= rx * dx * per; c.y -= ry * dx * per;
      c.x += fx * dy * per / Math.sin(c.pitch); c.y += fy * dy * per / Math.sin(c.pitch);
      this.bound();
    }

    /** Zoom by `factor` (below 1 is closer), keeping the ground under (px, py) where it is. */
    zoomAt(px, py, factor) {
      const c = this.goal, before = c.dist;
      c.dist = clamp(c.dist * factor, 110, this.far * 1.15);
      const g = this.ground(px, py);
      if (g) { const k = 1 - c.dist / before; c.x += (g[0] - c.x) * k; c.y += (g[1] - c.y) * k; }
      this.bound();
    }

    /** Swing the camera round the point it is looking at. */
    orbit(dyaw, dpitch) {
      this.goal.yaw += dyaw;
      this.goal.pitch = clamp(this.goal.pitch + dpitch, 0.42, 1.36);
    }

    focus(x, y) { this.goal.x = x; this.goal.y = y; this.bound(); }

    bound() {
      const g = this.game, c = this.goal;
      c.x = clamp(c.x, 0, g.W); c.y = clamp(c.y, 0, g.H);
    }

    /* ----- where things are ----- */

    /** Map point to screen pixels. `lift` raises it above the ground. Returns [px, py, inFront]. */
    at(x, y, lift) {
      const h = this.land ? Math.max(0, this.land.heightAt(x, y)) : 0;
      this.v.set(x, h + (lift || 0), y).project(this.camera);
      return [(this.v.x * 0.5 + 0.5) * this.w, (-this.v.y * 0.5 + 0.5) * this.h, this.v.z < 1];
    }

    /** Screen pixels to the map point on the ground under them, or null if the ray misses. */
    ground(px, py) {
      this.v.set((px / this.w) * 2 - 1, -(py / this.h) * 2 + 1, 0.5);
      this.ray.setFromCamera(this.v, this.camera);
      const hit = this.ray.ray.intersectPlane(this.plane, new THREE.Vector3());
      return hit ? [hit.x, hit.z] : null;
    }

    /** Where a siege camp stands on the map: outside the walls, on the side it marched in from. */
    campSpot(c) {
      const site = this.land.sites[c.at], ang = Math.atan2(c.y - site.y, c.x - site.x), r = site.r + 20;
      return [site.x + Math.cos(ang) * r, site.y + Math.sin(ang) * r];
    }
    campAt(c) { const s = this.campSpot(c); return this.at(s[0], s[1], 9); }
    armyAt(a) { return this.at(a.x, a.y, 8); }
    townAt(k) { return this.at(k.x, k.y, 13 + k.tier * 5); }

    /** How many screen pixels one map unit covers at a map point. */
    scaleAt(x, y) {
      const a = this.at(x, y, 0), b = this.at(x + Math.cos(this.cam.yaw) * 10, y - Math.sin(this.cam.yaw) * 10, 0);
      return Math.hypot(b[0] - a[0], b[1] - a[1]) / 10;
    }

    /** What is under a screen point: { type: 'camp' | 'army' | 'keep', id } or null. */
    pick(px, py) {
      const g = this.game;
      if (!g) return null;
      let best = null, bd = 1e9;
      for (const a of g.armies) {
        if (a.men < 1) continue;
        const camp = a.state === 'camp' || (a.state === 'fight' && a.was === 'camp');
        const p = camp ? this.campAt(a) : this.armyAt(a), d = Math.hypot(p[0] - px, p[1] - py);
        if (p[2] && d < 22 * this.u && d < bd) { bd = d; best = { type: camp ? 'camp' : 'army', id: a.id }; }
      }
      if (best) return best;
      for (const k of g.keeps) {
        const p = this.at(k.x, k.y, 6), q = this.townAt(k);
        const reach = Math.max(26, this.land.sites[k.id].r * this.scaleAt(k.x, k.y));
        const d = Math.min(Math.hypot(p[0] - px, p[1] - py), Math.hypot(q[0] - px, q[1] - py));
        if (p[2] && d < reach && d < bd) { bd = d; best = { type: 'keep', id: k.id }; }
      }
      return best;
    }

    /* ----- effects fed by the simulation ----- */

    ping(id, tone) {
      const k = this.game.keeps[id], th = this.theme;
      if (!k) return;
      this.rings.push({ x: k.x, y: k.y, life: 1.3, max: 1.3, big: true, c: tone === 'good' ? th.good : tone === 'bad' ? th.bad : tone === 'crown' ? th.brass : tone === 'omen' ? th.omen : th.text });
    }

    ingest(list) {
      const g = this.game, th = this.theme;
      for (const e of list) {
        if (e.type === 'battle') this.marks.push({ x: e.x, y: e.y, life: e.dur || 1, id: e.id });
        else if (e.type === 'take') {
          const k = g.keeps[e.k];
          this.rings.push({ x: k.x, y: k.y, life: 0.8, max: 0.8, c: e.owner < 0 ? th.free : th.f[g.factions[e.owner].color] });
        } else if (e.type === 'revolt') {
          const k = g.keeps[e.k];
          this.rings.push({ x: k.x, y: k.y, life: 0.9, max: 0.9, c: th.bad });
        } else if (e.type === 'float') this.floats.push({ x: e.x, y: e.y, text: e.text, tone: e.tone, life: 2.8, max: 2.8 });
      }
      if (this.units) this.units.ingest(list);
    }

    /* ----- the frame ----- */

    draw(dt) {
      const g = this.game;
      if (!g) return;
      this.t += dt;
      const k = this.calm ? 1 : 1 - Math.exp(-dt * 9), c = this.cam, to = this.goal;
      c.x += (to.x - c.x) * k; c.y += (to.y - c.y) * k; c.dist += (to.dist - c.dist) * k;
      c.yaw += (to.yaw - c.yaw) * k; c.pitch += (to.pitch - c.pitch) * k;
      this.place(c);
      this.scenery.update(dt, g, this.t);
      this.towns.update(dt, g, this.t);
      this.units.update(dt, g, this.t, this);
      this.renderer.render(this.scene, this.camera);
      this.overlay(dt);
    }

    label(text, x, y, px, color, weight, align) {
      const ctx = this.ctx, th = this.theme;
      ctx.font = th.font(weight || 600, px);
      ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2.5, px * 0.3);
      ctx.strokeStyle = css(th.paper, 0.85);
      ctx.strokeText(text, x, y);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    }

    /** A lozenge with a head count in it. Returns its width. */
    plate(x, y, text, fill, px, alpha) {
      const ctx = this.ctx, th = this.theme, u = this.u;
      ctx.font = th.font(700, px);
      const w = Math.max(22 * u, ctx.measureText(text).width + 10 * u), h = px * 1.42;
      ctx.globalAlpha = alpha === undefined ? 1 : alpha;
      ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
      ctx.fillStyle = css(fill); ctx.fill();
      ctx.lineWidth = 1.5 * u; ctx.strokeStyle = css(th.outline); ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = lum(fill) > 0.42 ? css(th.outline) : '#ffffff';
      ctx.fillText(text, x, y + px * 0.05);
      ctx.globalAlpha = 1;
      return w;
    }

    bar(x, y, w, share, color) {
      const ctx = this.ctx, th = this.theme, h = 3 * this.u;
      ctx.fillStyle = css(th.outline, 0.55); ctx.fillRect(x - w / 2, y, w, h);
      ctx.fillStyle = css(color); ctx.fillRect(x - w / 2, y, w * clamp(share, 0, 1), h);
    }

    /** A ring lying on the ground round a map point, drawn as the ellipse the camera sees. */
    groundRing(x, y, radius, color, width, dash) {
      const ctx = this.ctx, p = this.at(x, y, 0.5);
      if (!p[2]) return;
      const rx = radius * this.scaleAt(x, y), ry = rx * Math.sin(this.cam.pitch);
      ctx.strokeStyle = color; ctx.lineWidth = width;
      if (dash) { ctx.setLineDash(dash); ctx.lineDashOffset = this.calm ? 0 : -this.t * 16; }
      ctx.beginPath(); ctx.ellipse(p[0], p[1], rx, ry, 0, 0, TAU); ctx.stroke();
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
    }

    overlay(dt) {
      const g = this.game, ctx = this.ctx, th = this.theme, u = this.u, L = this.land;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      const near = this.cam.dist < this.far * 0.75;

      // Order preview: the road the men would take.
      const aim = this.aim;
      if (this.pull) {
        ctx.strokeStyle = css(th.brass, 0.8); ctx.lineWidth = 2.5; ctx.setLineDash([6, 6]);
        ctx.beginPath(); ctx.moveTo(this.pull.from[0], this.pull.from[1]); ctx.lineTo(this.pull.to[0], this.pull.to[1]); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (aim) {
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.strokeStyle = css(aim.tone === 'bad' ? th.bad : th.brass, 0.95);
        ctx.lineWidth = 4 * u; ctx.setLineDash([10 * u, 8 * u]); ctx.lineDashOffset = this.calm ? 0 : -this.t * 30;
        for (const line of aim.lines) {
          ctx.beginPath();
          line.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
          ctx.stroke();
        }
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }

      // Rings on the ground: selection, hover, siege, pings.
      if (!this.quietMap) {
        for (const key of this.sel) {
          const id = +key.slice(1);
          if (key[0] === 'k') { const k = g.keeps[id]; this.groundRing(k.x, k.y, L.sites[id].r + 5, css(th.brass), 3, [8, 6]); }
          else {
            const a = g.armies.find((x) => x.id === id);
            if (!a) continue;
            const s = key[0] === 'c' ? this.campSpot(a) : [a.x, a.y];
            this.groundRing(s[0], s[1], 13, css(th.brass), 3, [7, 5]);
          }
        }
        const hov = this.hover;
        if (hov && hov.type === 'keep') { const k = g.keeps[hov.id]; this.groundRing(k.x, k.y, L.sites[k.id].r + 5, css(th.text, 0.6), 1.5); }
        if (aim && aim.target >= 0 && !(hov && hov.type === 'keep' && hov.id === aim.target)) { const k = g.keeps[aim.target]; this.groundRing(k.x, k.y, L.sites[k.id].r + 5, css(th.text, 0.6), 1.5); }
      }
      for (const k of g.keeps) {
        if (k.camp && k.camp.men >= 1) this.groundRing(k.x, k.y, L.sites[k.id].r + 2, css(th.f[g.factions[k.camp.owner].color]), 3 * u, [4 * u, 5 * u]);
      }
      for (const r of this.rings) {
        r.life -= dt;
        const t = 1 - r.life / r.max;
        this.groundRing(r.x, r.y, r.big ? 70 - 44 * t : 18 + 40 * t, css(r.c, Math.max(0, 1 - t)), 4 * u * (1 - t) + 1);
      }
      this.rings = this.rings.filter((r) => r.life > 0);

      // Towns: name, garrison, granary, unrest.
      for (const k of g.keeps) {
        const p = this.townAt(k);
        if (!p[2] || p[0] < -80 || p[0] > this.w + 80 || p[1] < -40 || p[1] > this.h + 60) continue;
        const fill = k.owner < 0 ? th.free : th.f[g.factions[k.owner].color];
        const px = (11.5 + k.tier * 0.9) * u, w = this.plate(p[0], p[1], fmt(k.men), fill, px);
        if (k.hungry) { if (this.calm || Math.sin(this.t * 9) > -0.3) this.bar(p[0], p[1] + px * 0.9, w, 1, th.bad); } else this.bar(p[0], p[1] + px * 0.9, w, k.food / k.cap, th.grain);
        if (k.owner >= 0 && k.unrest >= 0.3) {
          const pulse = k.unrest > 0.85 && !this.calm ? 0.65 + 0.35 * Math.sin(this.t * 7) : 1;
          ctx.strokeStyle = css(th.bad, clamp(k.unrest, 0.5, 1) * pulse); ctx.lineWidth = 2.6 * u; ctx.lineCap = 'butt';
          ctx.beginPath(); ctx.arc(p[0], p[1], w / 2 + 5 * u, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, k.unrest)); ctx.stroke();
        }
        if (g.crown >= 0 && g.factions[g.crown].seat === k.id) this.crown(p[0], p[1] - px * 1.5);
        this.label(k.name, p[0], p[1] + px * 0.9 + 11 * u, 10.5 * u, css(th.text, 0.92), 600);
      }

      // Men in the field: a head count over every column and camp, with the bread they have left.
      for (const a of g.armies) {
        if (a.men < 1) continue;
        const camp = a.state === 'camp' || (a.state === 'fight' && a.was === 'camp');
        const p = camp ? this.campAt(a) : this.armyAt(a);
        if (!p[2]) continue;
        const fill = th.f[g.factions[a.owner].color], px = 10.5 * u;
        const w = this.plate(p[0], p[1], fmt(a.men), fill, px, a.rout ? 0.6 : 1);
        this.bar(p[0], p[1] + px * 0.86, w - 6 * u, a.hungry ? 1 : a.food / (a.men * BC.CARRY), a.hungry ? th.bad : th.grain);
      }

      // Crossed blades over every battle still being fought.
      for (const m of this.marks) {
        m.life -= dt;
        const p = this.at(m.x, m.y, 12), s = 8 * u, al = clamp(m.life * 2, 0, 1);
        ctx.lineCap = 'round';
        for (const pass of [[css(th.paper, al), 5 * u], [css(th.bad, al), 2.4 * u]]) {
          ctx.strokeStyle = pass[0]; ctx.lineWidth = pass[1];
          ctx.beginPath();
          ctx.moveTo(p[0] - s, p[1] - s); ctx.lineTo(p[0] + s, p[1] + s);
          ctx.moveTo(p[0] + s, p[1] - s); ctx.lineTo(p[0] - s, p[1] + s);
          ctx.stroke();
        }
      }
      this.marks = this.marks.filter((m) => m.life > 0);

      for (const f of this.floats) {
        f.life -= dt;
        const t = 1 - f.life / f.max, p = this.at(f.x, f.y, 16);
        ctx.globalAlpha = clamp(f.life * 1.5, 0, 1);
        this.label(f.text, clamp(p[0], 90, this.w - 90), p[1] - 14 * u - t * 26 * u, 12.5 * u, css(f.tone === 'good' ? th.good : f.tone === 'bad' ? th.bad : th.text), 700);
        ctx.globalAlpha = 1;
      }
      this.floats = this.floats.filter((f) => f.life > 0);

      if (aim && aim.text && aim.target >= 0) {
        const k = g.keeps[aim.target], p = this.townAt(k);
        this.label(aim.text, clamp(p[0], 110, this.w - 110), Math.max(16, p[1] - 30 * u), 13 * u, css(aim.tone === 'bad' ? th.bad : aim.tone === 'good' ? th.good : th.text), 700);
      }

      const b = this.box;
      if (b) {
        const x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1), w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0);
        ctx.fillStyle = css(th.brass, 0.12); ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = css(th.brass, 0.9); ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
        ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
      }
      void near;
    }

    crown(x, y) {
      const ctx = this.ctx, th = this.theme, s = 7.5 * this.u;
      y -= this.calm ? 0 : Math.sin(this.t * 2.2) * 1.5;
      ctx.beginPath();
      ctx.moveTo(x - s, y + s * 0.55); ctx.lineTo(x - s, y - s * 0.5); ctx.lineTo(x - s * 0.45, y);
      ctx.lineTo(x, y - s * 0.75); ctx.lineTo(x + s * 0.45, y); ctx.lineTo(x + s, y - s * 0.5); ctx.lineTo(x + s, y + s * 0.55);
      ctx.closePath();
      ctx.fillStyle = css(th.brass); ctx.fill();
      ctx.lineWidth = 1.3 * this.u; ctx.lineJoin = 'round'; ctx.strokeStyle = css(th.outline); ctx.stroke();
    }
  }

  BC.View3D = View3D;
})();
