/*
 * Borrowed Crown: the land itself, in three dimensions.
 *
 * Builds everything that is not a town or a soldier from BC.buildTerrain: the ground, the sea
 * and the sky, roads, woods, rocks and fields, the light, and the turn of the seasons. It also
 * shows who holds what: every province is washed with its owner's colour, strongest along the
 * frontier, and a line is laid on the ground wherever two realms meet, a stripe of each realm's
 * colour either side of a thread of ink. Provinces under one owner run together with no line.
 *
 * Needs THREE (three.js r149). Map (x, y) with height h sits at scene (x, h, y).
 *
 * What it costs: ten draw calls (eleven while it snows) and about 95,000 triangles on a full-size
 * map, with no shadow maps. Nothing here allocates per frame. Colours are repainted on the CPU only
 * while a season or an owner is changing, a few times a second; the sea, the snow and the sway of
 * the trees are a few lines of shader each, and all three hold still for anyone who has asked for
 * reduced motion.
 *
 * The scene's light, fog and background are set here, so the towns and the men are lit by the
 * same sun as the hills: clear day in the light theme, moonlit dusk in the dark one.
 */
(function () {
  'use strict';
  const BC = (window.BC = window.BC || {});
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const hash = (a, b) => {
    let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  // The year's colours: spring, summer, autumn, winter. Winter's are the ground under the snow.
  const MEADOW = [[130, 156, 102], [118, 144, 94], [152, 144, 98], [128, 130, 108]];
  const HEATH = [[144, 152, 108], [136, 140, 98], [158, 138, 96], [134, 128, 108]];
  const FELL = [[148, 144, 114], [146, 138, 108], [152, 132, 102], [136, 130, 114]];
  const FLOOR = [[92, 122, 84], [80, 110, 76], [120, 106, 74], [106, 112, 100]];
  const LEAF = [
    [[108, 152, 80], [124, 162, 88], [96, 142, 76], [226, 204, 208]],
    [[74, 122, 66], [86, 132, 70], [66, 112, 62], [80, 126, 62]],
    [[198, 134, 50], [176, 94, 44], [210, 164, 62], [150, 112, 52]],
    [[150, 140, 130], [138, 130, 124], [158, 148, 136], [144, 134, 122]],
  ];
  const PINE = [[58, 108, 74], [50, 98, 66], [56, 96, 62], [58, 92, 72]];
  const CROP = [
    [[142, 172, 88], [156, 134, 98], [170, 184, 104]],
    [[196, 182, 100], [118, 156, 74], [214, 190, 104]],
    [[208, 170, 84], [150, 120, 82], [186, 150, 80]],
    [[224, 228, 226], [202, 202, 196], [214, 218, 216]],
  ];
  const HEDGE = [[76, 118, 62], [62, 102, 56], [112, 100, 58], [104, 98, 86]];
  const TRACK = [[164, 136, 100], [172, 144, 104], [160, 130, 94], [136, 118, 100]];
  const SAND = [218, 204, 160], ROCK = [150, 146, 138], CRAG = [122, 118, 112], SNOW = [238, 243, 247], EARTH = [156, 132, 98];
  const SHOAL = [196, 190, 152], DEPTHS = [70, 104, 116];
  // Sunlight and skylight through the year: r, g, b, strength. Winter is flatter and duller.
  const SUNLIGHT = [[1, 0.97, 0.9, 0.7], [1, 0.96, 0.86, 0.74], [1, 0.9, 0.76, 0.7], [0.9, 0.94, 1, 0.44]];
  const SKYLIGHT = [[1, 1, 1, 0.58], [1, 1, 1, 0.58], [1, 0.97, 0.92, 0.56], [0.92, 0.96, 1, 0.68]];
  // Where the sun stands: low in the west-south-west, so slopes model well from the usual camera.
  const SUN = [-0.7, 0.6, 0.38];

  const SEA_VERT = [
    'uniform float uTime;',
    'uniform vec4 uMap;',
    'varying vec3 vWorld;',
    '#include <fog_pars_vertex>',
    'void main() {',
    '  vec3 p = position;',
    // The swell dies away past the edge of the map, where the sheet is too coarse to carry it.
    '  float swell = 1.0 - smoothstep(20.0, 150.0, length(max(abs(p.xz - uMap.xy * 0.5) - uMap.xy * 0.5, 0.0)));',
    '  p.y += (sin(p.x * 0.043 + uTime * 0.9) + sin(p.z * 0.057 - uTime * 0.74) + sin((p.x + p.z) * 0.031 + uTime * 0.53)) * 0.17 * swell;',
    '  vWorld = p;',
    '  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  #include <fog_vertex>',
    '}',
  ].join('\n');
  const SEA_FRAG = [
    'uniform sampler2D uShore;',
    'uniform float uTime;',
    'uniform vec4 uMap;',
    'uniform vec2 uHalf;',
    'uniform vec3 uDeep;',
    'uniform vec3 uShallow;',
    'uniform vec3 uFoam;',
    'uniform vec3 uLake;',
    'uniform vec3 uSun;',
    'varying vec3 vWorld;',
    '#include <fog_pars_fragment>',
    'void main() {',
    '  vec2 uv = clamp(vWorld.xz * uMap.zw + uHalf, 0.0, 1.0);',
    '  vec4 chart = texture2D(uShore, uv);',
    '  float d = chart.r * 80.0 - 16.0;',
    '  float lake = chart.g;',
    // Faceted swell: each triangle of the sea catches the light a little differently.
    '  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));',
    '  if (n.y < 0.0) n = -n;',
    '  float glint = dot(normalize(vec3(n.x * 22.0, n.y, n.z * 22.0)), uSun) - uSun.y;',
    '  vec3 col = mix(uShallow, uDeep, smoothstep(0.0, 24.0, d) * 0.76 + 0.24 * smoothstep(16.0, 64.0, d));',
    // Out past the edge of the map the water deepens once more.
    '  col *= 1.0 - 0.2 * smoothstep(0.0, 800.0, length(max(abs(vWorld.xz - uMap.xy * 0.5) - uMap.xy * 0.42, 0.0)));',
    // Lakes are stiller and darker than the sea, and no surf comes in on them.
    '  col = mix(col, uLake * (0.8 + 0.5 * smoothstep(9.0, 0.0, d)), lake) * (1.0 + glint * (0.28 - 0.16 * lake));',
    // Surf: a line of foam on the beach and broken rollers coming in behind it.
    '  float wob = sin(vWorld.x * 0.09 + uTime * 0.21) * sin(vWorld.z * 0.11 - uTime * 0.17);',
    '  float roll = sin(d * 0.62 - uTime * 1.05 + wob * 2.2);',
    '  float gap = smoothstep(0.1, 0.7, sin(vWorld.x * 0.05 + vWorld.z * 0.037 + wob * 1.7));',
    '  float foam = smoothstep(0.88, 0.99, roll) * smoothstep(12.0, 3.5, d) * gap * 0.4 * (1.0 - lake) + smoothstep(1.5, 0.4, d + wob * 0.4) * (0.85 - 0.5 * lake);',
    // A few whitecaps out on open water.
    '  float chop = sin(vWorld.x * 0.19 + uTime * 0.6 + wob * 3.0) * sin(vWorld.z * 0.23 - uTime * 0.45 + wob * 2.0) * sin((vWorld.x - vWorld.z) * 0.071 + uTime * 0.2);',
    '  foam += smoothstep(0.86, 0.97, chop) * smoothstep(10.0, 34.0, d) * 0.24 * (1.0 - lake) * (1.0 - smoothstep(60.0, 420.0, length(max(abs(vWorld.xz - uMap.xy * 0.5) - uMap.xy * 0.5, 0.0))));',
    '  foam = clamp(foam, 0.0, 1.0);',
    '  col = mix(col, uFoam, foam);',
    '  float alpha = max(mix(0.56 + 0.14 * lake, 1.0, smoothstep(0.0, 10.0, d)), foam);',
    '  gl_FragColor = vec4(col, alpha);',
    '  #include <fog_fragment>',
    '}',
  ].join('\n');

  const SKY_VERT = [
    'varying vec3 vDir;',
    'void main() {',
    '  vDir = position;',
    // Turn with the camera but never move with it, and sit on the far plane.
    '  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);',
    '  gl_Position = p.xyww;',
    '}',
  ].join('\n');
  const SKY_FRAG = [
    'uniform vec3 uZenith;',
    'uniform vec3 uHorizon;',
    'uniform vec3 uGlow;',
    'uniform vec3 uSun;',
    'varying vec3 vDir;',
    'void main() {',
    '  vec3 d = normalize(vDir);',
    '  float up = clamp(d.y, 0.0, 1.0);',
    '  vec3 col = mix(uHorizon, uZenith, 1.0 - pow(1.0 - up, 3.0));',
    '  float toward = max(dot(normalize(d.xz + vec2(0.0001)), normalize(uSun.xz)), 0.0);',
    '  col += uGlow * pow(toward, 4.0) * pow(1.0 - up, 6.0);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}',
  ].join('\n');

  const EDGE_VERT = [
    'attribute vec3 aSide;',
    'attribute float aLat;',
    'attribute vec3 aTint;',
    'uniform vec3 uLine;',
    'varying vec3 vTint;',
    '#include <fog_pars_vertex>',
    'void main() {',
    // Each stripe keeps its width on the ground up close, and never thins below a couple of pixels far off.
    '  float depth = -(modelViewMatrix * vec4(position, 1.0)).z;',
    '  float px = depth * uLine.x;',
    '  float w = clamp(uLine.y, px * uLine.z, px * uLine.z * 2.2);',
    '  vec3 p = position + aSide * (aLat * w);',
    '  p.y += max(0.0, w - uLine.y) * 0.2;',
    '  vTint = aTint;',
    '  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  #include <fog_vertex>',
    '}',
  ].join('\n');
  const EDGE_FRAG = [
    'varying vec3 vTint;',
    '#include <fog_pars_fragment>',
    'void main() {',
    '  gl_FragColor = vec4(vTint, 1.0);',
    '  #include <fog_fragment>',
    '}',
  ].join('\n');

  const SNOW_VERT = [
    'attribute float aSeed;',
    'uniform float uTime;',
    'uniform vec3 uFlake;',
    'void main() {',
    '  vec3 p = position;',
    '  p.y = mod(p.y - uTime * (6.0 + aSeed * 5.0), uFlake.x);',
    '  p.x += sin(uTime * 0.7 + aSeed * 40.0) * 3.0;',
    '  p.z += cos(uTime * 0.5 + aSeed * 23.0) * 3.0;',
    '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
    '  gl_Position = projectionMatrix * mv;',
    '  gl_PointSize = clamp(uFlake.y / -mv.z, 1.0, 3.2) * uFlake.z;',
    '}',
  ].join('\n');
  const SNOW_FRAG = [
    'uniform vec4 uTone;',
    'void main() {',
    '  vec2 c = gl_PointCoord - 0.5;',
    '  float a = uTone.a * smoothstep(0.5, 0.2, length(c));',
    '  if (a < 0.02) discard;',
    '  gl_FragColor = vec4(uTone.rgb, a);',
    '}',
  ].join('\n');

  /** Height at (x, z) on the triangle a, b, c of a position array, or NaN when the point lies outside it. */
  function facet(P, a, b, c, x, z) {
    const ax = P[a * 3], az = P[a * 3 + 2], bx = P[b * 3] - ax, bz = P[b * 3 + 2] - az, cx = P[c * 3] - ax, cz = P[c * 3 + 2] - az;
    const det = bx * cz - cx * bz, px = x - ax, pz = z - az, u = (px * cz - cx * pz) / det, v = (bx * pz - px * bz) / det;
    if (u < -1e-4 || v < -1e-4 || u + v > 1.0001) return NaN;
    return P[a * 3 + 1] + u * (P[b * 3 + 1] - P[a * 3 + 1]) + v * (P[c * 3 + 1] - P[a * 3 + 1]);
  }
  const AROUND = [0, 0, 1, 0, -1, 0, 0, 1, 0, -1, 1, 1, -1, 1, 1, -1, -1, -1];

  /** Collects triangles for one small merged shape: positions, a shade, and how much snow each vertex takes. */
  class Shape {
    constructor() { this.p = []; this.c = []; this.s = []; }
    /** `tone(y)` gives the shade of a vertex and `snow(y)` its share of snow; snow of -1 marks bark. */
    add(geom, tone, snow) {
      const g = geom.index ? geom.toNonIndexed() : geom, a = g.attributes.position;
      for (let i = 0; i < a.count; i++) {
        const y = a.getY(i), v = tone(y);
        this.p.push(a.getX(i), y, a.getZ(i)); this.c.push(v, v, v); this.s.push(snow(y));
      }
      if (g !== geom) g.dispose();
      geom.dispose();
      return this;
    }
    build(T) {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(this.p, 3));
      g.setAttribute('color', new T.Float32BufferAttribute(this.c, 3));
      g.setAttribute('aSnow', new T.Float32BufferAttribute(this.s, 1));
      g.computeVertexNormals();
      return g;
    }
  }

  class Scenery {
    constructor(THREE, scene, game, terrain) {
      this.T = THREE; this.scene = scene; this.game = game; this.land = terrain;
      this.group = new THREE.Group();
      scene.add(this.group);
      this.theme = null;
      this.season = game.season; this.fromSeason = game.season; this.blend = 1;
      this.sincePaint = 0; this.dirty = true; this.paintedVersion = -1; this.easing = false;
      this.camera = null; this.viewH = 800; this.dpr = 1;
      this.calm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      this.uSnow = { value: 0 }; this.uBark = { value: new THREE.Color(0.42, 0.32, 0.24) };
      this.uTime = { value: 0 };
      this.grey = new THREE.Color(); this.haze = new THREE.Color();
      this.build();
    }

    /* ----- building ----- */

    build() {
      this.buildGround();
      this.buildSea();
      this.buildSky();
      this.buildRoads();
      this.buildBorders();
      this.buildFields();
      this.buildWoods();
      this.buildSnowfall();
      const T = this.T;
      this.hemi = new T.HemisphereLight(0xffffff, 0x7f8a74, 0.62);
      this.sun = new T.DirectionalLight(0xfff4e0, 0.8);
      this.sun.position.set(SUN[0], SUN[1], SUN[2]);
      // A weak cool light from the far side, so the faces the sun misses still show their shape.
      this.fill = new T.DirectionalLight(0xc4d8ff, 0.16);
      this.fill.position.set(0.62, 0.34, -0.55);
      this.scene.add(this.hemi, this.sun, this.fill);
    }

    /**
     * A Lambert material that can carry snow on the upper side of whatever it draws, and bark on trunks.
     * With `sway` its instances also lean a little in the wind, more the higher up they go.
     */
    snowy(sway) {
      const m = new this.T.MeshLambertMaterial({ vertexColors: true, flatShading: true });
      const uSnow = this.uSnow, uBark = this.uBark, uTime = this.uTime;
      const lean = sway ? [
        '#ifdef USE_INSTANCING',
        'float bcGust = instanceMatrix[3].x * 0.031 + instanceMatrix[3].z * 0.027;',
        'float bcBend = transformed.y * transformed.y * 0.0042;',
        'transformed.x += sin(uTime * 1.1 + bcGust) * bcBend;',
        'transformed.z += sin(uTime * 0.83 + bcGust * 1.7) * bcBend * 0.7;',
        '#endif',
      ].join('\n') : '';
      // three.js tells patched programs apart by this key, and the two kinds must not share one.
      m.customProgramCacheKey = () => 'bc-land-' + (sway ? 'sway' : 'still');
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uSnow = uSnow; shader.uniforms.uBark = uBark; shader.uniforms.uTime = uTime;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float aSnow;\nuniform float uTime;\nvarying float vSnow;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSnow = aSnow;\n' + lean);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uSnow;\nuniform vec3 uBark;\nvarying float vSnow;')
          .replace('#include <color_fragment>', '#include <color_fragment>\nif (vSnow < -0.5) diffuseColor.rgb = uBark;\nelse diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.97), smoothstep(1.06 - uSnow * 0.8, 1.3 - uSnow * 0.8, vSnow));');
      };
      return m;
    }

    buildGround() {
      const T = this.T, L = this.land, nx = L.nx, nz = L.nz, n = nx * nz, cell = L.cell, K = this.game.keeps;
      const seed = this.game.seed | 0;
      // One vertex per grid point, nudged off the grid so the facets do not line up in rows. Round the towns and
      // along the roads the grid is left true: there terrain.heightAt and the drawn ground are the same surface,
      // so men placed by one stand exactly on the other.
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), road = L.fromRoad;
      for (let z = 0, i = 0; z < nz; z++) for (let x = 0; x < nx; x++, i++) {
        const gx = Math.min(L.W, x * cell), gz = Math.min(L.H, z * cell), site = L.sites[L.province[i]];
        const edge = x === 0 || z === 0 || x === nx - 1 || z === nz - 1;
        const loose = edge ? 0 : cell * 0.5 * smooth(18, 46, road[i]) * smooth(site.r + 34, site.r + 64, Math.hypot(gx - site.x, gz - site.y));
        const px = gx + (hash(x + seed, z) - 0.5) * loose, pz = gz + (hash(z + seed, x + 977) - 0.5) * loose;
        pos[i * 3] = px; pos[i * 3 + 1] = L.heightAt(px, pz); pos[i * 3 + 2] = pz;
      }
      // Two triangles per cell, cut the way the terrain says (along the flatter diagonal).
      // Cells of deep sea bed are left out: the water there is opaque, and nothing shows the edge of the mesh.
      const idx = new (n > 65535 ? Uint32Array : Uint16Array)((nx - 1) * (nz - 1) * 6);
      let p = 0;
      for (let z = 0; z < nz - 1; z++) for (let x = 0; x < nx - 1; x++) {
        const a = z * nx + x, b = a + 1, c = a + nx, d = c + 1;
        if (Math.max(pos[a * 3 + 1], pos[b * 3 + 1], pos[c * 3 + 1], pos[d * 3 + 1]) < -4.6) continue;
        if (L.split[z * (nx - 1) + x]) { idx[p++] = a; idx[p++] = c; idx[p++] = d; idx[p++] = a; idx[p++] = d; idx[p++] = b; }
        else { idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d; }
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setAttribute('color', new T.BufferAttribute(col, 3));
      g.setIndex(new T.BufferAttribute(idx.subarray(0, p), 1));
      g.computeVertexNormals();
      this.ground = new T.Mesh(g, new T.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
      this.group.add(this.ground);

      // What each vertex is made of, worked out once; paint() only mixes colours.
      const H = L.height;
      const rock = this.rock = new Float32Array(n), cap = this.cap = new Float32Array(n), sand = this.sand = new Float32Array(n);
      const heath = this.heath = new Float32Array(n), wood = this.wood = new Float32Array(n), bare = this.bare = new Float32Array(n);
      const fell = this.fell = new Float32Array(n), inland = this.inland = new Float32Array(n);
      // Which water is nearest each bit of shore: the sea leaves a beach, a lake a green bank.
      for (let z = 0, i = 0; z < nz; z++) for (let x = 0; x < nx; x++, i++) {
        if (!L.land[i] || L.shore[i] < -30) continue;
        let sea = 1e9, lake = 1e9;
        for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
          const ax = x + dx, az = z + dz;
          if (ax < 0 || az < 0 || ax >= nx || az >= nz) continue;
          const w = L.water[az * nx + ax], dd = dx * dx + dz * dz;
          if (w === 1 && dd < sea) sea = dd; else if (w === 2 && dd < lake) lake = dd;
        }
        inland[i] = lake < sea ? 1 : 0;
      }
      const shade = this.shade = new Float32Array(n), frost = this.frost = new Float32Array(n), vary = this.vary = new Float32Array(n);
      const near1 = this.near1 = new Uint8Array(n), near2 = this.near2 = new Uint8Array(n);
      const gap1 = this.gap1 = new Float32Array(n), gap2 = this.gap2 = new Float32Array(n);
      this.edge = new Float32Array(n);
      const noise = (x, y, s) => {
        const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
        const a = hash(ix + s * 131, iy), b = hash(ix + 1 + s * 131, iy), c = hash(ix + s * 131, iy + 1), d = hash(ix + 1 + s * 131, iy + 1);
        return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
      };
      const ringX = [2, 2, 0, -2, -2, -2, 0, 2], ringZ = [0, 2, 2, 2, 0, -2, -2, -2];
      // Long shadows, in one sweep away from the sun: each vertex takes the height of the shadow passing over it
      // from the ground one step sunward, which was worked out just before it.
      const hl = Math.hypot(SUN[0], SUN[2]), sx = SUN[0] / hl, sz = SUN[2] / hl, drop = SUN[1] / hl * cell, veil = new Float32Array(n);
      const ox = Math.floor(sx), oz = Math.floor(sz), fx = sx - ox, fz = sz - oz;
      const under = (x, z, self) => {
        if (x < 0 || z < 0 || x >= nx || z >= nz) return -30;
        const j = z * nx + x;
        return j === self ? Math.max(0, H[j]) : Math.max(0, H[j], veil[j]);
      };
      for (let a = 0; a < nz; a++) for (let b = 0; b < nx; b++) {
        const x = sx < 0 ? b : nx - 1 - b, z = sz < 0 ? a : nz - 1 - a, i = z * nx + x;
        veil[i] = under(x + ox, z + oz, i) * (1 - fx) * (1 - fz) + under(x + ox + 1, z + oz, i) * fx * (1 - fz)
          + under(x + ox, z + oz + 1, i) * (1 - fx) * fz + under(x + ox + 1, z + oz + 1, i) * fx * fz - drop;
      }
      const apart = new Float32Array(K.length * K.length);
      for (let a = 0; a < K.length; a++) for (let b = 0; b < K.length; b++) apart[a * K.length + b] = Math.hypot(K[a].x - K[b].x, K[a].y - K[b].y);
      for (let z = 0, i = 0; z < nz; z++) for (let x = 0; x < nx; x++, i++) {
        const wx = pos[i * 3], wz = pos[i * 3 + 2], h = H[i];
        near1[i] = near2[i] = 255;
        if (!L.land[i]) continue;
        const l = H[i - (x > 0 ? 1 : 0)], r = H[i + (x < nx - 1 ? 1 : 0)], u = H[i - (z > 0 ? nx : 0)], d = H[i + (z < nz - 1 ? nx : 0)];
        const slope = Math.hypot(r - l, d - u) / (2 * cell), patch = noise(wx / 46, wz / 46, seed + 3);
        // Bare rock on the heights and on steep faces; low hills keep their turf unless they are very steep.
        const scar = lerp(1.02, 0.7, smooth(18, 44, h));
        rock[i] = clamp(smooth(scar, scar + 0.5, slope) + smooth(50, 62, h + patch * 10), 0, 1);
        fell[i] = smooth(24, 42, h + patch * 8);
        cap[i] = smooth(57, 66, h + patch * 7) * (1 - 0.5 * smooth(0.9, 1.5, slope));
        sand[i] = smooth(2.7, 1.1, h) * smooth(-22, -8, L.shore[i]) * (1 - 0.85 * inland[i]);
        inland[i] *= smooth(-20, -5, L.shore[i]);
        heath[i] = clamp(smooth(9, 30, h) * 0.8 + (patch - 0.5) * 0.9, 0, 1);
        vary[i] = (noise(wx / 19, wz / 19, seed + 5) - 0.5) * 1.2 + (noise(wx / 64, wz / 64, seed + 9) - 0.5) * 1.6;
        // Snow settles on the heights first, and last on steep ground and by the sea.
        frost[i] = clamp(0.62 - h / 90 + smooth(0.5, 1.1, slope) * 0.3 + sand[i] * 0.25 + (noise(wx / 27, wz / 27, seed + 7) - 0.5) * 0.3, 0.05, 0.95);

        // Trodden earth inside the walls, on the muster ground and along the roads.
        const site = L.sites[L.province[i]];
        const dirt = Math.max(smooth(site.r + 2, site.r - 6, Math.hypot(wx - site.x, wz - site.y)), 0.75 * smooth(17, 8, Math.hypot(wx - site.yard[0], wz - site.yard[1])));
        bare[i] = Math.max(dirt, 0.4 * smooth(8, 2.5, road[i]));

        // Baked light: hollows a little darker, crests a little lighter, and the long shadows the hills throw.
        let ring = 0, cnt = 0;
        for (let k = 0; k < 8; k++) {
          const ax = x + ringX[k], az = z + ringZ[k];
          if (ax >= 0 && az >= 0 && ax < nx && az < nz) { ring += Math.max(0, H[az * nx + ax]); cnt++; }
        }
        const hollow = clamp((ring / cnt - h) / 7, -1, 1), dark = clamp((veil[i] - h - 0.5) / 7, 0, 1);
        // A slope already turned from the sun is dark enough without the cast shadow on top.
        const facing = (-(r - l) / (2 * cell) * SUN[0] + SUN[1] - (d - u) / (2 * cell) * SUN[2]) / Math.hypot((r - l) / (2 * cell), 1, (d - u) / (2 * cell));
        shade[i] = (1 - 0.3 * dark * smooth(-0.1, 0.45, facing)) * (hollow > 0 ? 1 - 0.14 * hollow : 1 - 0.06 * hollow);

        // The two nearest neighbouring provinces and how far off their frontiers are, for the wash of colour along a border.
        const me = L.province[i], dm = (wx - K[me].x) ** 2 + (wz - K[me].y) ** 2;
        let b1 = 1e9, b2 = 1e9;
        for (let k = 0; k < K.length; k++) {
          if (k === me) continue;
          const gap = ((wx - K[k].x) ** 2 + (wz - K[k].y) ** 2 - dm) / (2 * apart[me * K.length + k]);
          if (gap < b1) { b2 = b1; near2[i] = near1[i]; b1 = gap; near1[i] = k; } else if (gap < b2) { b2 = gap; near2[i] = k; }
        }
        gap1[i] = b1; gap2[i] = b2;
      }
      // Woodland floor: darker ground wherever trees stand close together.
      const tr = L.trees;
      for (let i = 0; i < tr.length; i += 5) {
        const gx = tr[i] / cell, gz = tr[i + 1] / cell, ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz;
        if (ix < 0 || iz < 0 || ix >= nx - 1 || iz >= nz - 1) continue;
        const v = iz * nx + ix;
        wood[v] += (1 - fx) * (1 - fz); wood[v + 1] += fx * (1 - fz); wood[v + nx] += (1 - fx) * fz; wood[v + nx + 1] += fx * fz;
      }
      for (let i = 0; i < n; i++) wood[i] = Math.min(1, wood[i] * 1.5);
      // Realm colours ease in and out, so a town changing hands washes over the map instead of snapping.
      this.wash = new Float32Array(K.length * 4);
      this.washTo = new Float32Array(K.length * 4);
      this.owner = new Int16Array(K.length).fill(-2);
    }

    /**
     * Height of the drawn ground under a map point. The mesh is nudged off the terrain's grid, so this finds
     * the very facet the point stands on; whatever is set down with it neither floats nor sinks.
     */
    surface(x, z) {
      const L = this.land, nx = L.nx, nz = L.nz, P = this.ground.geometry.attributes.position.array;
      const cx = clamp(Math.floor(x / L.cell), 0, nx - 2), cz = clamp(Math.floor(z / L.cell), 0, nz - 2);
      for (let k = 0; k < 18; k += 2) {
        const ix = cx + AROUND[k], iz = cz + AROUND[k + 1];
        if (ix < 0 || iz < 0 || ix > nx - 2 || iz > nz - 2) continue;
        const a = iz * nx + ix, b = a + 1, c = a + nx, d = c + 1, cut = L.split[iz * (nx - 1) + ix];
        let h = cut ? facet(P, a, c, d, x, z) : facet(P, a, c, b, x, z);
        if (h !== h) h = cut ? facet(P, a, d, b, x, z) : facet(P, b, c, d, x, z);
        if (h === h) return h;
      }
      return L.heightAt(x, z);
    }

    buildSea() {
      const T = this.T, L = this.land;
      // Shore distance as a texture, so the water knows where the shallows and the surf are.
      const data = new Uint8Array(L.nx * L.nz * 4);
      for (let i = 0; i < L.nx * L.nz; i++) {
        data[i * 4] = clamp(Math.round((L.shore[i] + 16) / 80 * 255), 0, 255);
        data[i * 4 + 1] = L.water[i] === 2 || (L.land[i] && this.inland[i] > 0.5) ? 255 : 0;
        data[i * 4 + 3] = 255;
      }
      this.shoreTex = new T.DataTexture(data, L.nx, L.nz, T.RGBAFormat);
      this.shoreTex.magFilter = this.shoreTex.minFilter = T.LinearFilter;
      this.shoreTex.needsUpdate = true;

      // One sheet: fine round the island so the swell shows, stretching out to the horizon in a few wide strides.
      const nu = 80, nv = 54, inner = 0.8, far = 9000, pos = new Float32Array((nu + 1) * (nv + 1) * 3), idx = [];
      const spread = (t, half) => {
        const a = Math.abs(t), d = a <= inner ? (a / inner) * (half + 170) : half + 170 + Math.pow((a - inner) / (1 - inner), 2.4) * far;
        return t < 0 ? -d : d;
      };
      for (let v = 0, i = 0; v <= nv; v++) for (let u = 0; u <= nu; u++, i++) {
        pos[i * 3] = L.W / 2 + spread(u / nu * 2 - 1, L.W / 2);
        pos[i * 3 + 2] = L.H / 2 + spread(v / nv * 2 - 1, L.H / 2);
        if (u < nu && v < nv) { const a = i, b = i + 1, c = i + nu + 1, d = c + 1; if ((u + v) % 2) idx.push(a, c, b, b, c, d); else idx.push(a, c, d, a, d, b); }
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setIndex(idx);
      const uniforms = T.UniformsUtils.merge([T.UniformsLib.fog, {
        uShore: { value: null }, uMap: { value: new T.Vector4(L.W, L.H, 1 / (L.nx * L.cell), 1 / (L.nz * L.cell)) },
        uHalf: { value: new T.Vector2(0.5 / L.nx, 0.5 / L.nz) },
        uDeep: { value: new T.Color() }, uShallow: { value: new T.Color() }, uFoam: { value: new T.Color() }, uLake: { value: new T.Color() },
        uSun: { value: new T.Vector3(SUN[0], SUN[1], SUN[2]).normalize() },
      }]);
      uniforms.uShore.value = this.shoreTex; uniforms.uTime = this.uTime;
      this.sea = new T.Mesh(g, new T.ShaderMaterial({
        uniforms: uniforms, vertexShader: SEA_VERT, fragmentShader: SEA_FRAG, fog: true, transparent: true, depthWrite: false,
        extensions: { derivatives: true },
      }));
      this.sea.frustumCulled = false;
      this.sea.renderOrder = -1;                 // before anything else see-through, so smoke and dust drift over it
      this.group.add(this.sea);
    }

    buildSky() {
      const T = this.T;
      const mat = new T.ShaderMaterial({
        uniforms: { uZenith: { value: new T.Color() }, uHorizon: { value: new T.Color() }, uGlow: { value: new T.Color() }, uSun: { value: new T.Vector3(SUN[0], SUN[1], SUN[2]).normalize() } },
        vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: T.BackSide, depthWrite: false, fog: false,
      });
      // Only the upper half: below the horizon there is always sea, and no need to shade the sky behind it.
      this.sky = new T.Mesh(new T.SphereGeometry(1, 20, 6, 0, Math.PI * 2, 0, Math.PI / 2 + 0.05), mat);
      this.sky.frustumCulled = false;
      this.sky.renderOrder = 10;                 // after the solid world, so it only fills what is left
      // The renderer hands every object the camera as it draws it: that is how the land learns where it is seen from.
      this.sky.onBeforeRender = (renderer, scene, camera) => {
        this.camera = camera; this.viewH = renderer.domElement.height; this.dpr = renderer.getPixelRatio();
      };
      this.group.add(this.sky);
    }

    /** A ribbon along a polyline, `across` giving [offset, shade] for each line of vertices from one side to the other. */
    ribbon(lines, across, lift) {
      const T = this.T, pos = [], col = [], idx = [], m = across.length;
      for (const pts of lines) {
        const base = pos.length / 3;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
          const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1, px = -dy / d, py = dx / d;
          for (let j = 0; j < m; j++) {
            const x = pts[i][0] + px * across[j][0], y = pts[i][1] + py * across[j][0], v = across[j][1];
            pos.push(x, Math.max(0.3, this.surface(x, y)) + lift, y); col.push(v, v, v);
          }
          if (i) for (let j = 0; j < m - 1; j++) { const k = base + i * m + j; idx.push(k - m, k - m + 1, k, k, k - m + 1, k + 1); }
        }
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    }

    buildRoads() {
      const T = this.T, L = this.land;
      // A worn middle and darker verges, laid just clear of the ground. Each road stops at the walls: the streets
      // inside belong to the town. The beds are smooth enough that every other point of the road will do.
      const lines = L.roads.map((r) => {
        const pts = r.pts, a = pts[0], b = pts[pts.length - 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const t0 = Math.min(0.45, (L.sites[r.a].r - 1.5) / len), t1 = 1 - Math.min(0.45, (L.sites[r.b].r - 1.5) / len), out = [];
        const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        out.push(at(t0));
        for (let i = 2; i < pts.length - 1; i += 2) { const t = i / (pts.length - 1); if (t > t0 + 0.02 && t < t1 - 0.02) out.push(pts[i]); }
        out.push(at(t1));
        return out;
      });
      const g = this.ribbon(lines, [[-2.5, 0.8], [-1.5, 1], [1.5, 1], [2.5, 0.8]], 0.18);
      this.roads = new T.Mesh(g, new T.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      this.group.add(this.roads);
    }

    buildBorders() {
      const T = this.T, L = this.land, K = this.game.keeps, B = L.borders;
      let count = 0;
      for (const b of B) count += b.pts.length;
      // Six vertices across: a stripe for each realm, with a thin line of ink between them.
      const pos = new Float32Array(count * 18), side = new Float32Array(count * 18), lat = new Float32Array(count * 6);
      this.edgeTint = new Float32Array(count * 18);
      this.edgeIndex = new (count * 6 > 65535 ? Uint32Array : Uint16Array)(Math.max(1, count) * 18);
      this.edgeRuns = [];
      const across = [-1, -0.2, -0.2, 0.2, 0.2, 1];
      let v = 0;
      for (const b of B) {
        const a = K[b.a], c = K[b.b], dl = Math.hypot(c.x - a.x, c.y - a.y), nx = (c.x - a.x) / dl, ny = (c.y - a.y) / dl;
        this.edgeRuns.push({ a: b.a, b: b.b, first: v, n: b.pts.length });   // `first` counts vertices, six to a point
        for (const p of b.pts) {
          // The line leans with the ground it crosses, so neither stripe digs into a hillside.
          const up = this.surface(p[0] + nx * 2, p[1] + ny * 2), down = this.surface(p[0] - nx * 2, p[1] - ny * 2), h = this.surface(p[0], p[1]);
          const tilt = (up - down) / 4, rough = Math.abs(up + down - 2 * h);
          for (let j = 0; j < 6; j++, v++) {
            pos[v * 3] = p[0]; pos[v * 3 + 1] = Math.max(0.4, h) + 0.3 + Math.min(1.2, rough * 0.6); pos[v * 3 + 2] = p[1];
            side[v * 3] = nx; side[v * 3 + 1] = tilt; side[v * 3 + 2] = ny;
            lat[v] = across[j];
          }
        }
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setAttribute('aSide', new T.BufferAttribute(side, 3));
      g.setAttribute('aLat', new T.BufferAttribute(lat, 1));
      g.setAttribute('aTint', new T.BufferAttribute(this.edgeTint, 3));
      g.setIndex(new T.BufferAttribute(this.edgeIndex, 1));
      g.setDrawRange(0, 0);
      const uniforms = T.UniformsUtils.merge([T.UniformsLib.fog, { uLine: { value: new T.Vector3(0.001, 0.95, 2.4) } }]);
      this.borders = new T.Mesh(g, new T.ShaderMaterial({
        uniforms: uniforms, vertexShader: EDGE_VERT, fragmentShader: EDGE_FRAG, fog: true, side: T.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }));
      this.borders.frustumCulled = false;
      this.group.add(this.borders);
    }

    buildFields() {
      const T = this.T, L = this.land, F = L.fields;
      // Every strip is a few quads draped over the ground, all in one mesh; a small striped texture rules the furrows.
      const pos = [], uv = [], idx = [];
      this.fieldAt = [];
      for (const f of F) {
        const cx = Math.cos(f.rot), sx = Math.sin(f.rot), nu = Math.max(1, Math.round(f.w / 8)), base = pos.length / 3;
        this.fieldAt.push(base, (nu + 1) * 2);
        for (let i = 0; i <= nu; i++) for (let j = 0; j < 2; j++) {
          const u = (i / nu - 0.5) * f.w, v = (j - 0.5) * (f.d - 0.5), x = f.x + cx * u - sx * v, y = f.y + sx * u + cx * v;
          pos.push(x, this.surface(x, y) + 0.2, y); uv.push(u / 16, (j - 0.5) * f.d / 2.6);
          if (i && j) { const k = base + i * 2; idx.push(k - 2, k - 1, k, k, k - 1, k + 1); }
        }
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
      this.fieldTint = new Float32Array(pos.length);
      g.setAttribute('color', new T.BufferAttribute(this.fieldTint, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const c = document.createElement('canvas');
      c.width = 4; c.height = 16;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 4, 16);
      ctx.fillStyle = 'rgba(96, 84, 60, 0.3)'; ctx.fillRect(0, 0, 4, 5);
      ctx.fillStyle = 'rgba(96, 84, 60, 0.14)'; ctx.fillRect(0, 5, 4, 2); ctx.fillRect(0, 14, 4, 2);
      this.furrows = new T.CanvasTexture(c);
      this.furrows.wrapS = this.furrows.wrapT = T.RepeatWrapping;
      this.fields = new T.Mesh(g, new T.MeshLambertMaterial({ vertexColors: true, map: this.furrows, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
      this.group.add(this.fields);

      // Hedges: low green walls along the field edges.
      const box = new T.BoxGeometry(1, 1.1, 0.8);
      box.translate(0, 0.45, 0);
      const hedge = new Shape().add(box, (y) => 0.9 + y * 0.14, (y) => (y > 0.9 ? 1 : 0)).build(T);
      const H = L.hedges, count = H.length / 5;
      this.hedges = new T.InstancedMesh(hedge, this.snowy(false), Math.max(1, count));
      const M = new T.Matrix4(), q = new T.Quaternion(), s = new T.Vector3(), p = new T.Vector3(), up = new T.Vector3(0, 1, 0);
      for (let i = 0; i < count; i++) {
        p.set(H[i * 5], this.surface(H[i * 5], H[i * 5 + 1]) - 0.15, H[i * 5 + 1]); s.set(H[i * 5 + 3], 0.85 + hash(i, 5) * 0.4, 1); q.setFromAxisAngle(up, -H[i * 5 + 4]);
        this.hedges.setMatrixAt(i, M.compose(p, q, s));
      }
      this.hedges.count = count;
      this.group.add(this.hedges);
    }

    buildWoods() {
      const T = this.T, L = this.land;
      // Two trees and a rock, each one small merged shape drawn many times over.
      // A five-sided cone with no floor and no wasted triangles at the tip.
      const tier = (r, h, y0) => {
        const c = new T.BufferGeometry(), v = [];
        for (let i = 0; i < 5; i++) {
          const a0 = i * 1.2566, a1 = a0 + 1.2566;
          v.push(Math.sin(a0) * r, y0, Math.cos(a0) * r, Math.sin(a1) * r, y0, Math.cos(a1) * r, 0, y0 + h, 0);
        }
        c.setAttribute('position', new T.Float32BufferAttribute(v, 3));
        return c;
      };
      const trunk = (r, h) => { const c = new T.CylinderGeometry(r * 0.7, r, h, 3, 1, true); c.translate(0, h / 2, 0); return c; };
      const bark = () => 1, wood = () => -1;
      const pine = new Shape()
        .add(trunk(0.5, 2), bark, wood)
        .add(tier(2.45, 4.3, 1.3), (y) => 0.8 + (y - 1.3) * 0.055, (y) => (y - 1.3) / 4.3)
        .add(tier(1.7, 3.9, 3.9), (y) => 0.88 + (y - 3.9) * 0.055, (y) => (y - 3.9) / 3.9)
        .build(T);
      const crown = new T.IcosahedronGeometry(2.9, 0);
      crown.scale(1, 0.9, 1); crown.translate(0, 4.9, 0);
      const oak = new Shape()
        .add(trunk(0.6, 3.2), bark, wood)
        .add(crown, (y) => 0.8 + (y - 2.3) * 0.05, (y) => (y - 2.3) / 5.2)
        .build(T);
      const stone = new T.IcosahedronGeometry(1, 0), sp = stone.attributes.position;
      for (let i = 0; i < sp.count; i++) {
        // Knock the corners about, the same way for every copy of a corner so the faces stay closed.
        const k = hash(Math.round(sp.getX(i) * 7) + 31 * Math.round(sp.getY(i) * 7), Math.round(sp.getZ(i) * 7)) * 0.5 + 0.72;
        sp.setXYZ(i, sp.getX(i) * k, sp.getY(i) * k * 0.8 + 0.25, sp.getZ(i) * k);
      }
      const rock = new Shape().add(stone, (y) => 0.86 + y * 0.14, (y) => y * 0.9 + 0.3).build(T);

      const tr = L.trees, count = tr.length / 5;
      let pines = 0;
      for (let i = 0; i < count; i++) if (tr[i * 5 + 4] === 0) pines++;
      const mat = this.snowy(true);
      this.pines = new T.InstancedMesh(pine, mat, Math.max(1, pines));
      this.oaks = new T.InstancedMesh(oak, mat, Math.max(1, count - pines));
      this.pineSeed = new Float32Array(Math.max(1, pines)); this.oakSeed = new Float32Array(Math.max(1, count - pines));
      const M = new T.Matrix4(), q = new T.Quaternion(), s = new T.Vector3(), p = new T.Vector3(), up = new T.Vector3(0, 1, 0);
      let ip = 0, io = 0;
      for (let i = 0; i < count; i++) {
        const o = i * 5, sc = tr[o + 3], r1 = hash(i, 11), r2 = hash(i, 13);
        p.set(tr[o], this.surface(tr[o], tr[o + 1]) - 0.25, tr[o + 1]); q.setFromAxisAngle(up, r1 * 6.283);
        if (tr[o + 4] === 0) {
          s.set(sc * (0.85 + r2 * 0.3), sc * (0.9 + r1 * 0.35), sc * (0.85 + r2 * 0.3));
          this.pineSeed[ip] = r2; this.pines.setMatrixAt(ip++, M.compose(p, q, s));
        } else {
          // Broadleaves come round, tall and spreading.
          const tall = r2 < 0.22 ? 1.35 : r2 > 0.8 ? 0.82 : 1, wide = r2 < 0.22 ? 0.72 : r2 > 0.8 ? 1.18 : 1;
          s.set(sc * wide, sc * tall, sc * wide * (0.9 + r1 * 0.2));
          this.oakSeed[io] = r1; this.oaks.setMatrixAt(io++, M.compose(p, q, s));
        }
      }
      this.pines.count = pines; this.oaks.count = count - pines;

      const rk = L.rocks, rocks = rk.length / 4;
      this.rocks = new T.InstancedMesh(rock, this.snowy(false), Math.max(1, rocks));
      const C = new T.Color(), e = new T.Euler();
      for (let i = 0; i < rocks; i++) {
        const sc = rk[i * 4 + 3], r1 = hash(i, 17), r2 = hash(i, 19);
        p.set(rk[i * 4], this.surface(rk[i * 4], rk[i * 4 + 1]) - 0.2 * sc, rk[i * 4 + 1]); q.setFromEuler(e.set((r1 - 0.5) * 0.7, r2 * 6.283, (r2 - 0.5) * 0.7));
        s.set(sc * (0.8 + r1 * 0.6), sc * (0.6 + r2 * 0.6), sc * (0.8 + r2 * 0.5));
        this.rocks.setMatrixAt(i, M.compose(p, q, s));
        const v = 0.84 + r1 * 0.28;
        this.rocks.setColorAt(i, C.setRGB(ROCK[0] / 255 * v, ROCK[1] / 255 * v, ROCK[2] / 255 * v * (0.96 + r2 * 0.06)));
      }
      this.rocks.count = rocks;
      this.group.add(this.pines, this.oaks, this.rocks);
    }

    buildSnowfall() {
      const T = this.T, L = this.land, count = clamp(Math.round(L.W * L.H / 300), 1200, 4200);
      const pos = new Float32Array(count * 3), seedA = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        pos[i * 3] = hash(i, 23) * L.W; pos[i * 3 + 1] = hash(i, 29) * 150; pos[i * 3 + 2] = hash(i, 31) * L.H; seedA[i] = hash(i, 37);
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setAttribute('aSeed', new T.BufferAttribute(seedA, 1));
      this.snowfall = new T.Points(g, new T.ShaderMaterial({
        uniforms: { uTime: this.uTime, uFlake: { value: new T.Vector3(150, 900, 1) }, uTone: { value: new T.Vector4(1, 1, 1, 0) } },
        vertexShader: SNOW_VERT, fragmentShader: SNOW_FRAG, transparent: true, depthWrite: false, fog: false,
      }));
      this.snowfall.frustumCulled = false;
      this.snowfall.renderOrder = 4;
      this.snowfall.visible = false;
      this.group.add(this.snowfall);
    }

    /* ----- colour ----- */

    /** `theme` is the object BC.View3D reads from the page's CSS tokens (rgb arrays plus `dark`). */
    setTheme(theme) {
      const T = this.T;
      this.theme = theme;
      if (!this.scene.background || !this.scene.background.isColor) this.scene.background = new T.Color();
      if (!this.scene.fog || !this.scene.fog.isFog) this.scene.fog = new T.Fog(0xffffff, 2000, 7000);
      this.owner.fill(-2);
      this.light();
      this.claims(true);
      this.paint();
    }

    /** Recolour the land by who holds each province. Call when game.version changes. */
    paintOwnership() {
      if (!this.theme) return;
      this.owner.fill(-2);
      this.claims(true);
      this.paint();
    }

    /** Sun, sky, sea and haze for this theme and this point in the year. */
    light() {
      const th = this.theme, t = this.blend, a = this.fromSeason, b = this.season, dark = th.dark;
      const sun = this.sunNow || (this.sunNow = [0, 0, 0, 0]), sky = this.skyNow || (this.skyNow = [0, 0, 0, 0]);
      for (let i = 0; i < 4; i++) { sun[i] = lerp(SUNLIGHT[a][i], SUNLIGHT[b][i], t); sky[i] = lerp(SKYLIGHT[a][i], SKYLIGHT[b][i], t); }
      const winter = (a === 3 ? 1 - t : 0) + (b === 3 ? t : 0);
      // Dusk keeps the same sun in the same place, only lower and bluer, so the baked shadows still agree with it.
      if (dark) {
        this.sun.color.setRGB(sun[0] * 0.62, sun[1] * 0.72, sun[2]); this.sun.intensity = sun[3] * 0.66;
        this.hemi.color.setRGB(sky[0] * 0.55, sky[1] * 0.66, sky[2] * 0.95); this.hemi.groundColor.setRGB(0.22, 0.26, 0.32); this.hemi.intensity = sky[3] * 0.95;
        this.fill.intensity = 0.1;
      } else {
        this.sun.color.setRGB(sun[0], sun[1], sun[2]); this.sun.intensity = sun[3];
        this.hemi.color.setRGB(sky[0], sky[1], sky[2]); this.hemi.groundColor.setRGB(0.56, 0.58, 0.52); this.hemi.intensity = sky[3];
        this.fill.intensity = 0.16;
      }
      // Haze at the horizon, taken from the page's own sea colour so the far water melts into it, and the
      // sky above; a winter sky is paler and greyer.
      const su = this.sky.material.uniforms, haze = this.haze, bg = this.scene.background, fog = this.scene.fog, sea = th.sea;
      if (dark) {
        haze.setRGB(sea[0] / 255 * 0.65 + 0.082, sea[1] / 255 * 0.65 + 0.11, sea[2] / 255 * 0.65 + 0.151);
        su.uZenith.value.setRGB(0.04, 0.063, 0.118); su.uGlow.value.setRGB(0.42, 0.2, 0.1);
      } else {
        haze.setRGB(lerp(sea[0] / 255, 1, 0.42 + 0.14 * winter), lerp(sea[1] / 255, 1, 0.42 + 0.03 * winter), lerp(sea[2] / 255, 1, 0.42 - 0.05 * winter));
        su.uZenith.value.setRGB(lerp(0.44, 0.59, winter), lerp(0.62, 0.675, winter), lerp(0.8, 0.77, winter));
        su.uGlow.value.setRGB(0.1, 0.09, 0.06);
      }
      su.uHorizon.value.copy(haze);
      if (bg && bg.isColor) bg.copy(haze);
      if (fog) fog.color.copy(haze);
      // The sea greys a little in winter too.
      const u = this.sea.material.uniforms, grey = winter * 0.3, tone = (c, v) => c.lerp(this.grey.setRGB(v, v, v), grey);
      if (dark) {
        tone(u.uDeep.value.setRGB(0.07, 0.15, 0.227), 0.2); tone(u.uShallow.value.setRGB(0.15, 0.306, 0.36), 0.36);
        u.uFoam.value.setRGB(0.5, 0.59, 0.643); u.uLake.value.setRGB(0.07, 0.15, 0.2);
      } else {
        tone(u.uDeep.value.setRGB(0.227, 0.431, 0.549), 0.46); tone(u.uShallow.value.setRGB(0.408, 0.643, 0.667), 0.62);
        u.uFoam.value.setRGB(0.933, 0.957, 0.957); tone(u.uLake.value.setRGB(0.24, 0.42, 0.46), 0.5);
      }
      const k = dark ? 0.62 : 1;
      this.snowfall.material.uniforms.uTone.value.set(k, k, k * 1.04, this.snowfall.material.uniforms.uTone.value.w);
    }

    /** Note who holds each province. Returns true while any realm colour is still easing towards its owner's. */
    claims(snap) {
      const g = this.game, th = this.theme, K = g.keeps, W = this.wash, To = this.washTo, L = this.land;
      let changed = false;
      for (let k = 0; k < K.length; k++) {
        if (this.owner[k] === K[k].owner) continue;
        this.owner[k] = K[k].owner; changed = true;
        const c = K[k].owner < 0 ? null : th.f[g.factions[K[k].owner].color];
        To[k * 4 + 3] = c ? 1 : 0;
        if (c) { To[k * 4] = c[0]; To[k * 4 + 1] = c[1]; To[k * 4 + 2] = c[2]; }
        if (c && W[k * 4 + 3] < 0.03) { W[k * 4] = c[0]; W[k * 4 + 1] = c[1]; W[k * 4 + 2] = c[2]; }
      }
      if (changed) {
        // How close each vertex is to a frontier with somebody else's land.
        const E = this.edge, n = L.nx * L.nz, own = this.owner;
        for (let i = 0; i < n; i++) {
          if (!L.land[i]) continue;
          const me = own[L.province[i]], a = this.near1[i], b = this.near2[i];
          let e = 0;
          if (a !== 255 && own[a] !== me) e = smooth(15, 1, this.gap1[i]);
          if (b !== 255 && own[b] !== me) e = Math.max(e, smooth(15, 1, this.gap2[i]));
          E[i] = e;
        }
        this.lines();
      }
      let moving = false;
      for (let i = 0; i < W.length; i++) {
        if (W[i] === To[i]) continue;
        if (snap || Math.abs(To[i] - W[i]) < (i % 4 === 3 ? 0.01 : 1.5)) W[i] = To[i]; else { W[i] += (To[i] - W[i]) * 0.3; moving = true; }
      }
      this.paintedVersion = g.version;
      return changed || moving;
    }

    /** Lay the frontier lines: one stripe of each owner's colour along every stretch where two realms meet. */
    lines() {
      const g = this.game, th = this.theme, tint = this.edgeTint, idx = this.edgeIndex, own = this.owner;
      let p = 0;
      const colour = (o) => (o < 0 ? th.free : th.f[g.factions[o].color]);
      for (const run of this.edgeRuns) {
        const oa = own[run.a], ob = own[run.b];
        if (oa === ob) continue;
        const ca = colour(oa), cb = colour(ob), ink = th.outline;
        for (let i = 0; i < run.n; i++) {
          const v = (run.first + i * 6) * 3;
          for (let j = 0; j < 6; j++) { const c = j < 2 ? ca : j < 4 ? ink : cb; tint[v + j * 3] = c[0] / 255; tint[v + j * 3 + 1] = c[1] / 255; tint[v + j * 3 + 2] = c[2] / 255; }
          if (i) {
            for (let j = 0; j < 6; j += 2) { const k = run.first + i * 6 + j; idx[p++] = k - 6; idx[p++] = k - 5; idx[p++] = k; idx[p++] = k; idx[p++] = k - 5; idx[p++] = k + 1; }
          }
        }
      }
      const geo = this.borders.geometry;
      geo.attributes.aTint.needsUpdate = true; geo.index.needsUpdate = true;
      geo.setDrawRange(0, p);
    }

    /** Mix every colour on the map for this moment of the year and this state of the war. */
    paint() {
      if (!this.theme) return;
      const L = this.land, n = L.nx * L.nz, col = this.ground.geometry.attributes.color.array;
      const t = this.blend, a = this.fromSeason, b = this.season;
      const winter = (a === 3 ? 1 - t : 0) + (b === 3 ? t : 0), drift = winter * 1.25;
      const mr = lerp(MEADOW[a][0], MEADOW[b][0], t), mg = lerp(MEADOW[a][1], MEADOW[b][1], t), mb = lerp(MEADOW[a][2], MEADOW[b][2], t);
      const hr = lerp(HEATH[a][0], HEATH[b][0], t), hg = lerp(HEATH[a][1], HEATH[b][1], t), hb = lerp(HEATH[a][2], HEATH[b][2], t);
      const fr = lerp(FLOOR[a][0], FLOOR[b][0], t), fg = lerp(FLOOR[a][1], FLOOR[b][1], t), fb = lerp(FLOOR[a][2], FLOOR[b][2], t);
      const er = lerp(FELL[a][0], FELL[b][0], t), eg = lerp(FELL[a][1], FELL[b][1], t), eb = lerp(FELL[a][2], FELL[b][2], t);
      const W = this.wash, H = L.height, strong = this.theme.dark ? 1.3 : 1;      // dusk mutes colour, so lay it on thicker
      for (let i = 0; i < n; i++) {
        let r, g, bl;
        if (!L.land[i]) {
          const deep = smooth(0, 9, -H[i]);
          r = lerp(SHOAL[0], DEPTHS[0], deep); g = lerp(SHOAL[1], DEPTHS[1], deep); bl = lerp(SHOAL[2], DEPTHS[2], deep);
        } else {
          let k = this.heath[i];
          r = mr + (hr - mr) * k; g = mg + (hg - mg) * k; bl = mb + (hb - mb) * k;
          k = this.fell[i]; r += (er - r) * k; g += (eg - g) * k; bl += (eb - bl) * k;
          k = this.wood[i] * 0.62; r += (fr - r) * k; g += (fg - g) * k; bl += (fb - bl) * k;
          k = 1 + this.vary[i] * 0.055; r *= k; g *= k * (1 + this.vary[i] * 0.012); bl *= k;
          k = this.bare[i]; r += (EARTH[0] - r) * k; g += (EARTH[1] - g) * k; bl += (EARTH[2] - bl) * k;
          k = this.rock[i]; const steep = k * k;
          r += (lerp(ROCK[0], CRAG[0], steep) - r) * k; g += (lerp(ROCK[1], CRAG[1], steep) - g) * k; bl += (lerp(ROCK[2], CRAG[2], steep) - bl) * k;
          k = this.sand[i]; r += (SAND[0] - r) * k; g += (SAND[1] - g) * k; bl += (SAND[2] - bl) * k;
          k = this.inland[i] * 0.5; r += (fr - r) * k; g += (fg - g) * k; bl += (fb - bl) * k;
          // Whose land it is: a light wash everywhere, a strong one along the frontier. Bare rock and beach take less.
          const p = L.province[i] * 4, claim = W[p + 3];
          if (claim > 0) {
            k = claim * strong * (0.25 + 0.4 * this.edge[i]) * (1 - 0.7 * this.rock[i]) * (1 - 0.5 * this.sand[i]) * (1 - 0.6 * this.bare[i]);
            r += (W[p] - r) * k; g += (W[p + 1] - g) * k; bl += (W[p + 2] - bl) * k;
          }
          // Snow: always on the summits, and creeping down from them as winter comes on.
          k = Math.max(this.cap[i], smooth(this.frost[i] - 0.14, this.frost[i] + 0.14, drift) * (1 - 0.55 * steep) * (1 - 0.35 * this.bare[i]) * (0.9 + 0.05 * this.vary[i]));
          if (k > 0) {
            // Snow in a realm takes a breath of its colour, so the map still says who holds what in winter.
            const stain = claim * strong * (0.2 + 0.3 * this.edge[i]);
            r += (SNOW[0] + (W[p] - SNOW[0]) * stain - r) * k; g += (SNOW[1] + (W[p + 1] - SNOW[1]) * stain - g) * k; bl += (SNOW[2] + (W[p + 2] - SNOW[2]) * stain - bl) * k;
          }
          k = this.shade[i] / 255; r *= k; g *= k; bl *= k;
          col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = bl;
          continue;
        }
        col[i * 3] = r / 255; col[i * 3 + 1] = g / 255; col[i * 3 + 2] = bl / 255;
      }
      this.ground.geometry.attributes.color.needsUpdate = true;

      // Woods: every tree turns at its own moment, so a change of season runs through a wood instead of flipping it.
      const C = this.C || (this.C = new this.T.Color());
      const pa = PINE[a], pb = PINE[b];
      for (let i = 0; i < this.pines.count; i++) {
        const s = this.pineSeed[i], k = smooth(s * 0.7, s * 0.7 + 0.3, t), v = (0.84 + s * 0.3) / 255;
        this.pines.setColorAt(i, C.setRGB(lerp(pa[0], pb[0], k) * v, lerp(pa[1], pb[1], k) * v, lerp(pa[2], pb[2], k) * v));
      }
      for (let i = 0; i < this.oaks.count; i++) {
        const s = this.oakSeed[i], k = smooth(s * 0.7, s * 0.7 + 0.3, t), pick = s < 0.05 ? 3 : Math.floor(s * 97) % 3, v = (0.88 + ((s * 53) % 1) * 0.24) / 255;
        const ca = LEAF[a][a === 2 && pick < 3 ? Math.floor(s * 211) % 4 : pick], cb = LEAF[b][b === 2 && pick < 3 ? Math.floor(s * 211) % 4 : pick];
        this.oaks.setColorAt(i, C.setRGB(lerp(ca[0], cb[0], k) * v, lerp(ca[1], cb[1], k) * v, lerp(ca[2], cb[2], k) * v));
      }
      if (this.pines.instanceColor) this.pines.instanceColor.needsUpdate = true;
      if (this.oaks.instanceColor) this.oaks.instanceColor.needsUpdate = true;

      // Fields, hedges and roads.
      const F = L.fields, ft = this.fieldTint;
      for (let i = 0; i < F.length; i++) {
        const f = F[i], ca = CROP[a][f.crop], cb = CROP[b][f.crop], v = (0.93 + hash(i, 41) * 0.14) / 255;
        const r = lerp(ca[0], cb[0], t) * v, g = lerp(ca[1], cb[1], t) * v, bl = lerp(ca[2], cb[2], t) * v;
        for (let j = this.fieldAt[i * 2], e = j + this.fieldAt[i * 2 + 1]; j < e; j++) { ft[j * 3] = r; ft[j * 3 + 1] = g; ft[j * 3 + 2] = bl; }
      }
      this.fields.geometry.attributes.color.needsUpdate = true;
      this.hedges.material.color.setRGB(lerp(HEDGE[a][0], HEDGE[b][0], t) / 255, lerp(HEDGE[a][1], HEDGE[b][1], t) / 255, lerp(HEDGE[a][2], HEDGE[b][2], t) / 255);
      this.roads.material.color.setRGB(lerp(TRACK[a][0], TRACK[b][0], t) / 255, lerp(TRACK[a][1], TRACK[b][1], t) / 255, lerp(TRACK[a][2], TRACK[b][2], t) / 255);
      this.uSnow.value = winter;
      this.sincePaint = 0; this.dirty = false;
    }

    /* ----- the frame ----- */

    /** Called every frame. `t` is seconds since the view started. */
    update(dt, game, t) {
      if (!this.theme) return;
      this.sincePaint += dt;
      if (game.season !== this.season) { this.fromSeason = this.season; this.season = game.season; this.blend = 0; }
      if (this.blend < 1) { this.blend = Math.min(1, this.blend + dt / 4); this.dirty = true; this.light(); }
      if (game.version !== this.paintedVersion || this.easing) {
        if (game.version !== this.paintedVersion || this.sincePaint > 0.08) { this.easing = this.claims(false); this.dirty = true; }
      }
      if (this.dirty && (this.sincePaint > 0.09 || this.blend >= 1)) this.paint();

      if (!this.calm) this.uTime.value = t;
      // Snowfall in winter only, and not at all for anyone who has asked for less motion.
      const winter = (this.fromSeason === 3 ? 1 - this.blend : 0) + (this.season === 3 ? this.blend : 0);
      const fall = this.calm ? 0 : winter;
      this.snowfall.visible = fall > 0.01;
      const sf = this.snowfall.material.uniforms;
      sf.uTone.value.w = fall * 0.85; sf.uFlake.value.z = this.dpr;

      // Haze: clear over whatever is being looked at, thickening beyond it, so the far sea melts into the sky.
      const cam = this.camera, fog = this.scene.fog;
      if (cam) {
        const e = cam.matrixWorld.elements, down = Math.max(0.2, e[9]), reach = clamp(cam.position.y / down, 60, 6000);
        if (fog && fog.isFog) { fog.near = reach * 0.95; fog.far = Math.min(7400, reach * 4.4 + 500); }
        this.borders.material.uniforms.uLine.value.x = 2 / (cam.projectionMatrix.elements[5] * this.viewH);
        this.borders.material.uniforms.uLine.value.z = 2.4 * this.dpr;
      }
    }

    dispose() {
      this.scene.remove(this.group, this.hemi, this.sun, this.fill);
      this.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
        if (o.isInstancedMesh) o.dispose();
      });
      this.shoreTex.dispose(); this.furrows.dispose();
      this.sky.onBeforeRender = () => {};
      this.camera = null;
    }
  }

  BC.Scenery = Scenery;
})();
