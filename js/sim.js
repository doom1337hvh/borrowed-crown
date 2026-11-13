/*
 * Borrowed Crown: simulation core.
 *
 * Pure rules, no DOM, so the same file runs in the browser and under Node (see test/).
 *
 * The one law everything else follows: nobody appears from nowhere.
 * Soldiers are levied out of a town's population, eat from its granary, and when
 * they die they stay dead. `ledger` keeps the books so the tests can audit it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BC = Object.assign(root.BC || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- the numbers the world runs on ---------- */

  const YEAR = 80;                 // seconds in a year
  const SEASON = YEAR / 4;
  const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
  const HARVEST = [0.6, 1.0, 1.6, 0];   // how much the land gives, season by season
  const SPEED = 72;                // marching speed, world units per second
  const YIELD = 0.05;              // surplus rations per civilian per second at harvest 1.0
  const GRANARY = 6;               // granary size, rations per head of settled population
  const CARRY = 10;                // seconds of rations a marching man can carry
  const ROAD_CAP = 220;            // rations per second one road can haul
  const SIEGE_APPETITE = 0.2;      // rations per civilian per second inside invested walls
  const HUNGER = 0.05;             // share of unfed men lost per second
  const FROST = 0.01;              // share of men in the field lost per second of winter
  const BREACH_TIME = 45;          // seconds of siege work to bring the walls as low as they go
  const GRACE = 40;                // seconds before rivals will march on the player
  const MAX_RIVALS = 6;
  const PLAYER = 0;

  const TIERS = [null,
    { key: 'village', label: 'Village', pop: [5000, 8000], wall: 1.5 },
    { key: 'town', label: 'Town', pop: [11000, 17000], wall: 2.4 },
    { key: 'city', label: 'City', pop: [22000, 32000], wall: 3.6 },
  ];

  // How hard a realm leans on its people. `cap` is the share that can stand ready,
  // `grow` the share that comes of age and is called up each year.
  const LEVY = {
    light: { label: 'Light levy', cap: 0.03, grow: 0.008, unrest: -0.05 },
    standard: { label: 'Standard levy', cap: 0.06, grow: 0.014, unrest: 0 },
    heavy: { label: 'Heavy levy', cap: 0.10, grow: 0.022, unrest: 0.15 },
  };

  const TEMPERS = [
    { key: 'bold', storm: 1.3, caution: 0.7, tempo: 0.9, bold: true },
    { key: 'steady', storm: 1.7, caution: 1.0, tempo: 1.0, bold: false },
    { key: 'wary', storm: 2.2, caution: 1.3, tempo: 1.15, bold: false },
  ];

  const HOUSES = ['House Varn', 'House Morrow', 'House Ysolde', 'House Calder', 'House Brandt',
    'The Ashen League', 'The Salt League', 'The Marsh Lords', 'The Free Banners', 'The Hill Clans',
    'Order of the Thorn', 'The River Lords'];

  const TOWNS = ['Carrow', 'Eldmoor', 'Dunmere', 'Blackfen', 'Harrowgate', 'Wyrmford', 'Stonehythe',
    'Thornwick', 'Greywatch', 'Kestrel Rock', 'Oldcastle', 'Fenwick', 'Highmoor', 'Saltmere', 'Brindle',
    'Corwen', 'Duskfall', 'Emberly', 'Frostholm', 'Ironvale', 'Larkspur', 'Northwatch', 'Oakenford',
    'Pikehaven', 'Quillon', 'Redwater', 'Silverrun', 'Tarnwick', 'Umberfield', 'Vexley', 'Yarrow',
    'Ashcombe', 'Marrowgate', 'Ravenholt', 'Sorrel', 'Wendmoor'];

  // Hue of each banner colour, used only to hand a new banner the colour least like its neighbours.
  const HUES = [214, 4, 30, 328, 268, 176, 105];

  /* ---------- small helpers ---------- */

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(list, rng) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function connected(n, roads) {
    const adj = Array.from({ length: n }, () => []);
    for (const r of roads) { adj[r.a].push(r.b); adj[r.b].push(r.a); }
    const seen = new Uint8Array(n); const q = [0]; seen[0] = 1; let c = 1;
    for (let h = 0; h < q.length; h++) for (const v of adj[q[h]]) if (!seen[v]) { seen[v] = 1; c++; q.push(v); }
    return c === n;
  }

  /* ---------- the map ---------- */

  function buildMap(rng, n, aspect, banners) {
    const area = n * 42000;
    const W = Math.round(Math.sqrt(area * aspect));
    const H = Math.round(area / W);
    const M = 96;

    // Evenly scattered sites: each new one is the best of several random tries.
    const pts = [];
    for (let i = 0; i < n; i++) {
      let best = null, bestD = -1;
      for (let c = 0; c < 48; c++) {
        const x = M + rng() * (W - 2 * M), y = M + rng() * (H - 2 * M);
        let d = 1e9;
        for (const p of pts) { const q = Math.hypot(p.x - x, p.y - y); if (q < d) d = q; }
        if (d > bestD) { bestD = d; best = { x, y }; }
      }
      pts.push(best);
    }

    // Roads: a Gabriel graph (two sites are joined when no third sits between them),
    // then some of the longest roads are dropped so the map gets chokepoints.
    let roads = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const mx = (pts[i].x + pts[j].x) / 2, my = (pts[i].y + pts[j].y) / 2;
      const r2 = ((pts[i].x - pts[j].x) ** 2 + (pts[i].y - pts[j].y) ** 2) / 4;
      let ok = true;
      for (let k = 0; k < n && ok; k++) {
        if (k !== i && k !== j && (pts[k].x - mx) ** 2 + (pts[k].y - my) ** 2 < r2) ok = false;
      }
      if (ok) roads.push({ a: i, b: j, len: Math.sqrt(r2) * 2 });
    }
    const deg = new Array(n).fill(0);
    for (const r of roads) { deg[r.a]++; deg[r.b]++; }
    const longest = roads.slice().sort((p, q) => q.len - p.len).slice(0, Math.floor(roads.length * 0.3));
    for (const r of longest) {
      if (deg[r.a] <= 2 || deg[r.b] <= 2 || rng() < 0.4) continue;
      const rest = roads.filter((x) => x !== r);
      if (connected(n, rest)) { roads = rest; deg[r.a]--; deg[r.b]--; }
    }

    const L = new Float32Array(n * n);
    const adj = Array.from({ length: n }, () => []);
    for (const r of roads) { L[r.a * n + r.b] = L[r.b * n + r.a] = r.len; adj[r.a].push(r.b); adj[r.b].push(r.a); }

    // Cities grow at crossroads, never side by side.
    const tier = new Array(n).fill(1);
    const order = shuffle([...Array(n).keys()], rng).sort((p, q) => deg[q] - deg[p]);
    let cities = Math.max(2, Math.round(n * 0.13));
    for (const i of order) {
      if (!cities) break;
      if (adj[i].some((v) => tier[v] === 3)) continue;
      tier[i] = 3; cities--;
    }
    let towns = Math.round(n * 0.34);
    for (const i of shuffle([...Array(n).keys()], rng)) {
      if (!towns) break;
      if (tier[i] === 1) { tier[i] = 2; towns--; }
    }

    // Seats for the banners: as far from each other as the map allows.
    const pool = [...Array(n).keys()].filter((i) => tier[i] < 3 && deg[i] >= 2);
    const starts = [pool[Math.floor(rng() * pool.length)]];
    while (starts.length < banners) {
      let best = -1, bestD = -1;
      for (const i of pool) {
        if (starts.includes(i)) continue;
        let d = 1e9;
        for (const s of starts) d = Math.min(d, Math.hypot(pts[i].x - pts[s].x, pts[i].y - pts[s].y));
        if (d > bestD) { bestD = d; best = i; }
      }
      starts.push(best);
    }

    const names = shuffle(TOWNS, rng);
    const keeps = pts.map((p, i) => {
      const seat = starts.includes(i);
      const t = seat ? 2 : tier[i];
      const range = TIERS[t].pop;
      const pop = seat ? 14000 : Math.round(range[0] + rng() * (range[1] - range[0]));
      const cap = pop * GRANARY;
      return {
        id: i, x: p.x, y: p.y, tier: t, name: names[i % names.length], adj: adj[i],
        owner: -1, origin: -1, since: 0,
        pop: pop, pop0: pop, cap: cap,
        men: Math.round(pop * (0.016 + rng() * 0.01)),     // the town watch
        pool: pop * 0.01,
        food: cap * (0.5 + rng() * 0.35),
        unrest: 0, starve: 0, hungry: false, sacked: 0, camp: null,
      };
    });
    return { W, H, keeps, roads, L, starts: shuffle(starts, rng) };
  }

  /* ---------- the game ---------- */

  class Game {
    /**
     * @param {object} [opts]
     * @param {number} [opts.seed]    same seed, same world
     * @param {number} [opts.keeps]   number of settlements (12 to 28)
     * @param {number} [opts.aspect]  width over height of the map
     * @param {number} [opts.rivals]  rival banners at the start
     * @param {boolean} [opts.bot]    let the rival AI play the player's seat (tests, title screen)
     * @param {boolean} [opts.quiet]  skip chronicle and effects (headless runs)
     * @param {object} [opts.cheat]   test-only handicaps for the player, e.g. { levy: 2 }
     */
    constructor(opts) {
      opts = opts || {};
      this.seed = (opts.seed >>> 0) || 1;
      this.rng = mulberry32(this.seed);
      this.quiet = !!opts.quiet;
      this.bot = !!opts.bot;
      this.cheat = opts.cheat || null;

      const n = clamp(Math.round(opts.keeps || 22), 12, 28);
      const rivals = clamp(opts.rivals === undefined ? 3 : opts.rivals, 1, 5);
      const map = buildMap(this.rng, n, clamp(opts.aspect || 1.5, 0.55, 1.9), rivals + 1);
      this.n = n; this.W = map.W; this.H = map.H;
      this.keeps = map.keeps; this.roads = map.roads; this.L = map.L;

      this.factions = []; this.armies = []; this.events = []; this.fx = [];
      this.time = 0; this.season = 0; this.yearIdx = 0; this.armySeq = 0;
      this.version = 0;                 // bumps whenever a town changes hands
      this.crown = -1; this.dread = 0; this.menace = 0; this.share = 0;
      this.league = -1;                 // the banner the others have united against, if any
      this.over = false; this.ending = null; this.endTime = 0;
      this.dominionArmed = true; this.toldWinter = false; this.nagged = {};
      this.claim = 0; this.claimant = -1;
      this.ledger = { start: 0, born: 0, dead: 0 };
      this.stats = { reign: 0, peakKeeps: 1, peakShare: 0, taken: 0, lost: 0, battles: 0,
        ended: 0, revolts: 0, quelled: 0, dominions: 0, buried: 0 };
      this.age = 36 + Math.floor(this.rng() * 5);
      this.houseNames = shuffle(HOUSES, this.rng);

      this.addFaction({ name: 'You', player: true });
      for (let i = 0; i < rivals; i++) this.addFaction({});
      this.factions.forEach((f, i) => {
        const k = this.keeps[map.starts[i]];
        k.owner = k.origin = f.id; f.seat = k.id;
        k.men = 400; k.pool = k.pop * LEVY.standard.cap; k.food = k.cap * 0.6;
      });
      this.ledger.start = this.headcount();
      this.tally(0);
      this.say(['Two', 'Three', 'Four', 'Five', 'Six'][rivals - 1] + ' banners, one crown. It is spring, and the roads are dry.', 'info');
    }

    /* ----- banners ----- */

    addFaction(o) {
      const id = this.factions.length;
      const used = this.factions.filter((f) => f.alive).map((f) => f.color);
      let color = 0;
      if (!o.player) {
        let best = -1;
        for (let c = 1; c < HUES.length; c++) {
          if (used.includes(c)) continue;
          let d = 360;
          for (const u of used) { const x = Math.abs(HUES[c] - HUES[u]) % 360; d = Math.min(d, x > 180 ? 360 - x : x); }
          if (d > best) { best = d; color = c; }
        }
        if (!color) return null;       // every colour is flying already
      }
      const f = {
        id: id, name: o.name || this.houseNames[(id - 1) % this.houseNames.length],
        color: color, player: !!o.player, ai: !o.player, alive: true, born: this.time,
        levy: 'standard', strife: 0, idle: 0,
        temper: TEMPERS[o.temper === undefined ? Math.floor(this.rng() * TEMPERS.length) : o.temper],
        think: 0.5 + this.rng() * 1.5, seat: -1, lastBlow: -1,
        keeps: 0, people: 0, men: 0, field: 0,
      };
      this.factions.push(f);
      return f;
    }

    /** Name of a banner as it reads in the middle of a sentence. */
    nm(id) {
      if (id < 0) return 'the free towns';
      if (id === PLAYER) return 'you';
      const s = this.factions[id].name;
      return s.startsWith('The ') ? 'the ' + s.slice(4) : s;
    }

    Nm(id) {
      const s = this.nm(id);
      return s.charAt(0).toUpperCase() + s.slice(1);
    }

    /**
     * Two banners are at war unless they are the same, or both are rivals bound by a league
     * against a third. The player signs no truces and is offered none.
     */
    atWar(a, b) {
      if (a === b) return false;
      if (this.league >= 0 && a > PLAYER && b > PLAYER && a !== this.league && b !== this.league) return false;
      return true;
    }

    /* ----- chronicle and effects (skipped when quiet) ----- */

    say(text, tone, k) { if (!this.quiet) this.events.push({ type: 'say', text: text, tone: tone || 'info', k: k === undefined ? -1 : k }); }
    herald(text, sub, tone) { if (!this.quiet) this.events.push({ type: 'banner', text: text, sub: sub || '', tone: tone || 'info' }); }
    effect(e) { if (!this.quiet) this.fx.push(e); }
    nag(key, gap, text, tone, k) {
      if (this.quiet) return;
      if (this.nagged[key] !== undefined && this.time - this.nagged[key] < gap) return;
      this.nagged[key] = this.time; this.say(text, tone, k);
    }

    /* ----- geometry ----- */

    len(a, b) { return this.L[a * this.n + b]; }

    /** Road distance from every town to `to`, passing only through towns that `me` holds. */
    reach(to, me) {
      const n = this.n, d = new Float64Array(n).fill(Infinity), done = new Uint8Array(n);
      d[to] = 0;
      for (;;) {
        let u = -1, best = Infinity;
        for (let i = 0; i < n; i++) if (!done[i] && d[i] < best) { best = d[i]; u = i; }
        if (u < 0) break;
        done[u] = 1;
        if (u !== to && this.keeps[u].owner !== me) continue;
        for (const v of this.keeps[u].adj) { const nd = best + this.len(u, v); if (nd < d[v]) d[v] = nd; }
      }
      return d;
    }

    route(from, to, me) {
      if (from === to) return null;
      const d = this.reach(to, me);
      if (!isFinite(d[from])) return null;
      const path = [from];
      let u = from;
      for (let guard = 0; u !== to && guard < 64; guard++) {
        let bv = -1, bd = Infinity;
        for (const v of this.keeps[u].adj) {
          if (v !== to && this.keeps[v].owner !== me) continue;
          const c = this.len(u, v) + d[v];
          if (c < bd) { bd = c; bv = v; }
        }
        if (bv < 0) return null;
        path.push(bv); u = bv;
      }
      return u === to ? path : null;
    }

    /** Steps from each town to the nearest town `me` does not hold. */
    frontOf(me) {
      const front = new Int16Array(this.n).fill(99), q = [];
      for (const k of this.keeps) if (k.owner !== me) { front[k.id] = 0; q.push(k.id); }
      for (let h = 0; h < q.length; h++) {
        const u = q[h];
        for (const v of this.keeps[u].adj) if (front[v] > front[u] + 1) { front[v] = front[u] + 1; q.push(v); }
      }
      return front;
    }

    /* ----- what a place can bear ----- */

    /** How much the walls multiply a garrison, after breaches and hunger. */
    wall(k, camp) {
      let w = 1 + (TIERS[k.tier].wall - 1) * (1 - 0.6 * (camp ? camp.breach : 0));
      if (k.starve > 2) w *= 0.6;
      return w;
    }

    /** Roughly how many soldiers a town can keep fed: its own fields plus the roads into it. */
    feeds(k) {
      let lines = 0;
      for (const v of k.adj) if (this.keeps[v].owner === k.owner && !this.keeps[v].camp) lines++;
      return Math.round(k.pop * YIELD * 0.8 + ROAD_CAP * lines);
    }

    /** Everything weighing on a town's temper, as [reason, weight] pairs. */
    burdens(k) {
      const f = this.factions[k.owner];
      return [
        ['foreign rule', k.origin !== k.owner ? Math.max(0.2, 0.62 - 0.07 * (this.time - k.since) / YEAR) : 0],
        ['overreach', Math.max(0, f.keeps - 5) * 0.05],
        ['weariness of your rule', 0.012 * Math.pow(Math.max(0, (this.time - f.born) / YEAR - 2), 1.8)],
        ['the levy', LEVY[f.levy].unrest],
        ['hunger', k.hungry ? 0.3 : 0],
        ['the sack', k.sacked > 0 ? 0.25 : 0],
        ['idle lords', f.strife],
      ];
    }

    /** What pushes a town toward revolt, before its garrison leans the other way. */
    pressure(k) {
      let p = 0;
      for (const b of this.burdens(k)) p += b[1];
      return p;
    }

    /** The reasons a town is restless, heaviest first. */
    grievances(k) {
      if (k.owner < 0) return [];
      return this.burdens(k).filter((b) => b[1] > 0.04).sort((a, b) => b[1] - a[1]).map((b) => b[0]);
    }

    headcount() {
      let n = 0;
      for (const k of this.keeps) n += k.pop + k.men;
      for (const a of this.armies) n += a.men;
      return n;
    }

    bury(n, owner) {
      if (n <= 0) return;
      this.ledger.dead += n;
      if (owner === PLAYER && !this.over) this.stats.buried += n;
    }

    /* ----- the clock ----- */

    update(dt) {
      this.time += dt;
      const season = Math.floor((this.time % YEAR) / SEASON);
      if (season !== this.season) { this.season = season; this.turnSeason(); }
      const year = Math.floor(this.time / YEAR);
      if (year !== this.yearIdx) { this.yearIdx = year; this.turnYear(); }

      this.economy(dt);
      this.wagons(dt);
      this.march(dt);
      this.sieges(dt);
      this.tempers(dt);
      for (const f of this.factions) {
        if (!f.alive || !(f.ai || (this.bot && !this.over))) continue;
        f.think -= dt; f.idle += dt;
        if (f.think <= 0) {
          this.aiThink(f);
          f.think = 1.5 * f.temper.tempo * (0.8 + 0.4 * this.rng());
        }
      }
      this.sweep();
      this.tally(dt);
    }

    turnSeason() {
      if (!this.quiet) this.events.push({ type: 'season', season: this.season });
      if (this.season === 3 && !this.toldWinter) {
        this.toldWinter = true;
        this.say('Winter. Nothing grows, and men left in the field freeze.', 'omen');
      }
    }

    turnYear() {
      this.age++;
      if (this.over || this.factions[PLAYER].keeps === 0) return;
      // Nobody outlives the crown. The odds of a quiet death climb every year past fifty.
      if (this.age >= 50 && (this.age >= 72 || this.rng() < 0.05 + 0.04 * (this.age - 50))) this.finish('died');
    }

    finish(how) {
      if (this.over) return;
      this.over = true; this.ending = how; this.endTime = this.time;
      if (!this.quiet) this.events.push({ type: 'over', how: how });
    }

    /* ----- people, levies and grain ----- */

    economy(dt) {
      const h = HARVEST[this.season];
      for (const k of this.keeps) {
        // Births, and a slow thinning when the land is overfull.
        const g = k.pop * (0.02 / YEAR) * (1 - k.pop / (k.pop0 * 1.25)) * dt;
        k.pop += g; this.ledger.born += g;

        // Young men come of age into the levy pool. Restless towns answer the call
        // grudgingly, and towns under a foreign banner more grudgingly still.
        const free = k.owner < 0;
        const pol = free ? LEVY.light : LEVY[this.factions[k.owner].levy];
        const boost = (k.owner === PLAYER && this.cheat && this.cheat.levy) || 1;
        const willing = clamp(1.3 - 1.3 * k.unrest, 0, 1) * (!free && k.origin !== k.owner ? 0.5 : 1);
        k.pool = Math.min(k.pop * pol.cap, k.pool + k.pop * pol.grow * willing * boost / YEAR * dt);
        // The pool musters into the garrison, but nobody calls up men the granary cannot feed.
        const limit = free ? k.pop * 0.028 : Infinity;
        const fed = clamp((k.food / k.cap - 0.2) / 0.3, 0, 1);
        if (fed > 0 && k.unrest < 0.9 && k.pool >= 1 && k.men < limit) {
          const m = Math.min(k.pool, k.pop * pol.cap / 12 * fed * dt, limit - k.men);
          k.pool -= m; k.pop -= m; k.men += m;
        }
        // Six quiet years under one banner and a town stops thinking of it as foreign.
        if (!free && k.origin !== k.owner && k.unrest < 0.4 && this.time - k.since > 6 * YEAR) k.origin = k.owner;

        // Grain in, mouths out. Invested towns harvest nothing and feed everyone inside.
        const shut = !!k.camp;
        if (!shut) k.food += k.pop * YIELD * h * (k.unrest > 0.8 ? 0.5 : 1) * dt;
        const eat = k.men * dt + (shut ? k.pop * SIEGE_APPETITE * dt : 0);
        if (k.food >= eat) {
          k.food -= eat;
          k.starve = Math.max(0, k.starve - 2 * dt);
        } else {
          const short = eat > 0 ? 1 - k.food / eat : 0;
          k.food = 0; k.starve += dt;
          const gone = k.men * HUNGER * short * dt;
          k.men -= gone;
          if (shut) {
            this.bury(gone, k.owner);
            const d = k.pop * 0.004 * dt; k.pop -= d; this.ledger.dead += d;
          } else {
            k.pop += gone;          // deserters walk home to their fields
          }
        }
        k.hungry = k.starve > 0.5;
        if (k.food > k.cap) k.food = k.cap;
        if (k.sacked > 0) k.sacked -= dt;
        if (k.hungry && k.owner === PLAYER && !shut && k.men > 30) {
          this.nag('hungry' + k.id, 30, 'No grain left in ' + k.name + '. The garrison is drifting home.', 'bad', k.id);
        }
      }
    }

    /** Wagons level the granaries of neighbouring towns under one banner, as fast as the road allows. */
    wagons(dt) {
      const max = ROAD_CAP * dt;
      for (const r of this.roads) {
        const a = this.keeps[r.a], b = this.keeps[r.b];
        if (a.owner < 0 || a.owner !== b.owner || a.camp || b.camp) continue;
        let flow = clamp((a.food / a.cap - b.food / b.cap) * Math.min(a.cap, b.cap) * 0.2 * dt, -max, max);
        flow = flow > 0 ? Math.min(flow, a.food, b.cap - b.food) : -Math.min(-flow, b.food, a.cap - a.food);
        a.food -= flow; b.food += flow;
      }
    }

    /* ----- armies on the road ----- */

    /** Send men out of a town. Returns the army, or null if they cannot go. */
    dispatch(k, to, men) {
      if (k.camp) return null;                       // invested: the only way out is a sally
      men = Math.min(Math.floor(k.men), Math.floor(men));
      if (men < 1 || k.id === to) return null;
      const path = this.route(k.id, to, k.owner);
      if (!path) return null;
      const food = Math.min(men * CARRY, k.food * (men / k.men));
      k.men -= men; k.food -= food;
      return this.muster(k.owner, men, food, path, k.x, k.y);
    }

    /** Pull men out of a siege camp and march them elsewhere. */
    detach(c, to, men) {
      if (c.state !== 'camp') return null;
      men = Math.min(Math.floor(c.men), Math.floor(men));
      if (men < 1 || c.at === to) return null;
      const path = this.route(c.at, to, c.owner);
      if (!path) return null;
      const food = c.food * (men / c.men);
      c.men -= men; c.food -= food;
      const k = this.keeps[c.at];
      if (c.men < 1) k.camp = null;
      return this.muster(c.owner, men, food, path, k.x, k.y);
    }

    muster(owner, men, food, path, x, y) {
      const a = {
        id: ++this.armySeq, owner: owner, men: men, food: food, state: 'march',
        path: path, i: 0, d: 0, len: this.len(path[0], path[1]), x: x, y: y,
        at: -1, breach: 0, sat: 0, home: path[0], rout: false, hungry: false,
      };
      this.armies.push(a);
      return a;
    }

    /** An army in the open eats what it carries. Hunger and frost thin it. */
    rations(a, got, dt) {
      const need = a.men * dt;
      if (got < need) { const t = Math.min(need - got, a.food); a.food -= t; got += t; }
      let gone = 0;
      if (got < need - 1e-9) { gone += a.men * HUNGER * (1 - got / need) * dt; a.hungry = true; } else a.hungry = false;
      if (this.season === 3) gone += a.men * FROST * dt;
      if (gone > 0) { a.men -= gone; this.bury(gone, a.owner); }
    }

    march(dt) {
      const speed = SPEED * (this.season === 3 ? 0.75 : 1);
      const onRoad = new Map();
      for (const a of this.armies) {
        if (a.state !== 'march' || a.men < 1) continue;
        this.rations(a, 0, dt);
        a.d += speed * dt;
        while (a.men >= 1 && a.state === 'march' && a.d >= a.len) {
          const k = this.keeps[a.path[a.i + 1]];
          const last = a.i + 1 === a.path.length - 1;
          if (last || k.owner !== a.owner || k.camp) { this.arrive(a, k); break; }
          // Passing through a friendly town: top up the wagons and keep going.
          const t = Math.min(a.men * CARRY - a.food, k.food * 0.5);
          if (t > 0) { a.food += t; k.food -= t; }
          a.d -= a.len; a.i++;
          a.len = this.len(a.path[a.i], a.path[a.i + 1]);
        }
        if (a.state === 'march' && a.men >= 1) {
          const p = this.keeps[a.path[a.i]], q = this.keeps[a.path[a.i + 1]], t = a.d / a.len;
          a.x = p.x + (q.x - p.x) * t; a.y = p.y + (q.y - p.y) * t;
          const u = a.path[a.i], v = a.path[a.i + 1];
          const key = u < v ? u * 64 + v : v * 64 + u;
          if (!onRoad.has(key)) onRoad.set(key, []);
          onRoad.get(key).push(a);
        }
      }
      // Hostile armies that meet on a road fight where they stand.
      for (const list of onRoad.values()) {
        if (list.length < 2) continue;
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          if (a.men < 1 || b.men < 1 || a.state !== 'march' || b.state !== 'march') continue;
          if (a.path[a.i] === b.path[b.i] || !this.atWar(a.owner, b.owner)) continue;   // same direction, or no quarrel
          if (a.d + b.d < a.len) continue;                                               // not met yet
          this.fieldBattle(a, b);
        }
      }
    }

    /**
     * One clash, settled at once. Returns who won and what each side lost.
     * `mult` is what walls or earthworks are worth to the defender.
     * Losers break and run long before they are wiped out; winners still bleed.
     */
    fight(att, def, mult) {
      const sd = def * mult;
      if (sd < 1) return { win: true, aLoss: 0, dLoss: def };
      if (att < 1) return { win: false, aLoss: att, dLoss: 0 };
      const r = (att / sd) * (0.88 + 0.24 * this.rng());
      if (r >= 1) {
        return { win: true, aLoss: Math.min(att * 0.6, sd * 0.32 / Math.pow(r, 0.75)), dLoss: def * clamp(0.34 + 0.3 * (r - 1), 0.34, 1) };
      }
      const inv = 1 / r;
      return { win: false, aLoss: att * clamp(0.34 + 0.3 * (inv - 1), 0.34, 0.92), dLoss: Math.min(def * 0.6, att * 0.32 / Math.pow(inv, 0.75) / mult) };
    }

    fieldBattle(a, b) {
      // Men already running fight at half strength.
      const r = this.fight(a.men * (a.rout ? 0.5 : 1), b.men, b.rout ? 0.5 : 1);
      const aLoss = Math.min(a.men, r.aLoss), bLoss = Math.min(b.men, r.dLoss);
      a.men -= aLoss; b.men -= bLoss;
      this.bury(aLoss, a.owner); this.bury(bLoss, b.owner);
      this.report(a.owner, b.owner, aLoss, bLoss, r.win, a.x, a.y, this.keeps[a.path[a.i + 1]]);
      this.turn(r.win ? b : a, true);
    }

    /** Tell the player about a battle they were in. */
    report(att, def, aLoss, dLoss, attWon, x, y, near) {
      this.effect({ type: 'battle', x: x, y: y, a: att, b: def });
      if (att !== PLAYER && def !== PLAYER) return;
      if (!this.over) this.stats.battles++;
      const mine = Math.round(att === PLAYER ? aLoss : dLoss), theirs = Math.round(att === PLAYER ? dLoss : aLoss);
      const won = (att === PLAYER) === attWon;
      this.effect({ type: 'float', x: x, y: y, text: (won ? 'Won' : 'Lost') + ': ' + mine + ' dead, ' + theirs + ' of theirs', tone: won ? 'good' : 'bad' });
      if (mine + theirs >= 250) {
        this.say((won ? 'You won' : 'You lost') + ' the field near ' + near.name + '. ' + mine + ' of yours dead, ' + theirs + ' of theirs.', won ? 'good' : 'bad', near.id);
      }
    }

    /** Reverse a marching army back the way it came, as a rout or an orderly withdrawal. */
    turn(a, rout) {
      if (a.men < 1) return;
      const from = a.path[a.i], to = a.path[a.i + 1];
      a.path = [to, from]; a.i = 0; a.d = Math.max(0, a.len - a.d);
      if (rout) a.rout = true;
    }

    arrive(a, k) {
      const camp = k.camp;
      if (k.owner === a.owner) {
        if (camp && !a.rout) return this.relieve(a, k, camp);
        return this.enter(a, k);
      }
      if (camp && camp.owner === a.owner) { camp.men += a.men; camp.food += a.food; a.men = 0; return; }
      if (a.rout) { this.bury(a.men, a.owner); a.men = 0; return; }          // nowhere left to run
      if (!this.atWar(a.owner, k.owner)) return this.turn(a, false);          // a truce holds
      if (camp) {
        if (!this.atWar(a.owner, camp.owner)) return this.turn(a, false);
        // Two besiegers, one town: the newcomer fights for the camp.
        const r = this.fight(a.men, camp.men, 1.15);
        const aLoss = Math.min(a.men, r.aLoss), cLoss = Math.min(camp.men, r.dLoss);
        a.men -= aLoss; camp.men -= cLoss;
        this.bury(aLoss, a.owner); this.bury(cLoss, camp.owner);
        this.report(a.owner, camp.owner, aLoss, cLoss, r.win, camp.x, camp.y, k);
        if (!r.win) return this.turn(a, true);
        this.breakCamp(camp, true);
      }
      if (k.men < 1) return this.takeTown(k, a, 'open');
      this.encamp(a, k);
    }

    enter(a, k) {
      k.men += a.men; k.food = Math.min(k.cap, k.food + a.food);
      a.men = 0;
    }

    encamp(a, k) {
      const prev = this.keeps[a.path[a.i]];
      const dx = prev.x - k.x, dy = prev.y - k.y, d = Math.hypot(dx, dy) || 1;
      a.state = 'camp'; a.at = k.id; a.breach = 0; a.sat = 0; a.home = prev.id;
      a.x = k.x + dx / d * 34; a.y = k.y + dy / d * 34;
      k.camp = a;
      if (k.owner === PLAYER) {
        this.say(this.Nm(a.owner) + ' laid siege to ' + k.name + '.', 'bad', k.id);
        if (!this.quiet) this.events.push({ type: 'sfx', name: 'siege' });
      }
      this.parley(a, k);
    }

    /** A relief column fights the besiegers at the gates. */
    relieve(a, k, camp) {
      const r = this.fight(a.men, camp.men, 1.15);
      const aLoss = Math.min(a.men, r.aLoss), cLoss = Math.min(camp.men, r.dLoss);
      a.men -= aLoss; camp.men -= cLoss;
      this.bury(aLoss, a.owner); this.bury(cLoss, camp.owner);
      this.report(a.owner, camp.owner, aLoss, cLoss, r.win, camp.x, camp.y, k);
      if (r.win) {
        this.breakCamp(camp, true);
        this.enter(a, k);
        if (k.owner === PLAYER) this.say('The siege of ' + k.name + ' was broken.', 'good', k.id);
      } else this.turn(a, true);
    }

    /** The garrison comes out to fight the camp at its gates. */
    sally(k, frac) {
      const camp = k.camp;
      if (!camp) return false;
      const force = Math.floor(k.men * clamp(frac, 0, 1));
      if (force < 1) return false;
      const r = this.fight(force, camp.men, 1.15);
      const aLoss = Math.min(force, r.aLoss), cLoss = Math.min(camp.men, r.dLoss);
      k.men -= aLoss; camp.men -= cLoss;
      this.bury(aLoss, k.owner); this.bury(cLoss, camp.owner);
      this.report(k.owner, camp.owner, aLoss, cLoss, r.win, camp.x, camp.y, k);
      if (r.win) {
        this.breakCamp(camp, true);
        if (k.owner === PLAYER) this.say('The siege of ' + k.name + ' was broken.', 'good', k.id);
      }
      return true;
    }

    /** A camp gives up its siege and makes for the nearest friendly town, if there is one. */
    breakCamp(c, rout) {
      const k = this.keeps[c.at];
      if (k.camp === c) k.camp = null;
      if (c.men < 1) return;
      let home = -1;
      if (this.keeps[c.home].owner === c.owner && this.len(c.at, c.home) > 0) home = c.home;
      else for (const v of k.adj) if (this.keeps[v].owner === c.owner && (home < 0 || this.len(c.at, v) < this.len(c.at, home))) home = v;
      if (home < 0) {
        if (rout) { this.bury(c.men, c.owner); c.men = 0; }        // cut off and cut down
        else k.camp = c;                                            // nowhere to go: stay put
        return;
      }
      c.state = 'march'; c.path = [c.at, home]; c.i = 0; c.d = 0; c.len = this.len(c.at, home);
      c.at = -1; c.rout = !!rout; c.x = k.x; c.y = k.y;
    }

    /* ----- sieges ----- */

    sieges(dt) {
      for (const c of this.armies) {
        if (c.state !== 'camp' || c.men < 1) continue;
        const k = this.keeps[c.at];
        if (k.owner === c.owner) { k.camp = null; this.enter(c, k); continue; }
        if (!this.atWar(c.owner, k.owner)) { this.breakCamp(c, false); if (c.state === 'camp') this.camped(c, k, dt); continue; }
        this.camped(c, k, dt);
        if (c.men >= 1) this.parley(c, k);
      }
    }

    camped(c, k, dt) {
      c.sat += dt;
      c.breach = Math.min(1, c.breach + dt / BREACH_TIME);
      // Forage the countryside first, then wagons from friendly towns next door.
      const need = c.men * dt;
      let got = Math.min(need, k.pop * YIELD * HARVEST[this.season] * 0.7 * dt);
      for (const v of k.adj) {
        if (got >= need) break;
        const s = this.keeps[v];
        if (s.owner !== c.owner || s.camp) continue;
        const t = Math.min(need - got, ROAD_CAP * dt, s.food);
        s.food -= t; got += t;
      }
      this.rations(c, got, dt);
      if (c.hungry && c.food <= 0 && c.owner === PLAYER) {
        this.nag('camp' + c.id, 25, 'Your camp at ' + k.name + ' is starving.', 'bad', k.id);
      }
    }

    /** A garrison with no hope opens the gates rather than die on the walls. */
    parley(c, k) {
      if (k.men < 1 || k.starve > 8 || c.men >= k.men * this.wall(k, c) * 3) this.takeTown(k, c, 'yield');
    }

    /** Send the camp over the walls. Costly, and a sack follows if it works. */
    storm(c) {
      if (c.state !== 'camp') return false;
      const k = this.keeps[c.at];
      const r = this.fight(c.men, k.men, this.wall(k, c));
      const aLoss = Math.min(c.men, r.aLoss), dLoss = Math.min(k.men, r.dLoss);
      c.men -= aLoss; k.men -= dLoss;
      this.bury(aLoss, c.owner); this.bury(dLoss, k.owner);
      this.report(c.owner, k.owner, aLoss, dLoss, r.win, k.x, k.y, k);
      if (r.win) this.takeTown(k, c, 'storm');
      else {
        c.breach = Math.min(1, c.breach + 0.15);
        if (c.men < 1) k.camp = null;
      }
      return true;
    }

    takeTown(k, army, how) {
      const prev = k.owner, by = army.owner;
      k.pop += k.men; k.men = 0;                       // the garrison lays down its arms and goes home
      if (how === 'storm') {
        const sack = k.pop * 0.05;
        k.pop -= sack; this.ledger.dead += sack;
        k.sacked = 30; k.food *= 0.5;
      }
      k.owner = by; k.since = this.time; k.camp = null;
      k.unrest = k.origin === by ? Math.min(k.unrest, 0.15) : Math.max(k.unrest, how === 'storm' ? 0.75 : 0.55);
      k.men = army.men; k.food = Math.min(k.cap, k.food + army.food);
      k.starve = 0; k.hungry = false;
      army.men = 0;
      this.version++;
      if (prev >= 0) this.factions[prev].lastBlow = by;
      this.effect({ type: 'take', k: k.id, owner: by, prev: prev, how: how });
      if (this.over) return;
      if (by === PLAYER) {
        this.stats.taken++;
        if (how === 'storm') this.say('You stormed ' + k.name + '. The sack was ugly.', 'good', k.id);
        else this.say(k.name + ' opened its gates to you.', 'good', k.id);
      } else if (prev === PLAYER) {
        this.stats.lost++;
        this.say(k.name + (how === 'storm' ? ' was stormed by ' : ' surrendered to ') + this.nm(by) + '.', 'bad', k.id);
      }
    }

    /* ----- unrest ----- */

    tempers(dt) {
      const ease = 1 - Math.exp(-dt / 14);
      let worst = null;
      for (const k of this.keeps) {
        if (k.owner < 0) { k.unrest = 0; continue; }
        const guard = Math.min(1.5, k.men / (k.pop * 0.03));
        const target = clamp(this.pressure(k) - 0.36 * guard, 0, 1.3);
        k.unrest += (target - k.unrest) * ease;
        if (k.unrest >= 1 && !k.camp) this.revolt(k);
        else if (k.owner === PLAYER && k.unrest > 0.8 && (!worst || k.unrest > worst.unrest)) worst = k;
      }
      if (worst) this.nag('unrest', 20, worst.name + ' is close to revolt. More men on the walls would calm it.', 'omen', worst.id);
    }

    /** One town in twenty takes up whatever is to hand. They fight badly, but there are a lot of them. */
    revolt(k) {
      const owner = k.owner;
      const rebels = k.pop * 0.05;
      k.pop -= rebels;
      const r = this.fight(rebels, k.men, 1 / 0.6);
      const rLoss = Math.min(rebels, r.aLoss), gLoss = Math.min(k.men, r.dLoss);
      this.ledger.dead += rLoss; this.bury(gLoss, owner);
      this.effect({ type: 'revolt', k: k.id });
      if (!r.win) {
        k.men -= gLoss; k.pop += rebels - rLoss; k.unrest = 0.45;
        if (owner === PLAYER && !this.over) {
          this.stats.quelled++;
          this.say('A rising in ' + k.name + ' was put down. ' + Math.round(gLoss) + ' of the garrison died doing it.', 'info', k.id);
        }
        return;
      }
      // The loyal survivors cut their way out to a friendly town, or are disarmed and scattered.
      const left = k.men - gLoss;
      k.men = 0;
      let refuge = -1;
      for (const v of k.adj) if (this.keeps[v].owner === owner && !this.keeps[v].camp && (refuge < 0 || this.keeps[v].men > this.keeps[refuge].men)) refuge = v;
      if (left >= 1 && refuge >= 0) {
        const a = this.muster(owner, left, 0, [k.id, refuge], k.x, k.y);
        a.rout = true;
      } else k.pop += left;

      let to = -1, fresh = null;
      if (k.origin >= 0 && k.origin !== owner && this.factions[k.origin].alive) to = k.origin;
      else if (this.factions.filter((f) => f.alive && f.ai).length < MAX_RIVALS) {
        fresh = this.addFaction({ name: 'Free ' + k.name, temper: 0 });
        if (fresh) { to = fresh.id; fresh.seat = k.id; }
      }
      k.owner = to; k.since = this.time; k.unrest = 0.1; k.men = rebels - rLoss;
      if (fresh || to < 0) k.origin = to;
      this.factions[owner].lastBlow = -1;
      this.version++;
      this.effect({ type: 'take', k: k.id, owner: to, prev: owner, how: 'revolt' });
      if (this.over) return;
      if (owner === PLAYER) {
        this.stats.revolts++; this.stats.lost++;
        this.say(k.name + ' rose against you and threw out the garrison.', 'bad', k.id);
        if (!this.quiet) this.events.push({ type: 'sfx', name: 'revolt' });
      } else if (this.factions[owner].keeps > 2) {
        this.say(k.name + ' rose against ' + this.nm(owner) + '.', 'info', k.id);
      }
    }

    /* ----- what the player can order ----- */

    /** March a share of a town's garrison to another town. A besieged town sallies instead. */
    orderKeep(id, to, frac) {
      const k = this.keeps[id];
      if (!k || k.owner !== PLAYER) return null;
      if (k.camp) return this.sally(k, frac) ? { sally: true } : null;
      const men = Math.max(1, Math.floor(k.men * frac));
      return this.dispatch(k, to, men);
    }

    /** Order a siege camp: at its own town it storms, anywhere else it marches off. */
    orderCamp(id, to, frac) {
      const c = this.armies.find((a) => a.id === id && a.owner === PLAYER && a.state === 'camp');
      if (!c) return null;
      if (c.at === to) return this.storm(c) ? { storm: true } : null;
      return this.detach(c, to, Math.max(1, Math.floor(c.men * frac)));
    }

    setLevy(level) { if (LEVY[level]) this.factions[PLAYER].levy = level; }

    /** What an assault would probably cost, without the luck. */
    stormOdds(c) {
      const k = this.keeps[c.at], sd = k.men * this.wall(k, c), r = sd < 1 ? 99 : c.men / sd;
      const loss = r >= 1 ? Math.min(c.men * 0.6, sd * 0.32 / Math.pow(r, 0.75)) : c.men * clamp(0.34 + 0.3 * (1 / r - 1), 0.34, 0.92);
      return { ratio: r, loss: Math.round(loss), word: r >= 1.6 ? 'should carry it' : r >= 1.12 ? 'likely, and bloody' : r >= 0.9 ? 'a coin toss' : 'will fail' };
    }

    /* ----- rival minds ----- */

    appetite(f, k) {
      if (k.owner < 0) return 1.3;                               // free towns have no one to avenge them
      if (f.id === PLAYER) return this.league === k.owner ? 2 : 1;   // the bot in the player's seat
      const L = this.league;
      if (L >= 0 && f.id !== L) {                                // sworn to a league: the hegemon first
        if (k.owner === L) return 2.3 + 2.4 * this.menace;
        return k.owner === PLAYER && this.time >= GRACE ? 0.3 : 0;
      }
      if (k.owner === PLAYER) return this.time < GRACE ? 0 : 1.1 + 2.4 * this.dread;      // they always come for you
      return (1 - 0.5 * this.dread) * (this.crown === k.owner ? 1.4 : 1);
    }

    aiThink(f) {
      const me = f.id, K = this.keeps, T = f.temper;
      const own = K.filter((k) => k.owner === me);
      const camps = this.armies.filter((a) => a.owner === me && a.state === 'camp' && a.men >= 1);
      if (!own.length && !camps.length) return;

      // What is already on the road, by where it is going.
      const sup = new Float32Array(this.n), inc = new Float32Array(this.n);
      for (const a of this.armies) {
        if (a.state !== 'march' || a.rout || a.men < 1) continue;
        const dest = a.path[a.path.length - 1], next = a.path[a.i + 1];
        if (a.owner === me) sup[dest] += a.men;
        else if (this.atWar(a.owner, me)) {
          if (K[dest].owner === me) inc[dest] += a.men;
          else if (K[next].owner === me) inc[next] += a.men;
        }
      }
      const front = this.frontOf(me);

      // The fewest men a town can be left with: enough to sit on unrest, and on a border
      // enough that the neighbours cannot simply frighten it into opening the gates.
      // A house that has sat idle too long starts taking risks to get an army together.
      const zeal = clamp(f.idle / (T.bold ? 25 : 40 * T.caution), 0, 1);
      const floor = (k) => {
        let g = k.pop * 0.008;
        g = Math.max(g, clamp((this.pressure(k) - 0.75) / 0.36, 0, 1.4) * k.pop * 0.03 * (1 - 0.4 * zeal));
        if (front[k.id] <= 1) {
          let near = 0;
          for (const v of k.adj) { const o = K[v]; if (o.owner >= 0 && this.atWar(o.owner, me) && o.men > near) near = o.men; }
          g = Math.max(g, Math.min(k.pop * 0.045, near * T.caution * (1 - 0.7 * zeal) / (3 * TIERS[k.tier].wall) + inc[k.id] / (2.5 * TIERS[k.tier].wall)));
        }
        return g;
      };
      const spare = (k) => (k.camp ? 0 : Math.max(0, Math.floor(k.men - floor(k))));

      // Lean on the people harder when outmatched or under siege; ease off when granaries are bare.
      let foe = 0;
      for (const o of this.factions) if (o.alive && o.id !== me && this.atWar(o.id, me) && o.men > foe) foe = o.men;
      let grain = 0;
      for (const k of own) grain += k.food / k.cap;
      grain = own.length ? grain / own.length : 1;
      f.levy = grain > 0.45 && (own.some((k) => k.camp) || f.men < foe * 0.5) ? 'heavy' : 'standard';

      // 1. Towns of mine under siege: sally if the garrison can win, else send a relief column.
      for (const k of own) {
        const c = k.camp;
        if (!c) continue;
        if (k.men >= c.men * 1.15 * 1.3) { this.sally(k, 1); continue; }
        const d = this.reach(k.id, me);
        let helper = null;
        for (const o of own) {
          if (o === k || o.camp || d[o.id] > 520) continue;
          if (spare(o) + sup[k.id] >= c.men * 1.15 * 1.25 && (!helper || spare(o) > spare(helper))) helper = o;
        }
        if (helper && sup[k.id] < c.men) {
          const a = this.dispatch(helper, k.id, Math.min(spare(helper), Math.ceil(c.men * 1.15 * 1.6)));
          if (a) sup[k.id] += a.men;
        }
      }

      // 2. My own camps: storm when the odds allow, pull out when the camp is dying faster than the town.
      for (const c of camps) {
        if (c.state !== 'camp' || c.men < 1) continue;
        const k = K[c.at];
        if (k.owner === me) continue;
        const eff = k.men * this.wall(k, c);
        const dying = c.hungry && c.food <= 0 && k.food > k.cap * 0.12;
        const nearlyOver = k.food < (k.men + k.pop * SIEGE_APPETITE) * 6;       // a few seconds of grain left inside
        if (c.men >= eff * T.storm && (T.bold ? !nearlyOver || c.hungry : (c.sat > 6 && (dying || !nearlyOver) && c.men >= eff * 2))) { this.storm(c); continue; }
        if (dying || k.men > c.men * 1.35) this.breakCamp(c, false);
      }

      // 3. Shore up towns that are thin, restless or about to be hit.
      for (const k of own) {
        if (k.camp) continue;
        let lack = floor(k) - k.men - sup[k.id];
        if (lack < 20) continue;
        const helpers = k.adj.map((v) => K[v]).filter((o) => o.owner === me && !o.camp).sort((a, b) => spare(b) - spare(a));
        for (const h of helpers) {
          const n = Math.min(spare(h), Math.ceil(lack));
          if (n < 20) continue;
          const a = this.dispatch(h, k.id, n);
          if (a) { lack -= a.men; sup[k.id] += a.men; }
          if (lack <= 0) break;
        }
      }

      // 4. Pick one town to take. Three ways in: frighten it, storm it, or starve it.
      let best = null;
      const seen = new Set();
      for (const k of own) for (const t of k.adj) {
        if (seen.has(t)) continue;
        seen.add(t);
        const tk = K[t];
        if (tk.owner === me) continue;
        const w = this.appetite(f, tk);
        if (w <= 0) continue;
        if (tk.camp && tk.camp.owner !== me) continue;       // someone else is already at the gates
        const camp = tk.camp;
        const eff = tk.men * this.wall(tk, camp);
        const d = this.reach(t, me);
        const srcs = own.filter((o) => d[o.id] < 640 && spare(o) >= 40).sort((a, b) => d[a.id] - d[b.id]).slice(0, 5);
        let avail = 0;
        for (const s of srcs) avail += spare(s);
        const have = (camp ? camp.men : 0) + sup[t];
        let lines = 0;
        for (const v of tk.adj) if (K[v].owner === me && !K[v].camp) lines++;
        const sustain = tk.pop * YIELD * HARVEST[this.season] * 0.7 + ROAD_CAP * lines;

        let need = 0, cost = 0;
        const awe = eff * 3.05 + 10, storm = eff * T.storm, siege = Math.max(tk.men * 1.45, 120);
        if (have + avail >= awe) { need = awe; cost = need * 0.1; }
        else if (T.bold && have + avail >= storm) { need = storm; cost = eff * 0.6 + need * 0.15; }
        else if (have + avail >= siege && siege <= sustain * 1.4 && this.season !== 3) {
          need = Math.min(have + avail, Math.max(siege, Math.min(sustain, eff * 1.5)));
          cost = need * 0.3 + 120;
        } else continue;
        const send = need - have;
        if (send < 30) continue;
        const score = w * (tk.pop / 1000) / (cost / 100 + 2) * (0.8 + 0.4 * this.rng());
        if (!best || score > best.score) best = { t: t, srcs: srcs, send: send, score: score };
      }
      if (best) {
        let rem = Math.ceil(best.send);
        for (const s of best.srcs) {
          const a = this.dispatch(s, best.t, Math.min(spare(s), rem));
          if (a) { rem -= a.men; sup[best.t] += a.men; f.idle = 0; }
          if (rem <= 0) break;
        }
      }

      // 5. March idle men from the interior toward the border, as far as the next town can feed them.
      let moves = 0;
      for (const k of own) {
        if (front[k.id] < 2 || k.camp) continue;
        const s = spare(k);
        if (s < 120) continue;
        let to = null;
        for (const v of k.adj) {
          const o = K[v];
          if (o.owner !== me || o.camp || front[v] >= front[k.id]) continue;
          if (o.men + sup[v] + s > this.feeds(o) * 1.3) continue;
          if (!to || o.men + sup[v] < to.men + sup[to.id]) to = o;
        }
        if (!to) continue;
        const a = this.dispatch(k, to.id, s);
        if (a) { sup[to.id] += a.men; if (++moves >= 3) break; }
      }
    }

    /* ----- bookkeeping ----- */

    sweep() {
      let dead = false;
      for (const a of this.armies) {
        if (a.men >= 1) continue;
        dead = true;
        if (a.men > 0) { this.bury(a.men, a.owner); a.men = 0; }
        if (a.at >= 0 && this.keeps[a.at].camp === a) this.keeps[a.at].camp = null;
      }
      if (dead) this.armies = this.armies.filter((a) => a.men >= 1);
    }

    tally(dt) {
      const F = this.factions, K = this.keeps;
      let world = 0;
      for (const f of F) { f.keeps = 0; f.people = 0; f.men = 0; f.field = 0; }
      for (const k of K) {
        world += k.pop;
        if (k.owner < 0) continue;
        const f = F[k.owner];
        f.keeps++; f.people += k.pop; f.men += k.men;
      }
      for (const a of this.armies) { F[a.owner].men += a.men; F[a.owner].field++; }

      for (const f of F) {
        if (!f.alive) continue;
        if (f.keeps === 0 && f.field === 0) {
          f.alive = false;
          if (f.player) { this.finish('fallen'); continue; }
          if (f.lastBlow === PLAYER && !this.over) { this.stats.ended++; this.say('You ended ' + this.nm(f.id) + '.', 'good'); }
          else this.say('Nothing remains of ' + this.nm(f.id) + '.', 'info');
        } else if (f.keeps > 0 && (f.seat < 0 || K[f.seat].owner !== f.id)) {
          let s = null;
          for (const k of K) if (k.owner === f.id && (!s || k.pop > s.pop)) s = k;
          f.seat = s.id;
        }
      }

      // The crown sits with whoever rules the most people, and it takes a clear lead to lift it.
      let top = null;
      for (const f of F) if (f.alive && f.keeps > 0 && (!top || f.people > top.people)) top = f;
      if (this.crown >= 0 && (!F[this.crown].alive || F[this.crown].keeps === 0)) this.crown = -1;
      const holder = this.crown >= 0 ? F[this.crown] : null;
      let second = 0;
      for (const f of F) if (f.alive && f !== top && f.people > second) second = f.people;
      const clear = top && top !== holder && top.keeps >= 3 && top.people > second * 1.08;
      this.claim = clear ? (this.claimant === top.id ? this.claim + dt : dt) : 0;
      this.claimant = clear ? top.id : -1;
      if (clear && this.claim >= 5) {
        const was = this.crown;
        this.claim = 0;
        this.crown = top.id;
        if (!this.over) {
          if (top.id === PLAYER) {
            this.say('You took the crown. Everyone noticed.', 'crown');
            this.herald('The crown is yours', 'Everyone noticed.', 'crown');
          } else if (was === PLAYER) {
            this.say('The crown passed to ' + this.nm(top.id) + '.', 'bad');
            this.herald('The crown is gone', this.Nm(top.id) + ' wears it now.', 'bad');
          }
        }
      }

      const me = F[PLAYER];
      const share = world > 0 ? me.people / world : 0;
      if (!this.over) {
        if (this.crown === PLAYER) this.stats.reign += dt;
        if (me.keeps > this.stats.peakKeeps) this.stats.peakKeeps = me.keeps;
        if (share > this.stats.peakShare) this.stats.peakShare = share;
      }
      const want = me.keeps ? clamp((share - 0.16) / 0.34 + (this.crown === PLAYER ? 0.1 : 0), 0, 1) : 0;
      this.dread += (want - this.dread) * Math.min(1, dt * 1.2);
      this.share = share;

      // Balance of power: when whoever wears the crown grows too strong, the rest unite against them.
      const rivals = F.filter((f) => f.alive && f.ai && f.keeps > 0).length;
      const head = this.crown >= 0 ? F[this.crown] : null;
      const menace = head && world > 0 ? clamp((head.people / world - 0.16) / 0.34 + 0.1, 0, 1) : 0;
      this.menace += (menace - this.menace) * Math.min(1, dt * 1.2);
      const others = rivals - (head && head.ai ? 1 : 0) + (head && head.ai && me.keeps > 0 ? 1 : 0);
      if (this.league < 0) {
        if (head && this.menace >= 0.75 && others >= 2) {
          this.league = head.id;
          if (head.id === PLAYER) {
            this.say('Your rivals made peace with each other. It is aimed at you.', 'omen');
            this.herald('They have united', 'Every rival banner now marches on you.', 'omen');
          } else if (!this.over) {
            this.say('The other houses leagued against ' + this.nm(head.id) + '. For now they have little time for you.', 'info');
          }
        }
      } else if (this.league !== this.crown || this.menace <= 0.45 || others < 2) {
        if (!this.over) this.say(this.league === PLAYER ? 'The league against you fell apart.' : 'The league against ' + this.nm(this.league) + ' fell apart.', 'info');
        this.league = -1;
      }

      // No realm goes unchallenged for long. If too few banners are left, a free town raises one.
      if (rivals < 2 && dt > 0) {
        let town = null;
        for (const k of K) if (k.owner < 0 && (!town || k.pop > town.pop)) town = k;
        if (town) {
          const f = this.addFaction({});
          if (f) {
            town.owner = town.origin = f.id; town.since = this.time; f.seat = town.id;
            town.pool = Math.max(town.pool, town.pop * LEVY.standard.cap * 0.6);
            this.version++;
            this.effect({ type: 'take', k: town.id, owner: f.id, prev: -1, how: 'banner' });
            this.say(town.name + ' raised a banner of its own: ' + f.name + '.', 'omen', town.id);
          }
        }
      }

      // Holding every town is not an ending. With no enemy left outside, the lords look inward.
      if (me.keeps === this.n) {
        if (this.dominionArmed && !this.over) {
          this.dominionArmed = false;
          this.stats.dominions++;
          me.strife += 0.3;
          this.say('Every town flies your banner. Your own lords begin to wonder why they need you.', 'crown');
          this.herald('The realm is yours', 'It will not stay that way.', 'crown');
        }
      } else this.dominionArmed = true;
    }
  }

  return { Game, YEAR, SEASON, SEASONS, HARVEST, TIERS, LEVY, CARRY, ROAD_CAP, PLAYER, HUES };
});
