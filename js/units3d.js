/*
 * Borrowed Crown: the men.
 *
 * Every body of soldiers in the simulation is drawn as figures on the ground: garrisons
 * drawn up outside their town, columns on the road, siege camps round the walls, and two
 * lines going at each other wherever a battle is being fought. One figure stands for
 * MEN_PER men. Needs THREE (three.js r149). Map (x, y) with height h sits at scene (x, h, y).
 */
(function () {
  'use strict';
  const BC = (window.BC = window.BC || {});
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const MEN_PER = 10, MAX = 4000;

  function jit(a, b) {
    let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5;
  }

  class Units {
    constructor(THREE, scene, game, terrain) {
      const T = (this.T = THREE);
      this.scene = scene; this.game = game; this.land = terrain; this.theme = null;
      this.group = new T.Group();
      scene.add(this.group);
      const man = new T.BoxGeometry(1.3, 3.2, 1.0); man.translate(0, 1.6, 0);
      this.men = new T.InstancedMesh(man, new T.MeshLambertMaterial({ flatShading: true }), MAX);
      this.men.frustumCulled = false; this.men.count = 0;
      const tent = new T.ConeGeometry(3.2, 3.6, 4); tent.rotateY(Math.PI / 4); tent.translate(0, 1.8, 0);
      this.tents = new T.InstancedMesh(tent, new T.MeshLambertMaterial({ color: 0xe8dfc8, flatShading: true }), 400);
      this.tents.frustumCulled = false; this.tents.count = 0;
      this.group.add(this.men, this.tents);
      this.M = new T.Matrix4(); this.q = new T.Quaternion(); this.s = new T.Vector3(1, 1, 1); this.p = new T.Vector3();
      this.up = new T.Vector3(0, 1, 0); this.C = new T.Color();
      this.n = 0; this.nt = 0;
    }

    setTheme(theme) { this.theme = theme; }

    /** Effects from the simulation (battle started, town taken, and so on). Nothing to do yet. */
    ingest(list) { void list; }

    colour(owner) {
      const th = this.theme, c = owner < 0 ? th.free : th.f[this.game.factions[owner].color];
      return c;
    }

    put(x, y, face, c, lift, lean) {
      if (this.n >= MAX) return;
      const h = Math.max(0.3, this.land.heightAt(x, y));
      this.p.set(x, h + (lift || 0), y);
      this.q.setFromAxisAngle(this.up, -face + Math.PI / 2);
      if (lean) { const tilt = new this.T.Quaternion().setFromAxisAngle(new this.T.Vector3(1, 0, 0), lean); this.q.multiply(tilt); }
      this.men.setMatrixAt(this.n, this.M.compose(this.p, this.q, this.s));
      this.men.setColorAt(this.n, this.C.setRGB(c[0] / 255, c[1] / 255, c[2] / 255));
      this.n++;
    }

    /** A block of `count` figures, `wide` abreast, its front rank centred on (x, y) and facing `face`. */
    block(x, y, face, count, wide, c, t, id, walk) {
      const fx = Math.cos(face), fy = Math.sin(face), gap = 2.3;
      for (let i = 0; i < count; i++) {
        const row = Math.floor(i / wide), colm = (i % wide) - (Math.min(wide, count - row * wide) - 1) / 2;
        const px = x - fx * row * gap - fy * colm * gap + jit(id, i) * 0.5;
        const py = y - fy * row * gap + fx * colm * gap + jit(i, id + 5) * 0.5;
        this.put(px, py, face, c, walk ? Math.abs(Math.sin(t * 9 + i * 1.3)) * 0.35 : 0, 0);
      }
    }

    /** Called every frame: lay every figure out afresh from the state of the simulation. */
    update(dt, game, t) {
      if (!this.theme) return;
      const L = this.land;
      this.n = 0; this.nt = 0;

      // Garrisons, drawn up on the muster ground outside the gate.
      for (const k of game.keeps) {
        if (k.men < 1) continue;
        const site = L.sites[k.id], face = Math.atan2(site.gate[1], site.gate[0]);
        this.block(site.yard[0], site.yard[1], face, clamp(Math.round(k.men / MEN_PER), 1, 96), 8, this.colour(k.owner), t, k.id, false);
      }

      const fighting = new Set();
      for (const b of game.battles) {
        // Two lines facing each other across the point where they met.
        const ang = b.att.army && b.def.army && b.kind === 'field' ? Math.atan2(b.def.army.y - b.att.army.y, b.def.army.x - b.att.army.x) || 0 : 0;
        let dir = ang;
        if (b.at >= 0) { const k = game.keeps[b.at]; dir = Math.atan2(k.y - b.y, k.x - b.x); }
        const sides = [[b.att, dir, -1], [b.def, dir + Math.PI, 1]];
        for (const [s, face, sign] of sides) {
          const pool = s.army || s.keep, men = Math.max(0, Math.min(pool.men, s.men0 - s.dead));
          const count = clamp(Math.round(men / MEN_PER), 1, 140), wide = clamp(Math.ceil(Math.sqrt(count * 2.2)), 4, 18);
          const push = 3.2 + Math.sin(t * 7 + b.id) * 0.8;
          const x = b.x + Math.cos(dir) * sign * push, y = b.y + Math.sin(dir) * sign * push;
          this.block(x, y, face, count, wide, this.colour(s.owner), t, b.id * 31 + sign, true);
          if (s.army) fighting.add(s.army.id);
        }
      }

      for (const a of game.armies) {
        if (a.men < 1 || fighting.has(a.id)) continue;
        const c = this.colour(a.owner), count = clamp(Math.round(a.men / MEN_PER), 1, 160);
        if (a.state === 'camp') {
          // Camped in an arc round the walls, on the side they marched in from, tents behind.
          const site = L.sites[a.at], ang = Math.atan2(a.y - site.y, a.x - site.x), R = site.r + 13;
          for (let i = 0; i < count; i++) {
            const ring = Math.floor(i / 14), slot = (i % 14) - 6.5;
            const th = ang + slot * (2.6 / (R + ring * 2.6)), r = R + ring * 2.6;
            this.put(site.x + Math.cos(th) * r, site.y + Math.sin(th) * r, th + Math.PI, c, 0, 0);
          }
          const tents = clamp(Math.ceil(a.men / 90), 1, 12);
          for (let i = 0; i < tents && this.nt < 400; i++) {
            const th = ang + (i - (tents - 1) / 2) * 0.2, r = R + 16 + (i % 2) * 6;
            const x = site.x + Math.cos(th) * r, y = site.y + Math.sin(th) * r;
            this.p.set(x, Math.max(0.3, L.heightAt(x, y)), y);
            this.q.setFromAxisAngle(this.up, -th);
            this.tents.setMatrixAt(this.nt++, this.M.compose(this.p, this.q, this.s));
          }
        } else {
          const from = game.keeps[a.path[a.i]], to = game.keeps[a.path[a.i + 1]];
          this.block(a.x, a.y, Math.atan2(to.y - from.y, to.x - from.x), count, 4, c, t, a.id, true);
        }
      }

      this.men.count = this.n; this.tents.count = this.nt;
      this.men.instanceMatrix.needsUpdate = true; this.tents.instanceMatrix.needsUpdate = true;
      if (this.men.instanceColor) this.men.instanceColor.needsUpdate = true;
    }

    dispose() {
      this.scene.remove(this.group);
      this.men.geometry.dispose(); this.tents.geometry.dispose();
    }
  }

  BC.Units = Units;
  BC.MEN_PER = MEN_PER;
})();
