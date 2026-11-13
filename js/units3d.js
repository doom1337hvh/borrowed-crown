/*
 * Borrowed Crown: the men.
 *
 * Every body of soldiers in the simulation is drawn as figures on the ground: garrisons
 * drawn up in ranks outside their town (or lining its wall when it is besieged), columns
 * strung out along the road with a standard at the head and wagons at the rear, siege camps
 * with tents, fires and engines, and two lines going at each other wherever a battle is
 * being fought. One figure stands for MEN_PER men.
 *
 * A figure is a little man with a shield and a spear. Only his tunic and his shield take his
 * banner's colour; skin, helmet and kit never do. Figures belong to a body (a garrison or an
 * army) and each one walks towards its place in whatever formation that body is in now, so
 * men march out of a garrison, pitch camp, charge and break instead of jumping there. When
 * one body shrinks and another of the same banner grows beside it (a column leaving its
 * town, a column coming home) the same figures change hands. Men lost in a fight fall where
 * they stand and lie there a few seconds.
 *
 * Draw calls: the figures near the camera (a fuller model), every other figure (a simpler
 * one), standards, and one each for tents, wagons, fires, ladders, mantlets, engines, arrows
 * and dust while there are any to draw.
 *
 * Needs THREE (three.js r149). Map (x, y) with height h sits at scene (x, h, y).
 */
(function () {
  'use strict';
  const BC = (window.BC = window.BC || {});
  const TAU = Math.PI * 2, HALF = Math.PI / 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  /** 0 at `a`, 1 at `b`, eased. */
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  /** 0, 1, -1, 2, -2, ...: places filled outwards from the middle, so adding one never moves the others. */
  const spread = (i) => ((i + 1) >> 1) * (i & 1 ? 1 : -1);

  const MEN_PER = 10;
  const MAX = 4000;            // figures alive at once, over the whole map
  const NEAR_MAX = 420;        // how many of them may be drawn as the fuller figure
  const NEAR_R = 340;          // within this distance of the camera
  const BODY_CAP = 120;        // figures in any one body; a bigger host is drawn as this many
  const MAX_DEAD = 240, DEAD_FOR = 6.5;
  const MAX_FLAGS = 160, MAX_TENTS = 220, MAX_WAGONS = 80, MAX_FLAMES = 160, MAX_LADDERS = 60, MAX_MANTLETS = 80, MAX_ENGINES = 12;
  const MAX_ARROWS = 200, MAX_DUST = 110;
  const GAP = 1.9;             // between men drawn up in ranks
  const WIND = 0.22;           // the same wind the towns fly their banners in
  const WALL_INSET = [0, 1.7, 3.8, 4.6], WALL_H = [0, 3.2, 5.6, 7.6];     // only used if the towns module cannot be asked

  // Colours, 0..255. Cloth is white here and takes the banner's colour in the shader; the rest is plain stuff.
  const FULL = [255, 255, 255], SHADE = [206, 206, 206], DEEP = [118, 118, 118];
  const SKIN = [224, 178, 142], STEEL = [140, 146, 154], BRIGHT = [206, 210, 214], HOSE = [88, 74, 62], BOOT = [56, 48, 42];
  const WOOD = [130, 100, 66], DARKWOOD = [94, 72, 50], CANVAS = [230, 218, 192], DOOR = [120, 100, 78];
  const OX = [136, 108, 80], DARKOX = [96, 76, 58], BRASS = [200, 164, 88], STONE = [126, 126, 122], SHAFT = [214, 200, 170];
  const P0 = [0, 0, 0], TINT = [1, 0, 0], ARM = [0, 0, 1];

  function jit(a, b) {
    let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5;
  }

  /* ----- shapes ----- */

  // Collects boxes and shafts into one indexed geometry. Each vertex carries a colour and three flags
  // (aPart): x = 1 where it is cloth that takes the banner's colour, y = how far it swings with the
  // stride (legs) or ripples (a standard), z = 1 where it turns about the hand (a spear, an engine's arm).
  class Mesher {
    constructor() { this.pos = []; this.col = []; this.part = []; this.idx = []; this.n = 0; }
    v(x, y, z, c, p) {
      this.pos.push(x, y, z); this.col.push(c[0] / 255, c[1] / 255, c[2] / 255); this.part.push(p[0], p[1], p[2]);
      return this.n++;
    }
    tri(a, b, c) { this.idx.push(a, b, c); }
    quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
    /** A box on the rectangle (x0..x1, z0..z1) from y0 up to y1, its top `top` times the size of its foot. */
    box(x0, y0, z0, x1, y1, z1, cb, ct, top, lid, pb, pt) {
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, hx = (x1 - x0) / 2 * top, hz = (z1 - z0) / 2 * top;
      const a = this.v(x0, y0, z0, cb, pb), b = this.v(x1, y0, z0, cb, pb), c = this.v(x1, y0, z1, cb, pb), d = this.v(x0, y0, z1, cb, pb);
      const e = this.v(mx - hx, y1, mz - hz, ct, pt), f = this.v(mx + hx, y1, mz - hz, ct, pt), g = this.v(mx + hx, y1, mz + hz, ct, pt), h = this.v(mx - hx, y1, mz + hz, ct, pt);
      this.quad(a, b, f, e); this.quad(b, c, g, f); this.quad(c, d, h, g); this.quad(d, a, e, h);
      if (lid) this.quad(e, f, g, h);
    }
    /** A three-sided shaft standing at (x, z) from y0 to y1; it comes to a point when `tip`. */
    shaft(x, y0, y1, z, r, cb, ct, tip, p) {
      const lo = [], hi = [];
      for (let i = 0; i < 3; i++) lo.push(this.v(x + Math.cos(i * TAU / 3) * r, y0, z + Math.sin(i * TAU / 3) * r, cb, p));
      if (tip) { const t = this.v(x, y1, z, ct, p); for (let i = 0; i < 3; i++) this.tri(lo[i], lo[(i + 1) % 3], t); return; }
      for (let i = 0; i < 3; i++) hi.push(this.v(x + Math.cos(i * TAU / 3) * r, y1, z + Math.sin(i * TAU / 3) * r, ct, p));
      for (let i = 0; i < 3; i++) this.quad(lo[i], lo[(i + 1) % 3], hi[(i + 1) % 3], hi[i]);
    }
    build(T) {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(new Float32Array(this.pos), 3));
      g.setAttribute('color', new T.BufferAttribute(new Float32Array(this.col), 3));
      g.setAttribute('aPart', new T.BufferAttribute(new Float32Array(this.part), 3));
      g.setIndex(this.idx);
      return g;
    }
  }

  // A soldier, facing +z, about 3.3 tall with his spear standing to 4.85. The full figure (68 triangles) has
  // legs that step, a head under a kettle hat and a heater shield; the far one (19) is a peg in his colours.
  function figure(T, full) {
    const m = new Mesher();
    if (full) {
      m.box(0.07, 0, -0.2, 0.47, 1.22, 0.2, BOOT, HOSE, 1, false, [0, 1, 0], P0);
      m.box(-0.47, 0, -0.2, -0.07, 1.22, 0.2, BOOT, HOSE, 1, false, [0, -1, 0], P0);
      m.box(-0.62, 1.1, -0.4, 0.62, 2.42, 0.4, SHADE, FULL, 0.9, true, TINT, TINT);          // tunic, skirted
      m.box(-0.86, 1.5, -0.06, -0.58, 2.34, 0.36, SHADE, FULL, 1, true, TINT, TINT);         // the spear arm
      m.box(-0.29, 2.42, -0.29, 0.29, 2.92, 0.29, SKIN, SKIN, 1, false, P0, P0);
      m.box(-0.43, 2.8, -0.43, 0.43, 3.28, 0.43, STEEL, BRIGHT, 0.34, true, P0, P0);         // kettle hat
      const a = m.v(0.34, 2.32, 0.47, FULL, TINT), b = m.v(1.02, 2.32, 0.33, FULL, TINT), c = m.v(1.02, 1.72, 0.33, FULL, TINT);
      const d = m.v(0.68, 1.14, 0.42, SHADE, TINT), e = m.v(0.34, 1.72, 0.47, FULL, TINT);
      m.tri(a, b, c); m.tri(a, c, e); m.tri(e, c, d);                                         // shield
      m.quad(m.v(0.68, 2.02, 0.45, BRIGHT, P0), m.v(0.84, 1.86, 0.42, BRIGHT, P0), m.v(0.68, 1.7, 0.45, STEEL, P0), m.v(0.52, 1.86, 0.48, BRIGHT, P0));   // its boss
      m.shaft(-0.78, 0.2, 4.25, 0.22, 0.06, DARKWOOD, WOOD, false, ARM);
      m.shaft(-0.78, 4.25, 4.85, 0.22, 0.14, BRIGHT, BRIGHT, true, ARM);
    } else {
      m.box(-0.5, 0, -0.3, 0.5, 2.42, 0.3, DEEP, FULL, 1.16, true, TINT, TINT);
      const a = m.v(-0.33, 2.42, -0.33, SKIN, P0), b = m.v(0.33, 2.42, -0.33, SKIN, P0), c = m.v(0.33, 2.42, 0.33, SKIN, P0), d = m.v(-0.33, 2.42, 0.33, SKIN, P0);
      const t = m.v(0, 3.3, 0, STEEL, P0);
      m.tri(a, b, t); m.tri(b, c, t); m.tri(c, d, t); m.tri(d, a, t);
      m.quad(m.v(0.36, 2.28, 0.46, FULL, TINT), m.v(1.0, 2.28, 0.34, FULL, TINT), m.v(1.0, 1.3, 0.34, SHADE, TINT), m.v(0.36, 1.3, 0.46, SHADE, TINT));
      m.shaft(-0.78, 0.6, 4.85, 0.22, 0.1, WOOD, BRIGHT, true, ARM);
    }
    return m.build(T);
  }

  // A standard: a pole with a swallow-tailed cloth, flying along +x and rippled in the shader.
  function standard(T) {
    const m = new Mesher(), nx = 5, x0 = 0.12, x1 = 3.1, y0 = 3.75, y1 = 5.6, at = [];
    m.shaft(0, 0, 5.75, 0, 0.09, DARKWOOD, WOOD, false, P0);
    m.shaft(0, 5.75, 6.2, 0, 0.17, BRASS, BRASS, true, P0);
    for (let j = 0; j <= 2; j++) for (let i = 0; i <= nx; i++) {
      const u = i / nx, tail = i === nx && j === 1 ? 0.74 : u;
      at.push(m.v(x0 + (x1 - x0) * tail, y0 + (y1 - y0) * j / 2, 0, j === 0 ? SHADE : FULL, [1, u, 0]));
    }
    for (let j = 0; j < 2; j++) for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      m.quad(at[a], at[a + 1], at[a + nx + 2], at[a + nx + 1]);
    }
    return m.build(T);
  }

  // A ridge tent, its door at the -z end.
  function tent(T) {
    const m = new Mesher();
    const a = m.v(-1.9, 0, -2.4, CANVAS, P0), b = m.v(1.9, 0, -2.4, CANVAS, P0), c = m.v(0, 2.7, -2.15, CANVAS, P0);
    const d = m.v(-1.9, 0, 2.4, CANVAS, P0), e = m.v(1.9, 0, 2.4, CANVAS, P0), f = m.v(0, 2.7, 2.15, CANVAS, P0);
    m.quad(a, d, f, c); m.quad(e, b, c, f); m.tri(d, e, f);
    m.tri(m.v(-1.9, 0, -2.4, CANVAS, P0), m.v(1.9, 0, -2.4, CANVAS, P0), m.v(0, 2.7, -2.15, CANVAS, P0));
    m.tri(m.v(-0.75, 0, -2.42, DOOR, P0), m.v(0.75, 0, -2.42, DOOR, P0), m.v(0, 1.9, -2.24, DOOR, P0));
    return m.build(T);
  }

  // A two-wheeled cart under a canvas tilt, and the ox that draws it. Faces +z.
  function wagon(T) {
    const m = new Mesher();
    m.box(-0.95, 0.75, -1.8, 0.95, 1.35, 1.5, DARKWOOD, WOOD, 1, true, P0, P0);
    m.box(-0.9, 1.35, -1.7, 0.9, 2.6, 1.4, CANVAS, CANVAS, 0.66, true, P0, P0);
    for (let s = -1; s <= 1; s += 2) {
      const hub = m.v(s * 1.03, 0.76, -0.3, DARKWOOD, P0), rim = [];
      for (let i = 0; i < 6; i++) rim.push(m.v(s * 1.03, 0.76 + Math.sin(i * TAU / 6) * 0.76, -0.3 + Math.cos(i * TAU / 6) * 0.76, WOOD, P0));
      for (let i = 0; i < 6; i++) m.tri(hub, rim[i], rim[(i + 1) % 6]);
    }
    m.box(-0.5, 0.4, 2.3, 0.5, 1.75, 4.3, DARKOX, OX, 0.9, true, P0, P0);
    m.box(-0.3, 1.05, 4.25, 0.3, 1.72, 4.95, OX, OX, 0.8, true, P0, P0);
    return m.build(T);
  }

  // A scaling ladder one unit long, lying along +y: the instance stretches it and leans it.
  function ladder(T) {
    const m = new Mesher();
    m.box(-0.5, 0, -0.07, -0.38, 1, 0.07, DARKWOOD, WOOD, 1, false, P0, P0);
    m.box(0.38, 0, -0.07, 0.5, 1, 0.07, DARKWOOD, WOOD, 1, false, P0, P0);
    for (let i = 1; i <= 6; i++) {
      const y = i / 7;
      m.quad(m.v(-0.4, y - 0.012, 0, WOOD, P0), m.v(0.4, y - 0.012, 0, WOOD, P0), m.v(0.4, y + 0.012, 0, WOOD, P0), m.v(-0.4, y + 0.012, 0, WOOD, P0));
    }
    return m.build(T);
  }

  // A mantlet: a plank screen the besiegers work behind.
  function mantlet(T) {
    const m = new Mesher();
    m.box(-1.8, 0, -0.14, 1.8, 2.6, 0.14, DARKWOOD, WOOD, 1, true, P0, P0);
    m.shaft(0, 0, 2.2, -1.2, 0.1, DARKWOOD, DARKWOOD, false, P0);
    return m.build(T);
  }

  // A trebuchet, built small and scaled up by its instance. Its arm and counterweight turn about the axle
  // at the same point (y 1.7, z 0.22) a soldier's spear turns about his hand, so one shader moves both.
  function engine(T) {
    const m = new Mesher();
    for (let s = -1; s <= 1; s += 2) {
      m.box(s * 0.48 - 0.08, 0, -1.25, s * 0.48 + 0.08, 0.15, 1.5, DARKWOOD, WOOD, 1, true, P0, P0);
      m.box(s * 0.48 - 0.07, 0.15, 0.13, s * 0.48 + 0.07, 1.8, 0.31, DARKWOOD, WOOD, 1, true, P0, P0);
    }
    m.box(-0.56, 1.63, 0.15, 0.56, 1.77, 0.29, DARKWOOD, DARKWOOD, 1, true, P0, P0);
    m.box(-0.07, 0.95, 0.14, 0.07, 4.1, 0.3, DARKWOOD, WOOD, 0.6, true, ARM, ARM);
    m.box(-0.3, 0.5, -0.08, 0.3, 1.02, 0.52, STONE, STONE, 1, true, ARM, ARM);
    return m.build(T);
  }

  function arrow(T) {
    const m = new Mesher();
    m.box(-0.05, 0, -0.05, 0.05, 1.9, 0.05, SHAFT, DARKWOOD, 1, false, P0, P0);
    return m.build(T);
  }

  /* ----- shaders ----- */

  const HEAD = '#include <common>\nattribute vec3 aPart;\nattribute vec3 aPose;\nuniform float uTime;\nvarying float vTint;';
  // Only cloth takes the banner's colour.
  const COLOUR = [
    'vTint = aPart.x;',
    'vColor = color;',
    '#ifdef USE_INSTANCING_COLOR',
    'vColor *= mix(vec3(1.0), instanceColor, aPart.x);',
    '#endif',
    ''].join('\n');
  // aPose per instance: x where he is in his stride, y how long the stride is, z how far the spear is lowered.
  const POSE = [
    'transformed.z += aPart.y * sin(aPose.x) * aPose.y;',
    'if (aPart.z > 0.5) {',
    '  vec2 bcD = transformed.yz - vec2(1.7, 0.22);',
    '  float bcC = cos(aPose.z), bcS = sin(aPose.z);',
    '  transformed.yz = vec2(1.7, 0.22) + vec2(bcC * bcD.x - bcS * bcD.y, bcS * bcD.x + bcC * bcD.y);',
    '}',
    ''].join('\n');
  const CLOTH = [
    '#ifdef USE_INSTANCING',
    'float bcPh = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;',
    '#else',
    'float bcPh = 0.0;',
    '#endif',
    'float bcU = aPart.y;',
    'transformed.z += (sin(bcU * 6.2 - uTime * 5.0 + bcPh) * 0.2 + sin(bcU * 11.0 - uTime * 7.7 + bcPh * 1.7) * 0.06) * smoothstep(0.0, 0.35, bcU);',
    'transformed.y -= 0.14 * bcU * bcU;',
    ''].join('\n');

  function patch(mat, cloth, uni) {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uni.uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', HEAD)
        .replace('#include <color_vertex>', COLOUR)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + (cloth ? CLOTH : POSE));
      // Keep banner cloth near its true colour in any light, so it reads the same as the plates and the town banners.
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vTint;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * (' + (cloth ? '0.34' : '0.3') + ' * vTint);\ndiffuseColor.rgb *= 1.0 - ' + (cloth ? '0.3' : '0.24') + ' * vTint;');
    };
    mat.customProgramCacheKey = () => (cloth ? 'bc-units-cloth' : 'bc-units-kit');
    return mat;
  }

  /* ----- the module ----- */

  class Units {
    constructor(THREE, scene, game, terrain) {
      const T = (this.T = THREE);
      this.scene = scene; this.game = game; this.land = terrain; this.theme = null; this.view = null;
      this.calm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      this.group = new T.Group();
      scene.add(this.group);
      this.C = new T.Color();
      this.uni = { uTime: { value: 0 } };
      this.meshes = [];

      const kit = (this.kit = patch(new T.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: T.DoubleSide }), false, this.uni));
      this.clothMat = patch(new T.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: T.DoubleSide }), true, this.uni);
      this.fireMat = new T.MeshBasicMaterial({ side: T.DoubleSide });
      this.dustMat = new T.MeshLambertMaterial({ flatShading: true, transparent: true, opacity: 0.46, depthWrite: false });
      this.near = this.inst(figure(T, true), kit, NEAR_MAX, true, true);
      this.far = this.inst(figure(T, false), kit, MAX + MAX_DEAD, true, true);
      this.flags = this.inst(standard(T), this.clothMat, MAX_FLAGS, true, false);
      this.tents = this.inst(tent(T), kit, MAX_TENTS, false, false);
      this.wagons = this.inst(wagon(T), kit, MAX_WAGONS, false, false);
      this.ladders = this.inst(ladder(T), kit, MAX_LADDERS, false, false);
      this.mantlets = this.inst(mantlet(T), kit, MAX_MANTLETS, false, false);
      this.engines = this.inst(engine(T), kit, MAX_ENGINES, false, true);
      this.arrows = this.inst(arrow(T), kit, MAX_ARROWS, false, false);
      const tongue = new T.ConeGeometry(0.55, 1.7, 5, 1, true); tongue.translate(0, 0.85, 0);
      this.flames = this.inst(tongue, this.fireMat, MAX_FLAMES, true, false);
      this.dust = this.inst(new T.IcosahedronGeometry(1, 0), this.dustMat, MAX_DUST, false, false);
      this.dust.renderOrder = 4;

      // The figures. Everything about one figure lives at the same index of these arrays.
      const N = MAX;
      this.X = new Float32Array(N); this.Y = new Float32Array(N);         // where he is
      this.H = new Float32Array(N);                                       // the ground under him,
      this.QX = new Float32Array(N); this.QY = new Float32Array(N);       // and where that was last read
      this.TX = new Float32Array(N); this.TY = new Float32Array(N);       // his place in the formation
      this.TF = new Float32Array(N); this.F = new Float32Array(N);        // the way that place faces, and the way he faces
      this.ST = new Float32Array(N); this.SP = new Float32Array(N);       // spear: wanted and now (0 upright)
      this.LT = new Float32Array(N);                                      // how far above the ground his place is (a wall, a ladder)
      this.PH = new Float32Array(N); this.MV = new Float32Array(N);       // stride, and how much he is moving (0..1)
      this.SD = new Float32Array(N);                                      // what makes him himself, 0..1
      this.OW = new Int16Array(N);                                        // whose man he is
      this.FL = new Uint8Array(N);                                        // 1 just raised, 2 dying if nobody takes him in
      this.FB = new Array(N).fill(null);                                  // the body he belongs to
      this.free = new Int32Array(N); this.nfree = N;
      for (let i = 0; i < N; i++) this.free[i] = N - 1 - i;

      this.byKeep = []; this.byArmy = new Map(); this.armies = []; this.all = []; this.loose = [];
      this.tw = [];                                                       // how each town was built, asked once
      this.dead = new Float32Array(MAX_DEAD * 7); this.dnext = 0;         // x, y, h, facing, age, owner, seed
      for (let i = 0; i < MAX_DEAD; i++) this.dead[i * 7 + 4] = 1e9;
      this.shots = new Float32Array(MAX_ARROWS * 9); this.na = 0;         // x0, y0, h0, x1, y1, h1, start, flight, arc
      this.puffs = new Float32Array(MAX_DUST * 6); this.np = 0;           // x, y, h, age, life, size
      this.fights = new Map();                                            // battle id -> what has been shown of it
      this.frame = 0; this.gameTime = game.time; this.rate = 1; this.nearR = NEAR_R;
      this.ex = game.W / 2; this.eh = 1e5; this.ey = game.H / 2;          // the camera, until a view tells us
      this.ox = 0; this.oy = 0; this.of = 0; this.oh = 0;                 // what trail() hands back
      this.bx = 0; this.by = 0; this.bux = 1; this.buy = 0; this.bang = 0;   // what field() hands back
    }

    /** One instanced mesh, empty and hidden until something is put in it. */
    inst(geo, mat, cap, tint, pose) {
      const T = this.T, mesh = new T.InstancedMesh(geo, mat, cap);
      mesh.frustumCulled = false; mesh.count = 0; mesh.visible = false;
      mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
      const a = mesh.instanceMatrix.array;
      for (let i = 0; i < cap; i++) a[i * 16 + 15] = 1;
      if (tint) { mesh.setColorAt(0, this.C.setRGB(1, 1, 1)); mesh.instanceColor.setUsage(T.DynamicDrawUsage); }
      if (pose) {
        const p = new T.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        p.setUsage(T.DynamicDrawUsage);
        geo.setAttribute('aPose', p);
        mesh.userData.pose = p;
      }
      this.group.add(mesh); this.meshes.push(mesh);
      return mesh;
    }

    /** Show the first `n` instances of a mesh and send only those to the card. */
    show(mesh, n) {
      mesh.count = n; mesh.visible = n > 0;
      if (!n) return;
      const m = mesh.instanceMatrix, c = mesh.instanceColor, p = mesh.userData.pose;
      m.updateRange.count = n * 16; m.needsUpdate = true;
      if (c) { c.updateRange.count = n * 3; c.needsUpdate = true; }
      if (p) { p.updateRange.count = n * 3; p.needsUpdate = true; }
    }

    setTheme(theme) {
      this.theme = theme;
      if (theme.dark) this.dustMat.color.setRGB(0.42, 0.45, 0.52); else this.dustMat.color.setRGB(0.84, 0.78, 0.66);
    }

    /** Effects from the simulation. A town taken gets a cheer from the men who took it. */
    ingest(list) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e.type === 'take' && e.how !== 'revolt') { const b = this.byKeep[e.k]; if (b) b.cheer = 3; }
      }
    }

    /** How a town was built: where its wall runs, how high, and where men on it stand. */
    town(id) {
      let tw = this.tw[id];
      if (tw) return tw;
      const site = this.land.sites[id], k = this.game.keeps[id], v = this.view;
      const s = v && v.towns && v.towns.site ? v.towns.site(id) : null;
      const R = s && s.wallR > 0 ? s.wallR : site.r - WALL_INSET[k.tier], H = s && s.wallH > 0 ? s.wallH : WALL_H[k.tier];
      const gate = s && typeof s.gate === 'number' ? s.gate : Math.atan2(site.gate[1], site.gate[0]);
      // On a stone wall men stand on the walk; behind a palisade they stand on a step and look over it.
      tw = { R: R, H: H, gate: gate, at: k.tier === 1 ? R - 1.7 : R - 0.2, up: k.tier === 1 ? 1.3 : H + 0.1 };
      if (v) this.tw[id] = tw;
      return tw;
    }

    body(ref, isKeep) {
      return {
        ref: ref, isKeep: isKeep, owner: -2, held: -2, figs: [], want: 0, seen: 0, battle: null, side: 0,
        pace: 80, run: false, lean: 0, road: 0, lift: 0, hungry: false, grim: false, cheer: 0, wide: 6,
        acx: 0, acy: 0, ar: 0, std: 0, sx: 0, sy: 0, sh: 0, shx: 1e9, shy: 1e9, hc: null, hcAt: -1, dustT: 0,
      };
    }

    /* ----- who needs how many figures ----- */

    census(game) {
      const K = game.keeps, A = game.armies, B = game.battles, stamp = this.frame, all = this.all;
      all.length = 0;
      let total = 0;
      for (let i = 0; i < K.length; i++) {
        const k = K[i];
        let b = this.byKeep[i];
        if (!b) b = this.byKeep[i] = this.body(k, true);
        b.ref = k; b.seen = stamp; b.battle = null; b.owner = k.owner;
        b.want = k.men >= 1 ? clamp(Math.round(k.men / MEN_PER), 1, BODY_CAP) : 0;
        total += b.want; all.push(b);
      }
      for (let i = 0; i < A.length; i++) {
        const a = A[i];
        if (a.men < 1) continue;
        let b = this.byArmy.get(a.id);
        if (!b) { b = this.body(a, false); this.byArmy.set(a.id, b); this.armies.push(b); }
        b.seen = stamp; b.battle = null; b.owner = a.owner;
        b.want = clamp(Math.round(a.men / MEN_PER), 1, BODY_CAP);
        total += b.want; all.push(b);
      }
      if (total > MAX) {
        const f = MAX / total;
        for (let i = 0; i < all.length; i++) if (all[i].want > 1) all[i].want = Math.max(1, Math.floor(all[i].want * f));
      }
      for (let i = 0; i < B.length; i++) {
        const bt = B[i];
        const a = bt.att.army ? this.byArmy.get(bt.att.army.id) : bt.att.keep ? this.byKeep[bt.att.keep.id] : null;
        const d = bt.def.army ? this.byArmy.get(bt.def.army.id) : bt.def.keep ? this.byKeep[bt.def.keep.id] : null;
        if (a) { a.battle = bt; a.side = -1; }
        if (d) { d.battle = bt; d.side = 1; }
      }
    }

    /* ----- figures change hands, are raised, and fall ----- */

    muster() {
      const stamp = this.frame, all = this.all, loose = this.loose;
      loose.length = 0;
      // Bodies that are no more. Their men are there for whoever they joined; if nobody did, and they
      // were starving or fighting, that is where they died.
      for (let i = this.armies.length - 1; i >= 0; i--) {
        const b = this.armies[i];
        if (b.seen === stamp) continue;
        this.release(b, 0, !this.joined(b.ref));
        this.byArmy.delete(b.ref.id);
        this.armies[i] = this.armies[this.armies.length - 1]; this.armies.pop();
      }
      for (let i = 0; i < all.length; i++) {
        const b = all[i];
        if (b.figs.length && b.held !== b.owner) this.release(b, 0, false);       // the town changed hands
        b.held = b.owner;
        if (b.figs.length > b.want) { if (b.battle) this.bleed(b); else this.release(b, b.want, b.grim); }
      }
      // Take in men a neighbour of the same banner has just let go, nearest first; raise the rest.
      for (let i = 0; i < all.length; i++) if (all[i].figs.length < all[i].want) this.adopt(all[i], 95);
      for (let i = 0; i < all.length; i++) {
        const b = all[i];
        if (b.figs.length >= b.want) continue;
        this.adopt(b, 320);
        if (b.figs.length < b.want) this.raise(b);
      }
      for (let i = 0; i < loose.length; i++) {
        const f = loose[i];
        if (f < 0) continue;
        if (this.FL[f] & 2) this.fall(f);
        this.drop(f);
      }
    }

    /** An army that is no longer there either joined its own side (a town, a camp) or was destroyed. */
    joined(a) {
      const K = this.game.keeps, k = K[a.at >= 0 ? a.at : a.path[a.i + 1]];
      return !!k && (k.owner === a.owner || (!!k.camp && k.camp.owner === a.owner));
    }

    /** Let all but `keep` of a body's figures go. `grim`: they are dying, not leaving. */
    release(b, keep, grim) {
      const figs = b.figs;
      while (figs.length > keep) {
        const f = figs.pop();
        this.FL[f] = grim ? 2 : 0;
        this.loose.push(f);
      }
    }

    /** Men lost in a fight fall out of the front rank, and the ranks behind close up. */
    bleed(b) {
      const figs = b.figs;
      while (figs.length > b.want) {
        const n = figs.length, front = Math.min(n - 1, b.wide);
        const j = n > 1 ? 1 + ((Math.random() * front) | 0) : 0, f = figs[j];
        figs[j] = figs[n - 1]; figs.pop();
        this.fall(f); this.drop(f);
      }
    }

    adopt(b, reach) {
      const loose = this.loose, k = b.ref;
      let ax = k.x, ay = k.y;
      if (b.isKeep) { const s = this.land.sites[k.id]; ax = s.yard[0]; ay = s.yard[1]; }
      for (let i = 0; i < loose.length && b.figs.length < b.want; i++) {
        const f = loose[i];
        if (f < 0 || this.OW[f] !== b.owner) continue;
        const dx = this.X[f] - ax, dy = this.Y[f] - ay;
        if (dx * dx + dy * dy > reach * reach) continue;
        loose[i] = -1; this.FB[f] = b; this.FL[f] = 0;
        b.figs.push(f);
      }
    }

    /** New men: a levy comes out of the town gate, anyone else appears where their body is. */
    raise(b) {
      const k = b.ref;
      let sx = k.x, sy = k.y, face = 0;
      if (b.isKeep) { const s = this.land.sites[k.id], tw = this.town(k.id); sx = s.x + Math.cos(tw.gate) * (tw.R + 2.5); sy = s.y + Math.sin(tw.gate) * (tw.R + 2.5); face = tw.gate; }
      while (b.figs.length < b.want && this.nfree > 0) {
        const f = this.free[--this.nfree];
        this.X[f] = sx + jit(f, this.frame) * 2.4; this.Y[f] = sy + jit(this.frame, f) * 2.4;
        this.QX[f] = 1e9; this.H[f] = 0; this.F[f] = face; this.PH[f] = (jit(f, 91) + 0.5) * TAU; this.MV[f] = 0; this.SP[f] = 0; this.LT[f] = 0;
        this.SD[f] = jit(f, 57 + this.frame) + 0.5; this.OW[f] = b.owner; this.FB[f] = b; this.FL[f] = 1;
        b.figs.push(f);
      }
    }

    drop(f) { this.FB[f] = null; this.FL[f] = 0; this.free[this.nfree++] = f; }

    /** Leave a figure lying where he stood (at the foot of the wall, if he was on it). */
    fall(f) {
      const b = this.FB[f], d = this.dead, o = this.dnext * 7;
      let x = this.X[f], y = this.Y[f];
      if (b && b.ar > 0 && this.LT[f] > 0) {
        const rx = x - b.acx, ry = y - b.acy, rr = Math.hypot(rx, ry) || 1, k = (b.ar + 0.2 + Math.random() * 1.6) / rr;
        if (rr < b.ar + 1) { x = b.acx + rx * k; y = b.acy + ry * k; }
      }
      d[o] = x; d[o + 1] = y; d[o + 2] = Math.max(0.3, this.land.heightAt(x, y));
      d[o + 3] = this.F[f] + (Math.random() - 0.5) * 2.6; d[o + 4] = 0; d[o + 5] = this.OW[f]; d[o + 6] = this.SD[f];
      this.dnext = (this.dnext + 1) % MAX_DEAD;
    }

    /* ----- formations: where each figure of a body should be standing now ----- */

    layout(game, t) {
      const K = game.keeps, L = this.land, winter = game.season === 3;
      for (let i = 0; i < K.length; i++) {
        const b = this.byKeep[i], n = b.figs.length;
        b.std = 0; b.grim = false;
        if (!n) continue;
        const k = K[i], site = L.sites[i], tw = this.town(i), bt = b.battle;
        b.pace = 80; b.run = false; b.lean = 0; b.road = 0.05; b.hungry = k.hungry; b.wide = 6;
        b.acx = site.x; b.acy = site.y; b.ar = tw.R + 2.4;
        const camp = k.camp && k.camp.men >= 1 ? k.camp : null;
        if (bt && bt.kind === 'sally') {
          // Part of the garrison is out at the camp; the rest watch from the wall.
          const s = bt.att, out = clamp(Math.round(Math.min(k.men, s.men0 - s.dead) / MEN_PER), 1, n);
          this.layLine(b, bt, -1, 0, out, t);
          if (n > out) this.layWall(b, site, tw, this.bang, out, n - out, 0);
        } else if (bt && bt.kind === 'storm') {
          this.field(bt);
          this.layWall(b, site, tw, this.bang, 0, n, 0.9);
          b.wide = Math.min(n - 1, 26); b.pace = 120;
        } else if (camp) this.layWall(b, site, tw, Math.atan2(camp.y - site.y, camp.x - site.x), 0, n, 0);
        else this.layBlock(b, site);
      }
      for (let i = 0; i < this.armies.length; i++) {
        const b = this.armies[i], a = b.ref, n = b.figs.length;
        b.std = 0;
        if (!n) continue;
        const bt = b.battle, st = a.state === 'fight' && !bt ? a.was : a.state;
        b.hungry = a.hungry; b.grim = a.hungry || winter; b.wide = 6; b.lean = 0; b.run = false;
        const near = st === 'march' ? (a.d < a.len / 2 ? a.path[a.i] : a.path[a.i + 1]) : bt && st === 'fight' ? bt.at : a.at;
        if (near >= 0 && K[near]) { const s = L.sites[near]; b.acx = s.x; b.acy = s.y; b.ar = this.town(near).R + 2.4; } else b.ar = 0;
        if (st === 'fight') {
          if (bt.kind === 'storm' && bt.att.army === a) this.layStorm(b, a, bt, t);
          else this.layLine(b, bt, b.side, 0, n, t);
        } else if (st === 'camp') this.layCamp(b, a);
        else if (a.rout) this.layRout(b, a, t);
        else this.layColumn(b, a);
      }
    }

    /** A garrison drawn up on its muster ground: wider than deep, clear of the road and the wall. */
    layBlock(b, site) {
      const figs = b.figs, n = figs.length, gx = site.gate[0], gy = site.gate[1], px = -gy, py = gx;
      const files = clamp(Math.ceil(Math.sqrt(n * 2.1)), 3, 14), rows = Math.ceil(n / files);
      const cx = site.yard[0] + px * 1.5, cy = site.yard[1] + py * 1.5, face = Math.atan2(gy, gx);
      for (let j = 0; j < n; j++) {
        const i = figs[j], row = (j / files) | 0, inRow = Math.min(files, n - row * files);
        const f = ((rows - 1) / 2 - row) * GAP, s = (j - row * files - (inRow - 1) / 2) * GAP;
        this.TX[i] = cx + gx * f + px * s + jit(i, 3) * 0.3; this.TY[i] = cy + gy * f + py * s + jit(i, 7) * 0.3;
        this.TF[i] = face; this.ST[i] = 0; this.LT[i] = 0;
      }
      const front = (rows - 1) / 2 * GAP + 2.8;
      b.std = 1; b.sx = cx + gx * front; b.sy = cy + gy * front;
    }

    /** `n` figures from `from` lining the wall, thickest where it faces map angle `ang`. */
    layWall(b, site, tw, ang, from, n, spear) {
      const figs = b.figs, step = 1.75 / tw.at, ring = Math.max(8, Math.floor(TAU / step) - 1);
      for (let m = 0; m < n; m++) {
        const i = figs[from + m], back = (m / ring) | 0, a = ang + spread(m - back * ring) * step, r = tw.at - back * 1.7;
        this.TX[i] = site.x + Math.cos(a) * r; this.TY[i] = site.y + Math.sin(a) * r;
        this.TF[i] = a; this.ST[i] = back ? 0 : spear; this.LT[i] = back ? 0 : tw.up;      // no room for a second rank up there
      }
    }

    /**
     * The point `back` behind the head of a column, along the road it has come by, and `lat` to the side.
     * Columns stop short of walls they cannot yet pass: men who would be inside a town they are setting out
     * from wait outside its gate, and the head halts outside the gate (or the reach) of the town it is making for.
     * Writes ox, oy, of (facing) and oh (0 on the road, 1 waiting to set out, 2 halted at the end).
     */
    trail(a, back, lat, j) {
      const K = this.game.keeps, path = a.path;
      let i = a.i, P = K[path[i]], Q = K[path[i + 1]] || P, len = a.len || 1, s = a.d - back, held = 0, how = 0;
      if (i + 2 >= path.length || Q.owner !== a.owner || Q.camp) {
        const stop = len - (Q.owner === a.owner && !Q.camp ? this.town(Q.id).R + 4 : this.land.sites[Q.id].r + 10);
        if (s > stop) { held = s - stop; s = stop; how = 2; }
      }
      while (s < 0 && i > 0) { i--; Q = P; P = K[path[i]]; len = Math.hypot(Q.x - P.x, Q.y - P.y) || 1; s += len; }
      if (i === 0) {
        const start = this.town(P.id).R + 4;
        if (s < start) { held = start - s; s = start; how = 1; }
      }
      const dx = (Q.x - P.x) / len, dy = (Q.y - P.y) / len;
      if (how) {
        // Men who are waiting stand in a knot, not on one spot.
        lat = lat * Math.min(5, 1 + held * 0.2) + jit(j, 5) * Math.min(7, held * 0.3);
        s += (how === 1 ? 1 : -1) * (j % 4) * 1.5;
      }
      this.ox = P.x + dx * s - dy * lat; this.oy = P.y + dy * s + dx * lat; this.of = Math.atan2(dy, dx); this.oh = how;
    }

    /** On the road: the standard-bearer, then two abreast, so they pass any gate. Hungry men straggle. */
    layColumn(b, a) {
      const figs = b.figs, n = figs.length, rag = a.hungry ? 1 : 0;
      b.pace = 150; b.road = 0.33; b.std = 2; b.lean = rag * 0.22;
      for (let j = 0; j < n; j++) {
        const i = figs[j], back = j ? 1 + ((j + 1) >> 1) * 2 : 0, lat = j ? (j & 1 ? -0.78 : 0.78) : 0;
        this.trail(a, back + jit(i, 11) * (0.3 + rag * 2.6), lat + jit(i, 13) * (0.2 + rag * 2.4), j);
        this.TX[i] = this.ox; this.TY[i] = this.oy; this.TF[i] = this.of;
        this.ST[i] = rag ? 0.25 + (jit(i, 23) + 0.5) * 0.5 : 0.06; this.LT[i] = 0;
      }
    }

    /** Broken: no ranks, no standard, every man for himself down the road and the fields beside it. */
    layRout(b, a, t) {
      const figs = b.figs, n = figs.length, deep = Math.min(70, 12 + n * 0.9), wide = Math.min(22, 7 + n * 0.25);
      b.pace = 170; b.run = true; b.road = 0.2; b.lean = 0.34;
      for (let j = 0; j < n; j++) {
        const i = figs[j], sway = this.calm ? 0 : Math.sin(t * 2.3 + i) * 1.3;
        this.trail(a, 1 + (jit(i, 17) + 0.5) * deep, jit(i, 19) * wide + sway, j);
        this.TX[i] = this.ox; this.TY[i] = this.oy; this.TF[i] = this.of;
        this.ST[i] = 0.4 + (jit(i, 23) + 0.5) * 0.9; this.LT[i] = 0;
      }
    }

    /** A siege camp: two men in three stand to in an arc facing the wall, the third sits by a fire. */
    layCamp(b, a) {
      const site = this.land.sites[a.at], figs = b.figs, n = figs.length;
      const ang = Math.atan2(a.y - site.y, a.x - site.x), R0 = site.r + 10.5, rf = site.r + 24.5;
      const fires = clamp(Math.ceil(n / 14), 1, 8), cap = Math.max(6, Math.floor(1.9 * R0 / 2.3)), line = n - ((n / 3) | 0);
      b.pace = 90; b.road = 0.05;
      for (let j = 0; j < n; j++) {
        const i = figs[j];
        if (j % 3 === 2) {
          const q = ((j / 3) | 0) % fires, fa = ang + spread(q) * 10 / rf, sa = j * 2.399, sr = 2.6 + (((j / 3 / fires) | 0) % 2) * 1.3;
          this.TX[i] = site.x + Math.cos(fa) * rf + Math.cos(sa) * sr; this.TY[i] = site.y + Math.sin(fa) * rf + Math.sin(sa) * sr;
          this.TF[i] = sa + Math.PI; this.ST[i] = 0.1;
        } else {
          const m = j - ((j / 3) | 0), ring = (m / cap) | 0, inRing = Math.min(cap, line - ring * cap);
          const r = R0 + ring * 2.35, th = ang + (m - ring * cap - (inRing - 1) / 2) * 2.3 / r;
          this.TX[i] = site.x + Math.cos(th) * r + jit(i, 3) * 0.3; this.TY[i] = site.y + Math.sin(th) * r + jit(i, 7) * 0.3;
          this.TF[i] = th + Math.PI; this.ST[i] = 0;
        }
        this.LT[i] = 0;
      }
      b.std = 1; b.sx = site.x + Math.cos(ang) * (site.r + 21.6); b.sy = site.y + Math.sin(ang) * (site.r + 21.6);
    }

    /**
     * Where a battle is fought and which way it faces: bx, by is the middle of it, (bux, buy) points from the
     * attackers to the defenders, bang is the side of the town it is on. A fight at a town is moved out clear
     * of the wall; a storm is set at the foot of it.
     */
    field(bt) {
      const K = this.game.keeps;
      if (bt.at < 0) {
        const a = bt.att.army, P = K[a.path[a.i]], Q = K[a.path[a.i + 1]] || P, d = Math.hypot(Q.x - P.x, Q.y - P.y) || 1;
        this.bux = (Q.x - P.x) / d; this.buy = (Q.y - P.y) / d; this.bx = bt.x; this.by = bt.y; this.bang = 0;
        return;
      }
      const site = this.land.sites[bt.at], camp = bt.kind === 'storm' ? bt.att.army : bt.def.army;
      const ang = camp ? Math.atan2(camp.y - site.y, camp.x - site.x) : Math.atan2(bt.y - site.y, bt.x - site.x);
      const o0 = Math.cos(ang), o1 = Math.sin(ang), out = bt.kind === 'sally' ? 1 : -1;
      const r = bt.kind === 'storm' ? this.town(bt.at).R + 2.6 : Math.max(34, site.r + 13);
      this.bx = site.x + o0 * r; this.by = site.y + o1 * r; this.bux = o0 * out; this.buy = o1 * out; this.bang = ang;
    }

    /**
     * A line of battle: `cnt` figures from `from`, on one side (-1 attackers, 1 defenders). They come on at
     * a run with spears levelled, the front ranks heave to and fro, and the side that is losing gives ground.
     */
    layLine(b, bt, side, from, cnt, t) {
      this.field(bt);
      const figs = b.figs, u0 = this.bux, u1 = this.buy, px = -u1, py = u0;
      const shift = (bt.win ? 1 : -1) * 4.5 * smooth(0.45, 1, bt.t / bt.dur);
      const cx = this.bx + u0 * shift, cy = this.by + u1 * shift, gap = 1.25 + 8 * (1 - smooth(0, 0.7, bt.t));
      const wide = clamp(Math.ceil(Math.sqrt(cnt * 2.6)), 3, 24), rows = Math.ceil((cnt - 1) / wide) || 1;
      const face = Math.atan2(-side * u1, -side * u0), calm = this.calm;
      b.pace = 135; b.run = true; b.lean = 0.16; b.road = 0.1; b.std = 2; b.wide = wide;
      for (let j = 0; j < cnt; j++) {
        const i = figs[from + j];
        let row = rows + 0.7, col = 0;                                   // the standard, behind the middle of the line
        if (j) { const m = j - 1; row = (m / wide) | 0; col = m - row * wide - (Math.min(wide, cnt - 1 - row * wide) - 1) / 2; }
        const churn = calm || row > 1.5 ? 0 : Math.sin(t * 7 + i * 1.9) * (row < 0.5 ? 0.65 : 0.3);
        const f = gap + row * 1.75 - churn;
        this.TX[i] = cx + side * u0 * f + px * col * 1.55 + jit(i, 29) * 0.3; this.TY[i] = cy + side * u1 * f + py * col * 1.55 + jit(i, 31) * 0.3;
        this.TF[i] = face; this.LT[i] = 0;
        this.ST[i] = row < 0.5 ? 1.15 + (calm ? 0 : Math.sin(t * 9 + i) * 0.22) : row < 1.5 ? 0.7 : 0.12;
      }
    }

    /** A storm: the camp goes at the wall on its own side, some of the front rank up the ladders. */
    layStorm(b, a, bt, t) {
      const site = this.land.sites[bt.at], tw = this.town(bt.at), figs = b.figs, n = figs.length;
      const ang = Math.atan2(a.y - site.y, a.x - site.x), R = tw.R + 2.1;
      const wide = clamp(Math.ceil(Math.sqrt(n * 4)), 6, 34), rows = Math.ceil((n - 1) / wide) || 1, nl = clamp(Math.ceil(n / 8), 3, 9);
      b.pace = 125; b.run = true; b.lean = 0.14; b.road = 0.05; b.std = 2; b.wide = wide;
      for (let j = 0; j < n; j++) {
        const i = figs[j];
        let r = R + rows * 1.7 + 2.5, th = ang, lift = 0, spear = 0.1;
        if (j) {
          const m = j - 1, row = (m / wide) | 0;
          r = R + row * 1.7; th = ang + (m - row * wide - (Math.min(wide, n - 1 - row * wide) - 1) / 2) * 1.6 / r;
          spear = row ? 0.15 : 0.5;
          if (!row && m % 4 === 1) {
            // On a ladder: climbing, over and over, for as long as the storm lasts.
            const climb = this.calm ? 0.55 : (t * 0.5 + i * 0.37) % 1;
            th = ang + spread(((m / 4) | 0) % nl) * 5.2 / tw.R; r = tw.R + 0.8 + tw.H * 0.3 * (1 - climb); lift = tw.H * (0.15 + 0.8 * climb); spear = 0;
          }
        }
        this.TX[i] = site.x + Math.cos(th) * r; this.TY[i] = site.y + Math.sin(th) * r;
        this.TF[i] = th + Math.PI; this.ST[i] = spear; this.LT[i] = lift;
      }
    }

    /* ----- every figure takes a step towards his place, and is drawn ----- */

    /** Write a transform: at (x, h, y), turned to face map angle `face`, tipped `lean` forwards, scaled. */
    mat(arr, o, x, h, y, face, lean, s, sy) {
      const th = HALF - face, c = Math.cos(th), sn = Math.sin(th);
      let cl = 1, sl = 0;
      if (lean) { cl = Math.cos(lean); sl = Math.sin(lean); }
      arr[o] = c * s; arr[o + 1] = 0; arr[o + 2] = -sn * s;
      arr[o + 4] = sn * sl * sy; arr[o + 5] = cl * sy; arr[o + 6] = c * sl * sy;
      arr[o + 8] = sn * cl * s; arr[o + 9] = -sl * s; arr[o + 10] = c * cl * s;
      arr[o + 12] = x; arr[o + 13] = h; arr[o + 14] = y;
    }

    march(dt, t, game, first) {
      const th = this.theme, L = this.land, all = this.all, calm = this.calm;
      const X = this.X, Y = this.Y, H = this.H, QX = this.QX, QY = this.QY, TX = this.TX, TY = this.TY, TF = this.TF, F = this.F;
      const ST = this.ST, SP = this.SP, LT = this.LT, PH = this.PH, MV = this.MV, SD = this.SD, FL = this.FL;
      const near = this.near, far = this.far;
      const nm = near.instanceMatrix.array, fm = far.instanceMatrix.array, nc = near.instanceColor.array, fc = far.instanceColor.array;
      const np = near.userData.pose.array, fp = far.userData.pose.array;
      const ex = this.ex, eh = this.eh, ey = this.ey, nr2 = this.nearR * this.nearR;
      const ease = Math.min(1, dt * 10), turn = Math.min(1, dt * 12);
      let nn = 0, nf = 0;

      for (let q = 0; q < all.length; q++) {
        const b = all[q], figs = b.figs, n = figs.length;
        if (!n) continue;
        const col = b.owner < 0 ? th.free : th.f[game.factions[b.owner].color];
        let cr = col[0] / 255, cg = col[1] / 255, cb = col[2] / 255;
        if (b.hungry) { const grey = (cr + cg + cb) / 3 * 0.86; cr += (grey - cr) * 0.42; cg += (grey - cg) * 0.42; cb += (grey - cb) * 0.42; }   // drawn and grey with hunger
        const pace = b.pace * this.rate * dt, beat = b.run ? 17 : 11.5, snap = first, ar = b.ar, ar2 = ar * ar;
        b.lift += (b.road - b.lift) * Math.min(1, dt * 5);
        if (b.cheer > 0) b.cheer -= dt;
        const cheer = b.cheer > 0 && !calm && !b.battle;
        for (let j = 0; j < n; j++) {
          const i = figs[j];
          let x = X[i], y = Y[i], want = TF[i], moving = 0, up = 0;
          if (FL[i] & 1) { FL[i] = 0; if (snap) { x = TX[i]; y = TY[i]; F[i] = want; SP[i] = ST[i]; } }
          const dx = TX[i] - x, dy = TY[i] - y, d = Math.sqrt(dx * dx + dy * dy);
          if (d > 0.03) {
            const step = d < pace ? d : pace;
            x += dx / d * step; y += dy / d * step;
            if (ar > 0) {
              // Round the town, not through its wall, unless his place is inside it.
              const rx = x - b.acx, ry = y - b.acy, rr = rx * rx + ry * ry, tx = TX[i] - b.acx, ty = TY[i] - b.acy;
              if (rr < ar2 && rr > 0.01 && tx * tx + ty * ty >= ar2) { const k = ar / Math.sqrt(rr); x = b.acx + rx * k; y = b.acy + ry * k; }
            }
            if (step > 3 * dt) moving = 1;
            if (d > 1.2) want = Math.atan2(dy, dx);
          } else { x = TX[i]; y = TY[i]; }
          let df = want - F[i];
          df -= TAU * Math.round(df / TAU);
          F[i] += df * turn;
          MV[i] += (moving - MV[i]) * ease;
          SP[i] += (ST[i] - SP[i]) * ease;
          if (Math.abs(x - QX[i]) + Math.abs(y - QY[i]) > 0.3) { H[i] = Math.max(0.3, L.heightAt(x, y)); QX[i] = x; QY[i] = y; }
          X[i] = x; Y[i] = y;
          if (LT[i] > 0) up = LT[i] * (1 - smooth(0.4, 3.5, d));
          let hop = 0, spear = SP[i], stride = 0;
          if (!calm) {
            PH[i] += dt * beat * MV[i];
            hop = Math.abs(Math.sin(PH[i])) * 0.2 * MV[i];
            stride = 0.36 * MV[i];
            if (cheer) { const w = t * 8 + SD[i] * 40; hop += Math.abs(Math.sin(w)) * 0.7; spear = Math.sin(w * 0.5) * 0.35; }
          }
          const h = H[i] + b.lift + up + hop;
          const ax = x - ex, ah = h - eh, ay = y - ey, d2 = ax * ax + ah * ah + ay * ay;
          let s = 0.95 + SD[i] * 0.1;
          if (d2 > 302500) s *= Math.min(2.2, Math.sqrt(d2) / 550);       // larger than life from far off, so the mass still reads
          const shade = 0.9 + SD[i] * 0.2, lean = b.lean * MV[i];
          if (d2 < nr2 && nn < NEAR_MAX) {
            this.mat(nm, nn * 16, x, h, y, F[i], lean, s, s);
            const o = nn * 3; nc[o] = cr * shade; nc[o + 1] = cg * shade; nc[o + 2] = cb * shade;
            np[o] = PH[i]; np[o + 1] = stride; np[o + 2] = spear;
            nn++;
          } else {
            this.mat(fm, nf * 16, x, h, y, F[i], lean, s, s);
            const o = nf * 3; fc[o] = cr * shade; fc[o + 1] = cg * shade; fc[o + 2] = cb * shade;
            fp[o] = PH[i]; fp[o + 1] = stride; fp[o + 2] = spear;
            nf++;
          }
        }
      }

      // The fallen: they go down, lie a while, and sink into the ground.
      const D = this.dead;
      for (let i = 0; i < MAX_DEAD; i++) {
        const o = i * 7, age = D[o + 4];
        if (age >= DEAD_FOR) continue;
        D[o + 4] = age + dt;
        const owner = D[o + 5], col = owner < 0 ? th.free : th.f[game.factions[owner].color], k = 0.6 * (0.9 + D[o + 6] * 0.2);
        const down = calm ? 1 : smooth(0, 0.32, age), sink = smooth(DEAD_FOR - 1.6, DEAD_FOR, age);
        this.mat(fm, nf * 16, D[o], D[o + 2] + 0.32 * down - sink * 1.1, D[o + 1], D[o + 3], HALF * down, 1, 1);
        const c = nf * 3; fc[c] = col[0] / 255 * k; fc[c + 1] = col[1] / 255 * k; fc[c + 2] = col[2] / 255 * k;
        fp[c] = 0; fp[c + 1] = 0; fp[c + 2] = -0.25;
        nf++;
      }

      this.show(near, nn); this.show(far, nf);
      // Keep the fuller figure for the men nearest the camera when there are more in reach than we may draw.
      if (nn >= NEAR_MAX) this.nearR = Math.max(170, this.nearR * 0.94);
      else if (nn < NEAR_MAX * 0.7) this.nearR = Math.min(NEAR_R, this.nearR * 1.03);
    }

    /* ----- everything that is not a man: standards, baggage, camps, engines, arrows, dust ----- */

    flame(n, x, h, y, s, lick, core) {
      if (n >= MAX_FLAMES) return n;
      this.mat(this.flames.instanceMatrix.array, n * 16, x, h, y, n * 1.7, 0, s, s * lick);
      const c = this.flames.instanceColor.array, o = n * 3;
      c[o] = 1; c[o + 1] = core ? 0.84 : 0.52; c[o + 2] = core ? 0.42 : 0.12;
      return n + 1;
    }

    puff(x, y, h, size) {
      if (this.np >= MAX_DUST) return;
      const P = this.puffs, o = this.np++ * 6;
      P[o] = x; P[o + 1] = y; P[o + 2] = h; P[o + 3] = 0; P[o + 4] = 0.9 + Math.random() * 0.7; P[o + 5] = size;
    }

    /** Both sides loose as the lines close; in a storm the wall shoots down and the camp shoots up. */
    volley(bt, t) {
      const S = this.shots, storm = bt.kind === 'storm', u0 = this.bux, u1 = this.buy, px = -u1, py = u0;
      const h0 = Math.max(0.3, this.land.heightAt(this.bx, this.by)), wall = storm ? this.town(bt.at).H : 0;
      const wide = Math.min(20, 4 + Math.sqrt(bt.att.men0 + bt.def.men0) * 0.4);
      for (let side = -1; side <= 1; side += 2) {
        const men = side < 0 ? bt.att.men0 : bt.def.men0, n = clamp(Math.round(men / 40), 3, 22);
        const from = storm && side > 0 ? 2.5 : 9, hf = storm && side > 0 ? wall + 2 : 2, ht = storm && side < 0 ? wall + 1.5 : 1;
        for (let i = 0; i < n && this.na < MAX_ARROWS; i++) {
          const o = this.na++ * 9, s = (Math.random() - 0.5) * 2 * wide, f = from + Math.random() * 7, g = (storm && side < 0 ? 2.5 : 3) + Math.random() * 7;
          S[o] = this.bx + side * u0 * f + px * s; S[o + 1] = this.by + side * u1 * f + py * s; S[o + 2] = h0 + hf;
          S[o + 3] = this.bx - side * u0 * g + px * (s + (Math.random() - 0.5) * 5); S[o + 4] = this.by - side * u1 * g + py * (s + (Math.random() - 0.5) * 5); S[o + 5] = h0 + ht;
          S[o + 6] = t + Math.random() * 0.5; S[o + 7] = 0.55 + Math.random() * 0.3; S[o + 8] = 5 + Math.random() * 3.5;
        }
      }
    }

    dress(dt, t, game) {
      const L = this.land, th = this.theme, calm = this.calm, all = this.all, carry = BC.CARRY || 10;
      let ns = 0, nt = 0, nw = 0, nfl = 0, nl = 0, nm = 0, ne = 0;
      const sm = this.flags.instanceMatrix.array, sc = this.flags.instanceColor.array;
      const tm = this.tents.instanceMatrix.array, wm = this.wagons.instanceMatrix.array, lm = this.ladders.instanceMatrix.array;
      const mm = this.mantlets.instanceMatrix.array, em = this.engines.instanceMatrix.array, ep = this.engines.userData.pose.array;

      // Standards: planted before a garrison or a camp, carried at the head of a column and behind a line of battle.
      // Like the towns' banners they are drawn larger from far away, so an army can be found with the whole realm in view.
      for (let i = 0; i < all.length && ns < MAX_FLAGS; i++) {
        const b = all[i];
        if (!b.figs.length || !b.std) continue;
        let x = b.sx, y = b.sy, h = 0;
        if (b.std === 2) { const f = b.figs[0]; x = this.X[f] + 0.5; y = this.Y[f] + 0.3; h = this.H[f] + b.lift; }
        else { if (b.shx !== x || b.shy !== y) { b.sh = Math.max(0.3, L.heightAt(x, y)); b.shx = x; b.shy = y; } h = b.sh; }
        const dx = x - this.ex, dh = h - this.eh, dy = y - this.ey, s = clamp(Math.sqrt(dx * dx + dh * dh + dy * dy) / 400, 1, 3.4);
        this.mat(sm, ns * 16, x, h, y, WIND + HALF, 0, s, s);
        const col = b.owner < 0 ? th.free : th.f[game.factions[b.owner].color], o = ns * 3;
        sc[o] = col[0] / 255; sc[o + 1] = col[1] / 255; sc[o + 2] = col[2] / 255;
        ns++;
      }

      for (let i = 0; i < this.armies.length; i++) {
        const b = this.armies[i], a = b.ref, n = b.figs.length;
        if (!n) continue;
        const bt = b.battle;
        if (a.state === 'camp' || (a.state === 'fight' && a.was === 'camp')) {
          const site = L.sites[a.at], tw = this.town(a.at), ang = Math.atan2(a.y - site.y, a.x - site.x);
          // Nothing in a camp moves, so the ground under each thing is read once and kept.
          if (!b.hc) b.hc = new Float32Array(64);
          if (b.hcAt !== a.at) { b.hc.fill(-1); b.hcAt = a.at; }
          const hc = b.hc;
          const tents = clamp(Math.ceil(a.men / 55), 2, 18);
          for (let q = 0; q < tents && nt < MAX_TENTS; q++) {
            const row = q & 1, r = site.r + 30.5 + row * 6.6, an = ang + (spread(q >> 1) + row * 0.5) * 8.6 / r;
            const x = site.x + Math.cos(an) * r, y = site.y + Math.sin(an) * r, s = 1 + jit(q, 3) * 0.16;
            if (hc[q] < 0) hc[q] = Math.max(0.3, L.heightAt(x, y));
            this.mat(tm, nt++ * 16, x, hc[q], y, an + jit(q, a.id) * 0.6, 0, s, s);
          }
          const fires = clamp(Math.ceil(n / 14), 1, 8), rf = site.r + 24.5, low = a.hungry ? 0.55 : 1;
          for (let q = 0; q < fires; q++) {
            const an = ang + spread(q) * 10 / rf, x = site.x + Math.cos(an) * rf, y = site.y + Math.sin(an) * rf;
            if (hc[20 + q] < 0) hc[20 + q] = Math.max(0.3, L.heightAt(x, y));
            const lick = calm ? 1 : 1 + 0.2 * Math.sin(t * 11 + q * 2.3 + a.id) + 0.1 * Math.sin(t * 23 + q);
            nfl = this.flame(nfl, x, hc[20 + q], y, 1.15 * low, lick, false);
            nfl = this.flame(nfl, x, hc[20 + q] + 0.05, y, 0.62 * low, lick * 1.12, true);
          }
          if (bt && bt.kind === 'storm' && bt.att.army === a) {
            // Ladders against the wall.
            const up = clamp(Math.ceil(n / 8), 3, 9), r = tw.R + 0.75 + tw.H * 0.3;
            for (let q = 0; q < up && nl < MAX_LADDERS; q++) {
              const an = ang + spread(q) * 5.2 / tw.R, x = site.x + Math.cos(an) * r, y = site.y + Math.sin(an) * r;
              this.mat(lm, nl++ * 16, x, site.h, y, an + Math.PI, 0.29, 1, tw.H * 1.14);
            }
          } else if (a.breach >= 0.35) {
            // Ladders knocked together and laid ready.
            const made = 2 + Math.round(a.breach * 4), r = site.r + 9.2;
            for (let q = 0; q < made && nl < MAX_LADDERS; q++) {
              const an = ang + (spread(q) * 6.4 + 3.2) / r, x = site.x + Math.cos(an) * r, y = site.y + Math.sin(an) * r;
              if (hc[30 + q] < 0) hc[30 + q] = Math.max(0.3, L.heightAt(x, y));
              this.mat(lm, nl++ * 16, x, hc[30 + q] + 0.25, y, an + Math.PI, 1.42, 1, 6.4);
            }
          }
          if (a.breach >= 0.1) {
            const made = clamp(Math.round(2 + a.breach * 9), 2, 10), r = site.r + 8.2;
            for (let q = 0; q < made && nm < MAX_MANTLETS; q++) {
              const an = ang + spread(q) * 6.4 / r, x = site.x + Math.cos(an) * r, y = site.y + Math.sin(an) * r;
              if (hc[38 + q] < 0) hc[38 + q] = Math.max(0.3, L.heightAt(x, y));
              this.mat(mm, nm++ * 16, x, hc[38 + q], y, an + Math.PI, -0.3, 1, 1);
            }
          }
          if (a.breach >= 0.5) {
            const made = a.breach > 0.85 && a.men > 600 ? 2 : 1, r = site.r + 25;
            for (let q = 0; q < made && ne < MAX_ENGINES; q++) {
              const an = ang + (q ? -1 : 1) * (Math.ceil(fires / 2) * 10 + 9) / r, x = site.x + Math.cos(an) * r, y = site.y + Math.sin(an) * r;
              if (hc[50 + q] < 0) hc[50 + q] = Math.max(0.3, L.heightAt(x, y));
              // The arm is hauled down slowly and let fly.
              const p = calm ? 0.5 : (t / 5.5 + q * 0.37 + a.id * 0.21) % 1;
              ep[ne * 3] = 0; ep[ne * 3 + 1] = 0; ep[ne * 3 + 2] = p < 0.07 ? -2 + 2.45 * (p / 0.07) : 0.45 - 2.45 * smooth(0.07, 1, p);
              this.mat(em, ne++ * 16, x, hc[50 + q], y, an + Math.PI, 0, 2.3, 2.3);
            }
          }
        } else if (a.state === 'march' && !a.rout) {
          // Baggage at the rear: as many wagons as they have bread for, none when it is gone.
          const share = clamp(a.food / Math.max(1, a.men * carry), 0, 1), wag = a.hungry ? 0 : clamp(Math.ceil(a.men / 120), 1, 6) * share;
          const rear = 1 + ((n + 1) >> 1) * 2 + 4.5;
          for (let q = 0; q < wag && nw < MAX_WAGONS; q++) {
            this.trail(a, rear + q * 6.4, 0, q);
            if (this.oh) continue;
            const s = 0.55 + 0.45 * Math.min(1, wag - q);
            this.mat(wm, nw++ * 16, this.ox, Math.max(0.3, L.heightAt(this.ox, this.oy)) + 0.33, this.oy, this.of, 0, s, s);
          }
        } else if (a.rout && !calm) {
          b.dustT -= dt;
          if (b.dustT <= 0) { b.dustT = 0.1; const f = b.figs[(Math.random() * n) | 0]; this.puff(this.X[f], this.Y[f], this.H[f] + 0.6, 0.9 + Math.random()); }
        }
      }

      // Battles: a volley as the lines close, and the dust they raise.
      const B = game.battles;
      for (let i = 0; i < B.length; i++) {
        const bt = B[i];
        let st = this.fights.get(bt.id);
        if (!st) { st = { seen: 0, puff: 0, shot: false }; this.fights.set(bt.id, st); }
        st.seen = this.frame;
        if (calm) continue;
        this.field(bt);
        if (!st.shot) { st.shot = true; this.volley(bt, t); }
        st.puff -= dt;
        if (st.puff <= 0) {
          st.puff = 0.08;
          const w = Math.min(18, 3 + Math.sqrt(bt.att.men0 + bt.def.men0) * 0.35), s = (Math.random() - 0.5) * 2 * w, f = (Math.random() - 0.5) * 4;
          const x = this.bx - this.buy * s + this.bux * f, y = this.by + this.bux * s + this.buy * f;
          this.puff(x, y, Math.max(0.3, L.heightAt(x, y)) + 0.8, 1.1 + Math.random() * 1.3);
        }
      }
      if (this.fights.size > B.length) for (const e of this.fights) if (e[1].seen !== this.frame) this.fights.delete(e[0]);

      // Arrows in the air.
      const S = this.shots, am = this.arrows.instanceMatrix.array;
      let nar = 0;
      for (let i = this.na - 1; i >= 0; i--) {
        const o = i * 9, k = (t - S[o + 6]) / S[o + 7];
        if (k >= 1 || k < -2) { this.na--; if (i !== this.na) S.copyWithin(o, this.na * 9, this.na * 9 + 9); continue; }
        if (k < 0) continue;
        const vx = S[o + 3] - S[o], vz = S[o + 4] - S[o + 1], vy = S[o + 5] - S[o + 2] + S[o + 8] * 4 * (1 - 2 * k);
        const vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1, ux = vx / vl, uy = vy / vl, uz = vz / vl;
        const sl = Math.sqrt(ux * ux + uz * uz) || 1, sx = -uz / sl, sz = ux / sl, m = nar++ * 16;
        am[m] = sx; am[m + 1] = 0; am[m + 2] = sz;
        am[m + 4] = ux; am[m + 5] = uy; am[m + 6] = uz;
        am[m + 8] = -sz * uy; am[m + 9] = sz * ux - sx * uz; am[m + 10] = sx * uy;
        am[m + 12] = S[o] + vx * k; am[m + 13] = S[o + 2] + (S[o + 5] - S[o + 2]) * k + S[o + 8] * 4 * k * (1 - k); am[m + 14] = S[o + 1] + vz * k;
      }

      // Dust: each puff swells as it lifts, then thins away.
      const P = this.puffs, dm = this.dust.instanceMatrix.array;
      let nd = 0;
      for (let i = this.np - 1; i >= 0; i--) {
        const o = i * 6;
        P[o + 3] += dt;
        const k = P[o + 3] / P[o + 4];
        if (k >= 1) { this.np--; if (i !== this.np) P.copyWithin(o, this.np * 6, this.np * 6 + 6); continue; }
        const s = P[o + 5] * (0.55 + 1.5 * k) * (1 - smooth(0.55, 1, k));
        this.mat(dm, nd++ * 16, P[o], P[o + 2] + k * 3.2, P[o + 1], i * 2.4, 0, s, s * 0.8);
      }

      this.show(this.flags, ns); this.show(this.tents, nt); this.show(this.wagons, nw); this.show(this.flames, nfl);
      this.show(this.ladders, nl); this.show(this.mantlets, nm); this.show(this.engines, ne);
      this.show(this.arrows, nar); this.show(this.dust, nd);
    }

    /** Called every frame: bring every figure a step nearer its place in the simulation as it stands now. */
    update(dt, game, t, view) {
      if (!this.theme) return;
      this.game = game;
      if (view) this.view = view;
      const first = this.frame === 0;
      this.frame++;
      dt = dt > 0 ? Math.min(dt, 0.1) : 0;
      // How fast the simulation is running against the clock, so men keep up if time is hurried along.
      const gone = game.time - this.gameTime;
      this.gameTime = game.time;
      this.rate += ((dt > 0 && gone > 0 ? clamp(gone / dt, 1, 8) : 1) - this.rate) * 0.2;
      this.uni.uTime.value = this.calm ? 0 : t;
      const cam = this.view && this.view.camera ? this.view.camera.position : null;
      if (cam) { this.ex = cam.x; this.eh = cam.y; this.ey = cam.z; }
      this.census(game);
      this.muster();
      this.layout(game, t);
      this.march(dt, t, game, first);
      this.dress(dt, t, game);
    }

    dispose() {
      this.scene.remove(this.group);
      for (const m of this.meshes) { m.geometry.dispose(); m.dispose(); }
      this.kit.dispose(); this.clothMat.dispose(); this.fireMat.dispose(); this.dustMat.dispose();
      this.meshes.length = 0; this.byArmy.clear(); this.fights.clear();
    }
  }

  BC.Units = Units;
  BC.MEN_PER = MEN_PER;
})();
