/*
 * Borrowed Crown: everything drawn on the map canvas.
 *
 * The land is a small bitmap painted once per change of ownership or season and
 * stretched to fit; roads, towns, armies and effects are drawn over it every frame.
 * Colours come from the CSS tokens so the map follows the page's light and dark themes.
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
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

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

  function fmt(n) {
    n = Math.floor(n);
    return n >= 10000 ? Math.round(n / 1000) + 'k' : String(n);
  }

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.w = 1; this.h = 1; this.dpr = 1; this.s = 1; this.ox = 0; this.oy = 0; this.u = 1;
      this.pad = { t: 4, r: 4, b: 4, l: 4 };   // room kept clear around the map, in screen pixels
      this.game = null; this.t = 0;
      this.sel = new Set();        // 'k<id>' for towns, 'c<id>' for camps
      this.hover = null;           // { type, id } under the mouse
      this.aim = null;             // order preview: { lines, target, text, tone }
      this.box = null;             // selection rectangle in screen pixels
      this.pull = null;            // loose drag line: { from: [x, y], to: [x, y] }
      this.quietMap = false;       // title screen: no selection chrome
      this.sparks = []; this.rings = []; this.floats = []; this.marks = []; this.flakes = [];
      this.shake = 0;
      this.paintedVersion = -1; this.season = -1; this.blend = 1; this.landFrom = null; this.lastPaint = 0;
      this.calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.readTheme();
    }

    /* ----- setup ----- */

    readTheme() {
      const cs = getComputedStyle(document.documentElement);
      const v = (name) => rgb(cs.getPropertyValue(name) || '#888888');
      const th = {
        sea: v('--sea'), shallow: v('--shallow'), rim: v('--rim'),
        land: [v('--land-0'), v('--land-1'), v('--land-2'), v('--land-3')],
        outline: v('--outline'), free: v('--free'), grain: v('--grain'),
        f: [0, 1, 2, 3, 4, 5, 6].map((i) => v('--f' + i)),
        paper: v('--paper'), text: v('--text'), muted: v('--muted'),
        brass: v('--brass'), bad: v('--bad'), good: v('--good'), omen: v('--omen'),
      };
      th.dark = lum(th.paper) < 0.4;
      const fam = (cs.getPropertyValue('--body') || 'sans-serif').trim();
      th.font = (w, px) => w + ' ' + px.toFixed(1) + 'px ' + fam;
      this.theme = th;
      this.landFrom = null; this.blend = 1;
      if (this.game) this.paintTerrain();
    }

    setGame(game) {
      this.game = game;
      this.sel.clear(); this.hover = null; this.aim = null; this.box = null; this.pull = null;
      this.sparks.length = this.rings.length = this.floats.length = this.marks.length = 0;
      this.season = game.season; this.landFrom = null; this.blend = 1;
      this.buildTerrain();
      this.paintTerrain();
      this.layout();
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      this.layout();
    }

    layout() {
      const g = this.game;
      if (!g) return;
      const p = this.pad, w = Math.max(50, this.w - p.l - p.r), h = Math.max(50, this.h - p.t - p.b);
      this.s = Math.min(w / g.W, h / g.H);
      this.ox = p.l + (w - g.W * this.s) / 2;
      this.oy = p.t + (h - g.H * this.s) / 2;
      this.u = clamp(this.s / 0.85, 0.8, 1.25);
    }

    at(x, y) { return [this.ox + x * this.s, this.oy + y * this.s, true]; }
    armyAt(a) { return this.at(a.x, a.y); }

    /* The flat map has no camera: these exist so the page can drive either view. */
    pan() {}
    zoomAt() {}
    orbit() {}
    home() {}

    townR(k) { return (10.5 + 2.4 * k.tier) * this.u; }

    /** Where a siege camp is drawn: beside its town, on the side it marched in from. */
    campAt(c) {
      const k = this.game.keeps[c.at], p = this.at(k.x, k.y);
      const dx = c.x - k.x, dy = c.y - k.y, d = Math.hypot(dx, dy) || 1;
      const r = this.townR(k) * 1.6 + (20 + Math.max(0, dy / d) * 14) * this.u;
      return [p[0] + dx / d * r, p[1] + dy / d * r];
    }

    /** What is under a screen point: a camp, a town, or nothing. */
    pick(px, py) {
      const g = this.game;
      if (!g) return null;
      let best = null, bd = 1e9;
      for (const a of g.armies) {
        if (a.men < 1) continue;
        const camp = a.state === 'camp' || (a.state === 'fight' && a.was === 'camp');
        const p = camp ? this.campAt(a) : this.armyAt(a), d = Math.hypot(p[0] - px, p[1] - py);
        if (d < 17 * this.u + 6 && d < bd) { bd = d; best = { type: camp ? 'camp' : 'army', id: a.id }; }
      }
      if (best) return best;
      for (const k of g.keeps) {
        const p = this.at(k.x, k.y), d = Math.hypot(p[0] - px, p[1] - py);
        if (d < Math.max(26, this.townR(k) * 1.7) && d < bd) { bd = d; best = { type: 'keep', id: k.id }; }
      }
      return best;
    }

    /* ----- the land ----- */

    buildTerrain() {
      const g = this.game, K = g.keeps, R = g.roads, seed = g.seed | 0;
      const cs = Math.max(2, Math.sqrt(g.W * g.H / 170000));
      const gw = Math.ceil(g.W / cs), gh = Math.ceil(g.H / cs), n = gw * gh;
      const cell = new Uint8Array(n), field = new Float32Array(n), tex = new Float32Array(n);
      const edge = new Uint8Array(n).fill(255), coast = new Uint8Array(n), fade = new Float32Array(n);
      const segs = R.map((r) => {
        const a = K[r.a], b = K[r.b], dx = b.x - a.x, dy = b.y - a.y;
        return [a.x, a.y, dx, dy, dx * dx + dy * dy];
      });
      for (let y = 0, i = 0; y < gh; y++) {
        const wy = (y + 0.5) * cs;
        for (let x = 0; x < gw; x++, i++) {
          const wx = (x + 0.5) * cs;
          let dk = 1e12, id = 0;
          for (let k = 0; k < K.length; k++) {
            const dx = K[k].x - wx, dy = K[k].y - wy, d = dx * dx + dy * dy;
            if (d < dk) { dk = d; id = k; }
          }
          let dr = 1e12;
          if (dk < 62500) {
            for (let r = 0; r < segs.length; r++) {
              const s = segs[r];
              const t = clamp(((wx - s[0]) * s[2] + (wy - s[1]) * s[3]) / s[4], 0, 1);
              const ex = s[0] + s[2] * t - wx, ey = s[1] + s[3] * t - wy, d = ex * ex + ey * ey;
              if (d < dr) dr = d;
            }
          }
          // Land hugs the towns and the roads between them; noise roughens the coast,
          // and the sea always wins near the edge of the world so the map reads as an island.
          const rimD = Math.min(wx, wy, g.W - wx, g.H - wy);
          field[i] = Math.min(Math.sqrt(dk) - 108, Math.sqrt(dr) - 30)
            + (noise(wx / 150, wy / 150, seed) - 0.5) * 70 + (noise(wx / 50 + 7.3, wy / 50 + 1.9, seed + 11) - 0.5) * 30
            + Math.max(0, 46 - rimD) * 2.2;
          fade[i] = clamp(rimD / 34, 0, 1);
          cell[i] = id;
          tex[i] = 0.95 + 0.07 * noise(wx / 22, wy / 22, seed + 5) + 0.03 * hash(x, y, seed + 9);
        }
      }
      for (let y = 0, i = 0; y < gh; y++) for (let x = 0; x < gw; x++, i++) {
        if (field[i] >= 0) continue;
        if (x + 1 < gw) { const j = i + 1; if (field[j] >= 0) coast[i] = 1; else if (cell[j] !== cell[i]) { edge[i] = cell[j]; edge[j] = cell[i]; } }
        if (y + 1 < gh) { const j = i + gw; if (field[j] >= 0) coast[i] = 1; else if (cell[j] !== cell[i]) { edge[i] = cell[j]; edge[j] = cell[i]; } }
        if (x > 0 && field[i - 1] >= 0) coast[i] = 1;
        if (y > 0 && field[i - gw] >= 0) coast[i] = 1;
      }
      const c = document.createElement('canvas');
      c.width = gw; c.height = gh;
      this.terrain = { canvas: c, ctx: c.getContext('2d'), img: null, gw, gh, cell, field, tex, edge, coast, fade };
      this.terrain.img = this.terrain.ctx.createImageData(gw, gh);
    }

    landNow() {
      const to = this.theme.land[this.season < 0 ? 0 : this.season];
      return this.landFrom && this.blend < 1 ? mix(this.landFrom, to, this.blend) : to;
    }

    paintTerrain() {
      const T = this.terrain, g = this.game, th = this.theme;
      if (!T || !g) return;
      const land = this.landNow(), d = T.img.data, n = T.gw * T.gh;
      const tint = th.dark ? 0.36 : 0.38;
      const owner = g.keeps.map((k) => k.owner);
      const cols = g.keeps.map((k) => (k.owner < 0 ? mix(land, th.free, 0.14) : mix(land, th.f[g.factions[k.owner].color], tint)));
      const sea = th.sea, sh = th.shallow, rim = th.rim, ink = th.outline;
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const f = T.field[i];
        let r, gg, b;
        if (f < 0) {
          const c = cols[T.cell[i]];
          r = c[0]; gg = c[1]; b = c[2];
          if (f > -14) { const t = (1 + f / 14) * 0.5; r += (rim[0] - r) * t; gg += (rim[1] - gg) * t; b += (rim[2] - b) * t; }
          const m = T.tex[i];
          r *= m; gg *= m; b *= m;
          const e = T.edge[i];
          if (e !== 255) {
            const a = owner[T.cell[i]] !== owner[e] ? (th.dark ? 0.62 : 0.5) : 0.1;
            r += (ink[0] - r) * a; gg += (ink[1] - gg) * a; b += (ink[2] - b) * a;
          }
          if (T.coast[i]) { r += (ink[0] - r) * 0.42; gg += (ink[1] - gg) * 0.42; b += (ink[2] - b) * 0.42; }
        } else {
          const t = clamp(1 - f / 46, 0, 1), a = t * t * T.fade[i];
          r = sea[0] + (sh[0] - sea[0]) * a; gg = sea[1] + (sh[1] - sea[1]) * a; b = sea[2] + (sh[2] - sea[2]) * a;
        }
        d[p] = r; d[p + 1] = gg; d[p + 2] = b; d[p + 3] = 255;
      }
      T.ctx.putImageData(T.img, 0, 0);
      this.paintedVersion = g.version;
      this.lastPaint = this.t;
    }

    /** Ring a town on the map, so a line in the chronicle can be found. */
    ping(id, tone) {
      const k = this.game.keeps[id], th = this.theme;
      if (!k) return;
      this.rings.push({ x: k.x, y: k.y, life: 1.3, max: 1.3, big: true, c: tone === 'good' ? th.good : tone === 'bad' ? th.bad : tone === 'crown' ? th.brass : tone === 'omen' ? th.omen : th.text });
    }

    /* ----- effects fed by the simulation ----- */

    ingest(list) {
      const g = this.game, th = this.theme;
      for (const e of list) {
        if (e.type === 'battle') {
          this.marks.push({ x: e.x, y: e.y, life: Math.max(0.9, e.dur || 0) });
          const n = this.calm ? 0 : 12;
          for (let i = 0; i < n; i++) {
            const a = Math.random() * TAU, v = 30 + Math.random() * 70;
            this.sparks.push({ x: e.x, y: e.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.35 + Math.random() * 0.35, c: i % 2 ? th.brass : th.bad });
          }
        } else if (e.type === 'take') {
          const k = g.keeps[e.k];
          this.rings.push({ x: k.x, y: k.y, life: 0.7, max: 0.7, c: e.owner < 0 ? th.free : th.f[g.factions[e.owner].color] });
          if (e.prev === 0 && !this.calm) this.shake = 0.25;
        } else if (e.type === 'revolt') {
          const k = g.keeps[e.k];
          this.rings.push({ x: k.x, y: k.y, life: 0.9, max: 0.9, c: th.bad });
        } else if (e.type === 'float') {
          this.floats.push({ x: e.x, y: e.y, text: e.text, tone: e.tone, life: 2.6, max: 2.6 });
        }
      }
    }

    /* ----- the frame ----- */

    draw(dt) {
      const g = this.game, ctx = this.ctx, th = this.theme;
      if (!g) return;
      this.t += dt;
      if (g.season !== this.season) { this.landFrom = this.landNow(); this.season = g.season; this.blend = 0; }
      if (this.blend < 1) {
        this.blend = this.calm ? 1 : Math.min(1, this.blend + dt / 3);
        if (this.blend >= 1 || this.t - this.lastPaint > 0.12) this.paintTerrain();
      } else if (g.version !== this.paintedVersion) this.paintTerrain();

      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = css(th.sea);
      ctx.fillRect(0, 0, this.w, this.h);
      if (this.shake > 0) {
        this.shake -= dt;
        ctx.translate((Math.random() - 0.5) * 6 * this.shake * 4, (Math.random() - 0.5) * 6 * this.shake * 4);
      }
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.terrain.canvas, this.ox, this.oy, g.W * this.s, g.H * this.s);

      this.drawRoads();
      this.drawAim();
      for (const k of g.keeps) this.drawTown(k);
      this.drawCrown();
      for (const a of g.armies) {
        if (a.men < 1) continue;
        if (a.state === 'camp' || (a.state === 'fight' && a.was === 'camp')) this.drawCamp(a); else this.drawColumn(a);
      }
      this.drawFx(dt);
      if (g.season === 3 && !this.calm) this.drawSnow(dt); else this.flakes.length = 0;
      this.drawBox();
    }

    drawRoads() {
      const g = this.game, ctx = this.ctx, th = this.theme;
      ctx.lineCap = 'round';
      ctx.strokeStyle = css(th.text, th.dark ? 0.34 : 0.38);
      ctx.lineWidth = Math.max(1.6, 2.2 * this.u);
      ctx.setLineDash([0.1, 6.5 * this.u]);
      ctx.beginPath();
      for (const r of g.roads) {
        const a = this.at(g.keeps[r.a].x, g.keeps[r.a].y), b = this.at(g.keeps[r.b].x, g.keeps[r.b].y);
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    drawAim() {
      const ctx = this.ctx, th = this.theme, aim = this.aim;
      if (this.pull) {
        ctx.strokeStyle = css(th.brass, 0.7); ctx.lineWidth = 2.5; ctx.setLineDash([6, 6]);
        ctx.beginPath(); ctx.moveTo(this.pull.from[0], this.pull.from[1]); ctx.lineTo(this.pull.to[0], this.pull.to[1]); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (!aim) return;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = css(aim.tone === 'bad' ? th.bad : th.brass, 0.9);
      ctx.lineWidth = 4 * this.u;
      ctx.setLineDash([10 * this.u, 8 * this.u]);
      ctx.lineDashOffset = this.calm ? 0 : -this.t * 30;
      for (const line of aim.lines) {
        ctx.beginPath();
        line.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.stroke();
      }
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
    }

    /** Text with a halo of the paper colour, so it reads over any ground. */
    label(text, x, y, px, color, weight, align) {
      const ctx = this.ctx, th = this.theme;
      ctx.font = th.font(weight || 600, px);
      ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2.5, px * 0.28);
      ctx.strokeStyle = css(th.paper, 0.85);
      ctx.strokeText(text, x, y);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    }

    drawTown(k) {
      const g = this.game, ctx = this.ctx, th = this.theme, u = this.u;
      const p = this.at(k.x, k.y), x = p[0], y = p[1];
      const R = this.townR(k);
      const fill = k.owner < 0 ? th.free : th.f[g.factions[k.owner].color];
      const w = R * (1.7 + 0.32 * k.tier), h = R * 1.42, mh = R * 0.36;
      const top = y - h / 2 + mh * 0.5, bottom = y + h / 2 + mh * 0.5, left = x - w / 2;
      const key = 'k' + k.id, ringR = Math.max(w * 0.62, h * 0.8) + 5 * u;
      const hot = !this.quietMap && this.hover && this.hover.type === 'keep' && this.hover.id === k.id;

      if (!this.quietMap && this.sel.has(key)) {
        ctx.strokeStyle = css(th.brass); ctx.lineWidth = 3;
        ctx.setLineDash([7, 5]); ctx.lineDashOffset = this.calm ? 0 : -this.t * 16;
        ctx.beginPath(); ctx.arc(x, y + mh * 0.3, ringR + 3, 0, TAU); ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      } else if (hot || (this.aim && this.aim.target === k.id)) {
        ctx.strokeStyle = css(th.text, 0.55); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y + mh * 0.3, ringR + 3, 0, TAU); ctx.stroke();
      }

      // Unrest: a red arc that closes as the town nears revolt.
      if (k.owner >= 0 && k.unrest >= 0.3) {
        const near = k.unrest > 0.85 && !this.calm ? 0.65 + 0.35 * Math.sin(this.t * 7) : 1;
        ctx.strokeStyle = css(th.bad, clamp(k.unrest, 0.45, 1) * near);
        ctx.lineWidth = 2.6 * u; ctx.lineCap = 'butt';
        ctx.beginPath(); ctx.arc(x, y + mh * 0.3, ringR - 1, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, k.unrest)); ctx.stroke();
      }

      // Siege: the besieger's colour drawn tight around the walls.
      if (k.camp && k.camp.men >= 1) {
        ctx.strokeStyle = css(th.f[g.factions[k.camp.owner].color]);
        ctx.lineWidth = 3 * u; ctx.setLineDash([3 * u, 4 * u]); ctx.lineDashOffset = this.calm ? 0 : this.t * 10;
        ctx.beginPath(); ctx.arc(x, y + mh * 0.3, ringR - 5 * u, 0, TAU); ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }

      // The tower: wider and more crenellated the bigger the place.
      ctx.fillStyle = css(th.outline, 0.28);
      ctx.beginPath(); ctx.ellipse(x, bottom + 1.5, w * 0.56, 3.2 * u, 0, 0, TAU); ctx.fill();
      const m = k.tier + 1, slot = w / (2 * m - 1);
      ctx.beginPath();
      ctx.moveTo(left, bottom); ctx.lineTo(left, top - mh);
      for (let i = 0; i < m; i++) {
        ctx.lineTo(left + (2 * i + 1) * slot, top - mh);
        if (i < m - 1) { ctx.lineTo(left + (2 * i + 1) * slot, top); ctx.lineTo(left + (2 * i + 2) * slot, top); ctx.lineTo(left + (2 * i + 2) * slot, top - mh); }
      }
      ctx.lineTo(left + w, bottom); ctx.closePath();
      ctx.fillStyle = css(fill); ctx.fill();
      ctx.lineJoin = 'round'; ctx.lineWidth = 1.6 * u; ctx.strokeStyle = css(th.outline); ctx.stroke();

      const text = fmt(k.men);
      const px = Math.min(R * 1.02, (w - 4) / (text.length * 0.56));
      ctx.font = th.font(700, px);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = lum(fill) > 0.42 ? css(th.outline) : '#ffffff';
      ctx.fillText(text, x, (top + bottom) / 2 + px * 0.04);

      // Granary: how full, and red when the garrison is going hungry.
      const by = bottom + 5 * u, bh = 3.2 * u, share = clamp(k.food / k.cap, 0, 1);
      ctx.fillStyle = css(th.outline, th.dark ? 0.7 : 0.4);
      ctx.fillRect(left, by, w, bh);
      if (k.hungry) {
        if (this.calm || Math.sin(this.t * 9) > -0.3) { ctx.fillStyle = css(th.bad); ctx.fillRect(left, by, w, bh); }
      } else { ctx.fillStyle = css(th.grain); ctx.fillRect(left, by, w * share, bh); }

      if (this.s > 0.5 || hot || this.sel.has(key)) {
        this.label(k.name, x, by + bh + 8 * u, 10.5 * u, css(th.text, 0.86), 600);
      }
    }

    drawCrown() {
      const g = this.game, ctx = this.ctx, th = this.theme, u = this.u;
      if (g.crown < 0) return;
      const f = g.factions[g.crown];
      if (!f.alive || f.seat < 0) return;
      const k = g.keeps[f.seat], p = this.at(k.x, k.y), R = this.townR(k);
      const x = p[0], y = p[1] - R * 1.42 / 2 - 9 * u - (this.calm ? 0 : Math.sin(this.t * 2.2) * 1.5), s = 7.5 * u;
      ctx.beginPath();
      ctx.moveTo(x - s, y + s * 0.55); ctx.lineTo(x - s, y - s * 0.5); ctx.lineTo(x - s * 0.45, y);
      ctx.lineTo(x, y - s * 0.75); ctx.lineTo(x + s * 0.45, y); ctx.lineTo(x + s, y - s * 0.5); ctx.lineTo(x + s, y + s * 0.55);
      ctx.closePath();
      ctx.fillStyle = css(th.brass); ctx.fill();
      ctx.lineWidth = 1.3 * u; ctx.lineJoin = 'round'; ctx.strokeStyle = css(th.outline); ctx.stroke();
    }

    /** A lozenge with a head count in it: the shape every body of men in the field is drawn with. */
    token(x, y, a, extra) {
      const g = this.game, ctx = this.ctx, th = this.theme, u = this.u;
      const fill = th.f[g.factions[a.owner].color];
      const text = fmt(a.men), px = 11 * u;
      ctx.font = th.font(700, px);
      const w = Math.max(20 * u, ctx.measureText(text).width + 9 * u), h = 15 * u;
      ctx.globalAlpha = a.rout ? 0.6 : 1;
      if (extra) extra(w, h, fill);
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
      ctx.fillStyle = css(fill); ctx.fill();
      ctx.lineWidth = 1.5 * u; ctx.strokeStyle = css(th.outline); ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = lum(fill) > 0.42 ? css(th.outline) : '#ffffff';
      ctx.fillText(text, x, y + px * 0.05);
      // Bread left in the wagons.
      const share = clamp(a.food / (a.men * BC.CARRY), 0, 1), bw = w - h * 0.6;
      ctx.fillStyle = css(th.outline, th.dark ? 0.7 : 0.4);
      ctx.fillRect(x - bw / 2, y + h / 2 + 2 * u, bw, 2.4 * u);
      ctx.fillStyle = css(a.hungry ? th.bad : th.grain);
      ctx.fillRect(x - bw / 2, y + h / 2 + 2 * u, a.hungry ? bw : bw * share, 2.4 * u);
      ctx.globalAlpha = 1;
      return [w, h];
    }

    drawColumn(a) {
      const g = this.game, ctx = this.ctx, th = this.theme, u = this.u;
      const p = this.at(a.x, a.y);
      const from = g.keeps[a.path[a.i]], to = g.keeps[a.path[a.i + 1]];
      const ang = Math.atan2(to.y - from.y, to.x - from.x);
      const bob = this.calm || a.state === 'fight' ? 0 : Math.sin(this.t * 9 + a.id) * 1.2;
      if (!this.quietMap && this.sel.has('a' + a.id)) {
        ctx.strokeStyle = css(th.brass); ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]); ctx.lineDashOffset = this.calm ? 0 : -this.t * 16;
        ctx.beginPath(); ctx.arc(p[0], p[1], 17 * u, 0, TAU); ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
      this.token(p[0], p[1] + bob, a, (w, h, fill) => {
        // an arrowhead pointing the way they march
        const d = w / 2 + 6 * u, ax = p[0] + Math.cos(ang) * d, ay = p[1] + bob + Math.sin(ang) * d;
        ctx.beginPath();
        ctx.moveTo(ax + Math.cos(ang) * 5 * u, ay + Math.sin(ang) * 5 * u);
        ctx.lineTo(ax + Math.cos(ang + 2.4) * 5 * u, ay + Math.sin(ang + 2.4) * 5 * u);
        ctx.lineTo(ax + Math.cos(ang - 2.4) * 5 * u, ay + Math.sin(ang - 2.4) * 5 * u);
        ctx.closePath();
        ctx.fillStyle = css(fill); ctx.fill();
        ctx.lineWidth = 1.2 * u; ctx.strokeStyle = css(th.outline); ctx.stroke();
      });
    }

    drawCamp(a) {
      const ctx = this.ctx, th = this.theme, u = this.u;
      const p = this.campAt(a), x = p[0], y = p[1];
      const key = 'c' + a.id;
      if (!this.quietMap && this.sel.has(key)) {
        ctx.strokeStyle = css(th.brass); ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]); ctx.lineDashOffset = this.calm ? 0 : -this.t * 16;
        ctx.beginPath(); ctx.arc(x, y - 3 * u, 19 * u, 0, TAU); ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      } else if (!this.quietMap && this.hover && this.hover.type === 'camp' && this.hover.id === a.id) {
        ctx.strokeStyle = css(th.text, 0.55); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y - 3 * u, 19 * u, 0, TAU); ctx.stroke();
      }
      this.token(x, y, a, (w, h, fill) => {
        // a tent pitched on top
        const ty = y - h / 2;
        ctx.beginPath();
        ctx.moveTo(x - 8 * u, ty + 1); ctx.lineTo(x, ty - 10 * u); ctx.lineTo(x + 8 * u, ty + 1); ctx.closePath();
        ctx.fillStyle = css(fill); ctx.fill();
        ctx.lineWidth = 1.5 * u; ctx.lineJoin = 'round'; ctx.strokeStyle = css(th.outline); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, ty - 10 * u); ctx.lineTo(x, ty + 1); ctx.stroke();
      });
    }

    drawFx(dt) {
      const ctx = this.ctx, th = this.theme, u = this.u;
      for (const r of this.rings) {
        r.life -= dt;
        const t = 1 - r.life / r.max, p = this.at(r.x, r.y);
        ctx.strokeStyle = css(r.c, Math.max(0, 1 - t));
        ctx.lineWidth = 4 * u * (1 - t) + 1;
        ctx.beginPath(); ctx.arc(p[0], p[1], (r.big ? 70 - 44 * t : 16 + 46 * t) * u, 0, TAU); ctx.stroke();
      }
      this.rings = this.rings.filter((r) => r.life > 0);

      for (const s of this.sparks) {
        s.life -= dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vx *= 0.94; s.vy *= 0.94;
        const p = this.at(s.x, s.y);
        ctx.fillStyle = css(s.c, clamp(s.life * 2.5, 0, 1));
        ctx.fillRect(p[0] - 1.5, p[1] - 1.5, 3, 3);
      }
      this.sparks = this.sparks.filter((s) => s.life > 0);

      // Crossed blades where a battle was fought.
      for (const m of this.marks) {
        m.life -= dt;
        const p = this.at(m.x, m.y), a = clamp(m.life * 2, 0, 1), s = 8 * u;
        ctx.lineCap = 'round';
        for (const pass of [[css(th.paper, a), 5 * u], [css(th.bad, a), 2.4 * u]]) {
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
        const t = 1 - f.life / f.max, p = this.at(f.x, f.y);
        ctx.globalAlpha = clamp(f.life * 1.5, 0, 1);
        const px = 12.5 * u, x = clamp(p[0], 90, this.w - 90);
        this.label(f.text, x, p[1] - 22 * u - t * 26 * u, px, css(f.tone === 'good' ? th.good : f.tone === 'bad' ? th.bad : th.text), 700);
        ctx.globalAlpha = 1;
      }
      this.floats = this.floats.filter((f) => f.life > 0);

      if (this.aim && this.aim.text) {
        const g = this.game, k = g.keeps[this.aim.target], p = this.at(k.x, k.y);
        const x = clamp(p[0], 110, this.w - 110), y = Math.max(16, p[1] - this.townR(k) * 1.42 - 14 * u);
        this.label(this.aim.text, x, y, 13 * u, css(this.aim.tone === 'bad' ? th.bad : this.aim.tone === 'good' ? th.good : th.text), 700);
      }
    }

    drawSnow(dt) {
      const ctx = this.ctx, th = this.theme;
      while (this.flakes.length < 46) this.flakes.push({ x: Math.random() * this.w, y: Math.random() * this.h, v: 14 + Math.random() * 22, r: 0.8 + Math.random() * 1.3, p: Math.random() * TAU });
      ctx.fillStyle = css(th.dark ? [236, 240, 244] : [255, 255, 255], th.dark ? 0.5 : 0.85);
      for (const f of this.flakes) {
        f.y += f.v * dt; f.x += Math.sin(this.t * 0.8 + f.p) * 8 * dt;
        if (f.y > this.h + 4) { f.y = -4; f.x = Math.random() * this.w; }
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, TAU); ctx.fill();
      }
    }

    drawBox() {
      const b = this.box, ctx = this.ctx, th = this.theme;
      if (!b) return;
      const x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1), w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0);
      ctx.fillStyle = css(th.brass, 0.12); ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = css(th.brass, 0.9); ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
  }

  BC.Renderer = Renderer;
})();
