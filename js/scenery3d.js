/*
 * Borrowed Crown: the land itself, in three dimensions.
 *
 * Builds the ground mesh, the sea, the roads, the woods and the fields from BC.buildTerrain,
 * tints each province in its owner's colour, and turns the seasons. Needs THREE (three.js r149).
 * Map (x, y) with height h sits at scene (x, h, y).
 */
(function () {
  'use strict';
  const BC = (window.BC = window.BC || {});
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  // Ground colours through the year: spring, summer, autumn, winter.
  const GRASS = [[118, 164, 84], [104, 150, 72], [152, 142, 76], [226, 232, 234]];
  const LEAF = [[92, 150, 70], [70, 126, 58], [176, 118, 50], [214, 222, 226]];
  const PINE = [[54, 104, 70], [48, 96, 64], [58, 96, 62], [176, 196, 196]];
  const CROP = [[[150, 176, 84], [128, 168, 76], [176, 150, 90]], [[196, 184, 96], [120, 160, 70], [206, 178, 88]],
    [[214, 176, 84], [160, 130, 80], [188, 150, 78]], [[226, 230, 230], [214, 220, 222], [220, 226, 226]]];
  const SAND = [214, 198, 150], ROCK = [136, 132, 124], SNOW = [240, 244, 246], DIRT = [158, 130, 94], DEEP = [38, 70, 92];

  class Scenery {
    constructor(THREE, scene, game, terrain) {
      this.T = THREE; this.scene = scene; this.game = game; this.land = terrain;
      this.group = new THREE.Group();
      scene.add(this.group);
      this.theme = null; this.season = game.season; this.blend = 1; this.fromSeason = game.season; this.sincePaint = 0;
      this.paintedVersion = -1;
      this.build();
    }

    build() {
      const T = this.T, L = this.land, n = L.nx * L.nz;
      // Ground: one vertex per grid point, two triangles per cell.
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
      for (let z = 0, i = 0; z < L.nz; z++) for (let x = 0; x < L.nx; x++, i++) {
        pos[i * 3] = Math.min(L.W, x * L.cell); pos[i * 3 + 1] = L.height[i]; pos[i * 3 + 2] = Math.min(L.H, z * L.cell);
      }
      const idx = new Uint32Array((L.nx - 1) * (L.nz - 1) * 6);
      for (let z = 0, p = 0; z < L.nz - 1; z++) for (let x = 0; x < L.nx - 1; x++) {
        const a = z * L.nx + x, b = a + 1, c = a + L.nx, d = c + 1;
        idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d;
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setAttribute('color', new T.BufferAttribute(col, 3));
      g.setIndex(new T.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      this.ground = new T.Mesh(g, new T.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
      this.group.add(this.ground);

      // Slope and coast distance per vertex, used when painting.
      this.slope = new Float32Array(n);
      for (let z = 0, i = 0; z < L.nz; z++) for (let x = 0; x < L.nx; x++, i++) {
        const l = L.height[i - (x > 0 ? 1 : 0)], r = L.height[i + (x < L.nx - 1 ? 1 : 0)];
        const u = L.height[i - (z > 0 ? L.nx : 0)], d = L.height[i + (z < L.nz - 1 ? L.nx : 0)];
        this.slope[i] = Math.hypot(r - l, d - u) / (2 * L.cell);
      }

      // Sea: a wide translucent sheet, so the shallows show the sand under them.
      this.sea = new T.Mesh(new T.PlaneGeometry(L.W + 5000, L.H + 5000), new T.MeshLambertMaterial({ color: 0x4f86a0, transparent: true, opacity: 0.84 }));
      this.sea.rotation.x = -Math.PI / 2;
      this.sea.position.set(L.W / 2, 0, L.H / 2);
      this.group.add(this.sea);

      // Roads: ribbons laid along the draped polylines.
      const rp = [], ri = [];
      for (const road of L.roads) {
        const base = rp.length / 3, pts = road.pts;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
          const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1, px = -dy / d * 2.1, py = dx / d * 2.1;
          rp.push(pts[i][0] + px, pts[i][2], pts[i][1] + py, pts[i][0] - px, pts[i][2], pts[i][1] - py);
          if (i) { const k = base + i * 2; ri.push(k - 2, k - 1, k, k, k - 1, k + 1); }
        }
      }
      const rg = new T.BufferGeometry();
      rg.setAttribute('position', new T.BufferAttribute(new Float32Array(rp), 3));
      rg.setIndex(ri);
      rg.computeVertexNormals();
      this.roads = new T.Mesh(rg, new T.MeshLambertMaterial({ color: 0x9e825e, side: T.DoubleSide }));
      this.group.add(this.roads);

      // Woods: two instanced shapes, coloured per tree so the seasons can turn them.
      const cone = new T.ConeGeometry(2.3, 7.5, 6); cone.translate(0, 4.6, 0);
      const ball = new T.IcosahedronGeometry(2.9, 0); ball.translate(0, 4.4, 0);
      const count = L.trees.length / 5;
      let pines = 0, oaks = 0;
      for (let i = 0; i < count; i++) if (L.trees[i * 5 + 4] === 0) pines++; else oaks++;
      const mat = new T.MeshLambertMaterial({ flatShading: true });
      this.pines = new T.InstancedMesh(cone, mat, Math.max(1, pines));
      this.oaks = new T.InstancedMesh(ball, mat, Math.max(1, oaks));
      const M = new T.Matrix4(), q = new T.Quaternion(), s = new T.Vector3(), p = new T.Vector3(), up = new T.Vector3(0, 1, 0);
      let ip = 0, io = 0;
      for (let i = 0; i < count; i++) {
        const o = i * 5, sc = L.trees[o + 3];
        p.set(L.trees[o], L.trees[o + 2] - 0.3, L.trees[o + 1]); s.set(sc, sc, sc); q.setFromAxisAngle(up, i * 1.7);
        M.compose(p, q, s);
        if (L.trees[o + 4] === 0) this.pines.setMatrixAt(ip++, M); else this.oaks.setMatrixAt(io++, M);
      }
      this.pines.count = pines; this.oaks.count = oaks;
      this.group.add(this.pines, this.oaks);

      // Fields: flat plots, one instance each.
      const plot = new T.PlaneGeometry(1, 1); plot.rotateX(-Math.PI / 2);
      this.fields = new T.InstancedMesh(plot, new T.MeshLambertMaterial(), Math.max(1, L.fields.length));
      L.fields.forEach((f, i) => {
        p.set(f.x, f.h, f.y); s.set(f.w, 1, f.d); q.setFromAxisAngle(up, -f.rot);
        this.fields.setMatrixAt(i, M.compose(p, q, s));
      });
      this.fields.count = L.fields.length;
      this.group.add(this.fields);

      // Light: a sky that fills and a sun that models.
      this.hemi = new T.HemisphereLight(0xffffff, 0x6f7f6a, 0.78);
      this.sun = new T.DirectionalLight(0xfff4e0, 0.78);
      this.sun.position.set(-0.55, 0.9, 0.35);
      scene_add(this.scene, this.hemi, this.sun);
    }

    /** `theme` is the object BC.View3D reads from the page's CSS tokens (rgb arrays plus `dark`). */
    setTheme(theme) {
      const T = this.T;
      this.theme = theme;
      const sky = theme.dark ? [20, 30, 42] : [168, 196, 208];
      this.scene.background = new T.Color(sky[0] / 255, sky[1] / 255, sky[2] / 255);
      this.scene.fog = new T.Fog(this.scene.background.getHex(), 1400, 4200);
      this.hemi.intensity = theme.dark ? 0.5 : 0.78;
      this.hemi.color.setRGB(theme.dark ? 0.62 : 1, theme.dark ? 0.72 : 1, theme.dark ? 0.95 : 1);
      this.sun.intensity = theme.dark ? 0.42 : 0.78;
      this.sun.color.setRGB(theme.dark ? 0.75 : 1, theme.dark ? 0.82 : 0.96, theme.dark ? 1 : 0.88);
      this.sea.material.color.setRGB(theme.dark ? 0.1 : 0.31, theme.dark ? 0.2 : 0.52, theme.dark ? 0.3 : 0.63);
      this.paint();
    }

    /** Recolour the land by who holds each province. Call when game.version changes. */
    paintOwnership() { this.paint(); }

    paint() {
      if (!this.theme) return;
      const L = this.land, g = this.game, th = this.theme, col = this.ground.geometry.attributes.color.array;
      const t = this.blend, a = this.fromSeason, b = this.season;
      const grass = mix(GRASS[a], GRASS[b], t), snowy = (a === 3 ? 1 - t : 0) + (b === 3 ? t : 0);
      const owner = g.keeps.map((k) => k.owner);
      const tint = g.keeps.map((k) => (k.owner < 0 ? null : th.f[g.factions[k.owner].color]));
      const n = L.nx * L.nz;
      for (let i = 0; i < n; i++) {
        const h = L.height[i];
        let c;
        if (!L.land[i]) c = mix(SAND, DEEP, clamp(-h / 9, 0, 1));
        else {
          c = grass;
          const rocky = clamp((this.slope[i] - 0.55) / 0.5, 0, 1) * (1 - snowy * 0.5) + clamp((h - 44) / 16, 0, 1);
          if (rocky > 0) c = mix(c, ROCK, Math.min(1, rocky));
          if (h > 62) c = mix(c, SNOW, clamp((h - 62) / 10, 0, 1));
          const p = L.province[i], tc = tint[p];
          if (tc) c = mix(c, tc, 0.24 * (1 - Math.min(1, rocky)));
          // A darker line where two banners meet.
          const x = i % L.nx, z = (i - x) / L.nx;
          const e = x + 1 < L.nx ? L.province[i + 1] : p, s = z + 1 < L.nz ? L.province[i + L.nx] : p;
          if ((e !== p && owner[e] !== owner[p] && L.land[i + 1]) || (s !== p && owner[s] !== owner[p] && L.land[i + L.nx])) c = mix(c, [30, 34, 40], 0.5);
          if (h < 2.4) c = mix(SAND, c, clamp((h - 0.7) / 1.7, 0, 1));
        }
        col[i * 3] = c[0] / 255; col[i * 3 + 1] = c[1] / 255; col[i * 3 + 2] = c[2] / 255;
      }
      this.ground.geometry.attributes.color.needsUpdate = true;

      const T = this.T, C = new T.Color();
      const leaf = mix(LEAF[a], LEAF[b], t), pine = mix(PINE[a], PINE[b], t);
      for (let i = 0; i < this.pines.count; i++) { const v = 0.86 + ((i * 37) % 17) / 60; this.pines.setColorAt(i, C.setRGB(pine[0] / 255 * v, pine[1] / 255 * v, pine[2] / 255 * v)); }
      for (let i = 0; i < this.oaks.count; i++) { const v = 0.86 + ((i * 53) % 19) / 66; this.oaks.setColorAt(i, C.setRGB(leaf[0] / 255 * v, leaf[1] / 255 * v, leaf[2] / 255 * v)); }
      if (this.pines.instanceColor) this.pines.instanceColor.needsUpdate = true;
      if (this.oaks.instanceColor) this.oaks.instanceColor.needsUpdate = true;
      L.fields.forEach((f, i) => { const c = mix(CROP[a][f.crop], CROP[b][f.crop], t); this.fields.setColorAt(i, C.setRGB(c[0] / 255, c[1] / 255, c[2] / 255)); });
      if (this.fields.instanceColor) this.fields.instanceColor.needsUpdate = true;
      this.paintedVersion = g.version;
      this.sincePaint = 0;
    }

    /** Called every frame. `t` is seconds since the view started. */
    update(dt, game, t) {
      this.sincePaint += dt;
      if (game.season !== this.season) { this.fromSeason = this.season; this.season = game.season; this.blend = 0; }
      if (this.blend < 1) {
        this.blend = Math.min(1, this.blend + dt / 3.5);
        if (this.blend >= 1 || this.sincePaint > 0.2) this.paint();
      } else if (game.version !== this.paintedVersion) this.paint();
      this.sea.position.y = Math.sin(t * 0.7) * 0.12;
    }

    dispose() {
      this.scene.remove(this.group, this.hemi, this.sun);
      this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }
  }

  function scene_add(scene) { for (let i = 1; i < arguments.length; i++) scene.add(arguments[i]); }

  BC.Scenery = Scenery;
})();
