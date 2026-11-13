/*
 * Borrowed Crown: the settlements.
 *
 * A village is a huddle of houses behind a palisade, a town has a stone wall and a keep,
 * a city has both and more of each. Every one flies the banner of whoever holds it.
 * Needs THREE (three.js r149). Map (x, y) with height h sits at scene (x, h, y).
 */
(function () {
  'use strict';
  const BC = (window.BC = window.BC || {});

  function hash(a, b) {
    let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  class Towns {
    constructor(THREE, scene, game, terrain) {
      this.T = THREE; this.scene = scene; this.game = game; this.land = terrain;
      this.group = new THREE.Group();
      scene.add(this.group);
      this.theme = null; this.flags = []; this.owners = [];
      this.build();
    }

    build() {
      const T = this.T, L = this.land, g = this.game;
      const stone = new T.MeshLambertMaterial({ color: 0xb9b3a4, flatShading: true });
      const wood = new T.MeshLambertMaterial({ color: 0x8a6a48, flatShading: true });
      const wallMat = new T.MeshLambertMaterial({ color: 0xe6dcc6, flatShading: true });
      const roofMat = new T.MeshLambertMaterial({ color: 0xa5563c, flatShading: true });
      const houses = [];
      for (const site of L.sites) {
        const k = g.keeps[site.id], tier = k.tier, grp = new T.Group();
        grp.position.set(site.x, site.h, site.y);
        this.group.add(grp);

        // The wall: a ring of short straight stretches, with a gap for the gate.
        const segs = 10 + tier * 4, R = site.r - 2, wallH = tier === 1 ? 3.2 : 4.6 + tier, thick = tier === 1 ? 0.9 : 1.8;
        const gateAng = Math.atan2(site.gate[1], site.gate[0]);
        for (let i = 0; i < segs; i++) {
          const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2, am = (a0 + a1) / 2;
          let off = Math.abs(am - gateAng) % (Math.PI * 2); if (off > Math.PI) off = Math.PI * 2 - off;
          if (off < Math.PI / segs) continue;
          const len = 2 * R * Math.sin(Math.PI / segs) + 0.4;
          const m = new T.Mesh(new T.BoxGeometry(len, wallH, thick), tier === 1 ? wood : stone);
          m.position.set(Math.cos(am) * R, wallH / 2, Math.sin(am) * R);
          m.rotation.y = -am + Math.PI / 2;
          grp.add(m);
          if (tier > 1 && i % 2 === 0) {
            const tw = new T.Mesh(new T.CylinderGeometry(1.9, 2.2, wallH + 2.6, 6), stone);
            tw.position.set(Math.cos(a0) * R, (wallH + 2.6) / 2, Math.sin(a0) * R);
            grp.add(tw);
          }
        }

        // The keep, and the pole the banner flies from.
        const kh = tier === 1 ? 5 : tier === 2 ? 11 : 17, kw = tier === 1 ? 5 : tier === 2 ? 7 : 10;
        const keep = new T.Mesh(new T.BoxGeometry(kw, kh, kw), tier === 1 ? wallMat : stone);
        keep.position.set(0, kh / 2, 0);
        grp.add(keep);
        const pole = new T.Mesh(new T.CylinderGeometry(0.22, 0.22, 9, 5), wood);
        pole.position.set(0, kh + 4.5, 0);
        grp.add(pole);
        const cloth = new T.PlaneGeometry(7, 4.2); cloth.translate(3.5, 0, 0);
        const flag = new T.Mesh(cloth, new T.MeshLambertMaterial({ side: T.DoubleSide }));
        flag.position.set(0, kh + 6.6, 0);
        grp.add(flag);
        this.flags.push(flag); this.owners.push(-2);

        // Houses, scattered inside the wall.
        const want = 5 + tier * 8;
        for (let i = 0, made = 0; i < want * 4 && made < want; i++) {
          const ang = hash(site.id, i) * Math.PI * 2, d = kw * 0.9 + 2 + hash(i, site.id + 7) * (R - kw - 6);
          const x = Math.cos(ang) * d, z = Math.sin(ang) * d;
          if (houses.some((o) => o.site === site.id && Math.hypot(o.x - x, o.z - z) < 4.6)) continue;
          houses.push({ site: site.id, x: x, z: z, wx: site.x + x, wy: site.h, wz: site.y + z, rot: hash(i + 3, site.id) * Math.PI, s: 0.85 + hash(i + 9, site.id) * 0.5 });
          made++;
        }
      }
      const body = new T.BoxGeometry(3.4, 2.6, 2.8); body.translate(0, 1.3, 0);
      const roof = new T.ConeGeometry(2.7, 2.2, 4); roof.rotateY(Math.PI / 4); roof.scale(1.1, 1, 0.9); roof.translate(0, 3.7, 0);
      this.bodies = new T.InstancedMesh(body, wallMat, Math.max(1, houses.length));
      this.roofs = new T.InstancedMesh(roof, roofMat, Math.max(1, houses.length));
      const M = new T.Matrix4(), q = new T.Quaternion(), s = new T.Vector3(), p = new T.Vector3(), up = new T.Vector3(0, 1, 0);
      houses.forEach((h, i) => {
        p.set(h.wx, h.wy, h.wz); q.setFromAxisAngle(up, h.rot); s.set(h.s, h.s, h.s);
        M.compose(p, q, s);
        this.bodies.setMatrixAt(i, M); this.roofs.setMatrixAt(i, M);
      });
      this.group.add(this.bodies, this.roofs);
    }

    setTheme(theme) { this.theme = theme; this.owners.fill(-2); }

    /** Called every frame: banners follow their owner and stir in the wind. */
    update(dt, game, t) {
      if (!this.theme) return;
      game.keeps.forEach((k, i) => {
        const flag = this.flags[i];
        if (this.owners[i] !== k.owner) {
          this.owners[i] = k.owner;
          const c = k.owner < 0 ? this.theme.free : this.theme.f[game.factions[k.owner].color];
          flag.material.color.setRGB(c[0] / 255, c[1] / 255, c[2] / 255);
        }
        flag.rotation.y = Math.sin(t * 2.1 + i) * 0.35 - 0.5;
      });
    }

    dispose() {
      this.scene.remove(this.group);
      this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
  }

  BC.Towns = Towns;
})();
