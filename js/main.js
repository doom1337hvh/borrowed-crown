/*
 * Borrowed Crown: the page around the land.
 * Pointer, touch and keyboard orders, the ledger and orders bars, the chronicle,
 * the first-reign hints and help card, and the title and ending cards.
 *
 * How the hands work (the help card says the same in fewer words):
 *   tap or click one of yours      select it (Shift, or the Several button, adds instead)
 *   tap or click a target town     send the selection there; or drag from the unit to the town
 *   hold a town, or right-click    send the selection there, your own towns included
 *   drag on open ground            a mouse draws a selection box; a finger drags the land
 *   two fingers                    pinch to zoom, twist to turn, drag to move
 *   right drag, middle drag, wheel turn, move, zoom
 * Nothing that started as a drag ever becomes an order by accident, and a costly order
 * (a storm, a sally) only goes out when it was asked for on its own.
 */
(function () {
  'use strict';
  const BC = window.BC, P = BC.PLAYER;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const num = (n) => Math.round(n).toLocaleString('en-US');
  const pct = (v) => Math.round(v * 100) + '%';

  const stage = $('stage'), canvas = $('map'), glCanvas = $('map3d');
  // Two ways of looking at the same war: the flat map, and the land in 3D when the browser can draw it.
  const flat = new BC.Renderer(canvas);
  let solid = null;
  try { if (BC.View3D && BC.View3D.supported()) solid = new BC.View3D(glCanvas, canvas); } catch (e) { solid = null; }
  const sel = flat.sel;
  if (solid) { solid.sel = sel; solid.pad = flat.pad; }
  let R = solid || flat;

  let game = null;
  let mode = 'title';            // title | play | over
  let paused = false, frac = 0.5;
  let inspect = null;            // the last thing tapped that is not ours, so touch players can read it
  let adding = false;            // the Several button: taps add to the selection instead of replacing it
  let touchy = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);   // which words the hints use
  let ptr = null, lastTap = { key: '', t: 0 };
  let hudAt = 0, powerKey = '', bannerTimer = 0, demoAt = 0;
  let helpOpen = false, helpHeld = false;
  let coach = null;              // the first-reign hints: { step, t, ping, target, army, dest, text, w, h }
  let briefNow = '', actNow = '';
  const bound = new Map();       // where each selected column or camp is headed, so the selection can follow the men

  const SEASON_ICON = [
    '<path d="M7 13V6.5M7 8.5C7 5.5 5 4 2.5 4c0 2.6 1.6 4.5 4.5 4.5zM7 6.5c0-2.4 1.8-4.3 4.5-4.3 0 2.6-1.7 4.3-4.5 4.3z"/>',
    '<circle cx="7" cy="7" r="2.6"/><path d="M7 1v1.6M7 11.4V13M1 7h1.6M11.4 7H13M2.8 2.8l1.1 1.1M10.1 10.1l1.1 1.1M11.2 2.8l-1.1 1.1M3.9 10.1l-1.1 1.1"/>',
    '<path d="M7 13V2.5M7 5 4.6 3.4M7 5l2.4-1.6M7 7.6 4.6 6M7 7.6 9.4 6M7 10.2 4.6 8.6M7 10.2l2.4-1.6"/>',
    '<path d="M7 1v12M1.8 4l10.4 6M12.2 4 1.8 10"/>',
  ];
  const EPITAPHS = [
    [0.01, 'Most never do. The ones who do rarely thank you for asking.'],
    [1, 'A crown worn for a season. The chroniclers will not bother.'],
    [3, 'A short reign, and a loud one.'],
    [6, 'They will remember the name, if not the face.'],
    [10, 'Songs will be sung about you. Mostly by your enemies.'],
    [1e9, 'Few have held it so long. Nobody has held it for good.'],
  ];
  const HOLD = 480;              // milliseconds a press must last to count as press-and-hold
  const FIGHTS = { field: 'Battle on the road', gate: 'Relief at the gates', camp: 'Fight for the camp', sally: 'Sally from the gates', storm: 'Storm on the walls' };

  /* ---------- small helpers ---------- */

  function recall(key) { try { return localStorage.getItem('borrowed-crown-' + key); } catch (e) { return null; } }
  function remember(key, value) { try { localStorage.setItem('borrowed-crown-' + key, value); } catch (e) { /* storage is optional */ } }

  function years(seconds) {
    const y = Math.floor(seconds / BC.YEAR), m = Math.floor((seconds % BC.YEAR) / BC.YEAR * 12);
    return y + 'y ' + m + 'm';
  }
  function yearsLong(seconds) {
    const y = Math.floor(seconds / BC.YEAR), m = Math.floor((seconds % BC.YEAR) / BC.YEAR * 12);
    const parts = [];
    if (y) parts.push(y + (y === 1 ? ' year' : ' years'));
    if (m || !y) parts.push(m + (m === 1 ? ' month' : ' months'));
    return parts.join(', ');
  }
  const isCamp = (a) => a.state === 'camp' || (a.state === 'fight' && a.was === 'camp');
  /** A siege camp by id (still one while it storms or is sallied against). */
  function campById(id) {
    for (const a of game.armies) if (a.id === id && a.men >= 1 && isCamp(a)) return a;
    return null;
  }
  /** A column on the road by id. */
  function armyById(id) {
    for (const a of game.armies) if (a.id === id && a.men >= 1 && !isCamp(a)) return a;
    return null;
  }
  const keyOf = (hit) => (hit.type === 'keep' ? 'k' : hit.type === 'camp' ? 'c' : 'a') + hit.id;
  function isMine(hit) {
    if (!hit) return false;
    if (hit.type === 'keep') return game.keeps[hit.id].owner === P;
    const a = hit.type === 'camp' ? campById(hit.id) : armyById(hit.id);
    return !!a && a.owner === P && !a.rout;
  }
  /** The town an order aimed at this thing is really aimed at. Columns on the road are not a target. */
  function townOf(hit) {
    if (hit.type === 'keep') return hit.id;
    if (hit.type === 'army') return -1;
    const c = campById(hit.id);
    return c ? c.at : -1;
  }
  function owner(id) { return id < 0 ? 'a free town' : id === P ? 'yours' : game.factions[id].name; }
  const tapWord = () => (touchy ? 'Tap' : 'Click');

  /* ---------- starting and ending ---------- */

  function setMode(m) {
    mode = m;
    $('game').dataset.mode = m;
    $('tools').hidden = m !== 'play';
  }

  /** Keep the bottom of the map clear of the chronicle, as far as the screen can afford. */
  function frameMap() {
    const w = stage.clientWidth, h = stage.clientHeight;
    R.pad.b = h < 300 ? 30 : w < 640 ? 80 : 58;
    // The flat map cannot be moved, so it stays clear of the buttons in the corner where there is height to spare.
    R.pad.t = !R.is3d && h >= 300 ? 54 : 6;
  }

  /** Switch between the 3D land and the flat map. */
  function setView(kind) {
    const next = kind === 'world' && solid ? solid : flat;
    cancelPointer();
    if (next !== R) { R.hover = null; R.aim = null; R.box = null; R.pull = null; next.quietMap = R.quietMap; R = next; }
    glCanvas.hidden = R !== solid;
    frameMap();
    if (R.game !== game) {
      // A view that has not seen this war yet starts from scratch; the selection is ours to keep.
      const keep = Array.from(sel);
      R.setGame(game);
      for (const key of keep) sel.add(key);
    }
    R.resize();
    const b = $('b-view');
    b.hidden = !solid;
    b.textContent = R === solid ? 'Map' : 'World';
    b.title = R === solid ? 'Show the flat map (V)' : 'Show the land in 3D (V)';
    remember('view', R === solid ? 'world' : 'map');
  }

  function begin(demo, seed) {
    const r = stage.getBoundingClientRect();
    frameMap();
    game = new BC.Game({
      seed: seed || (Math.random() * 0x7fffffff) | 0,
      keeps: clamp(Math.round(r.width * r.height / 26000), r.height < 300 ? 12 : 15, 22),
      aspect: Math.max(60, r.width - R.pad.l - R.pad.r) / Math.max(60, r.height - R.pad.t - R.pad.b),
      bot: demo,
    });
    if (demo) {
      // The title screen opens on a war a year old, a few weeks into the spring, so the land is green.
      for (let i = 0; i < 1700 && !game.over; i++) game.update(0.05);
      game.events.length = 0; game.fx.length = 0;
      demoAt = performance.now();
    }
    R.setGame(game);
    R.quietMap = demo;
    sel.clear(); bound.clear(); inspect = null; powerKey = ''; touches.clear(); gesture = null; swing = null;
    cancelPointer();
    coach = null; $('hint').hidden = true;
    $('chronicle').textContent = '';
    press('seg-levy', 'levy', 'standard');
    setAdding(false);
    setPaused(false);
    hud(true);
  }

  function finish() {
    setMode('over');
    closeHelp();
    sel.clear(); R.quietMap = true; cancelPointer(); coach = null; $('hint').hidden = true;
    const st = game.stats, died = game.ending === 'died', crowned = game.crown === P;
    const held = st.reign / BC.YEAR;
    $('e-title').textContent = died ? (crowned ? 'You died with it on' : 'You died in your bed') : held > 0.01 ? 'The crown passes on' : 'You never wore it';
    $('e-lede').textContent = died
      ? 'A fever took you at ' + game.age + ', ' + (crowned ? 'the crown still on your head' : 'your banner still flying') + '. Your lords were dividing the realm before the funeral.'
      : 'Your last town fell in the ' + BC.SEASONS[game.season].toLowerCase() + ' of year ' + (Math.floor(game.endTime / BC.YEAR) + 1) + '. You were ' + game.age + '.';
    const rows = [
      ['Crown held', yearsLong(st.reign)],
      ['Ruled in all', yearsLong(game.endTime)],
      ['Towns at your height', st.peakKeeps + ' (' + pct(st.peakShare) + ' of the people)'],
      ['Towns taken, then lost', st.taken + ', ' + st.lost],
      ['Banners ended', String(st.ended)],
      ['Risings put down', String(st.quelled)],
      ['Your men buried', num(st.buried)],
    ];
    const dl = $('e-stats');
    dl.textContent = '';
    for (const row of rows) {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = row[0]; dd.textContent = row[1];
      dl.append(dt, dd);
    }
    $('e-epitaph').textContent = EPITAPHS.find((e) => held < e[0])[1];

    const best = +recall('best') || 0;
    if (st.reign > best && st.reign > 0) {
      $('e-best').textContent = best ? 'Your longest hold on the crown yet.' : 'That is the time to beat.';
      remember('best', String(Math.round(st.reign)));
    } else $('e-best').textContent = best ? 'Your longest hold: ' + yearsLong(best) + '.' : 'Next time, take the crown before they take you.';
    $('veil-end').hidden = false;
    BC.audio.play('fall');
    $('b-again').focus({ preventScroll: true });
  }

  /** The neighbour of the seat that needs the fewest men to take: where the first hint points. */
  function firstTarget(seat) {
    let best = -1, need = Infinity;
    for (const id of seat.adj) {
      const k = game.keeps[id];
      if (k.owner === P) continue;
      const n = k.men * game.wall(k, null) + (k.owner < 0 ? 0 : 150);      // a free town has nobody to avenge it
      if (n < need) { need = n; best = id; }
    }
    return best;
  }

  /** Open the reign close enough to see the men: the player's town and its nearest prize, side by side. */
  function openOn(seat, target) {
    if (!R.is3d || !R.goal || !R.focus) return;
    const T = target >= 0 ? game.keeps[target] : seat;
    const dx = Math.abs(T.x - seat.x) / 2 + 85, dy = Math.abs(T.y - seat.y) / 2 + 85;
    const aspect = stage.clientWidth / Math.max(1, stage.clientHeight);
    const dist = clamp(Math.max(dy / 0.3, dx / (0.27 * aspect)), 320, R.far || 2000);
    R.focus((seat.x + T.x) / 2, (seat.y + T.y) / 2);
    R.goal.dist = dist;
    if (R.tilt) R.goal.pitch = R.tilt(dist);      // the view's own idea of how low to look from that close
    R.orbit(0, 0);                                // and its limits on that
  }

  function play() {
    BC.audio.boot();
    setMode('play');
    $('veil-title').hidden = true; $('veil-end').hidden = true;
    closeHelp();
    begin(false);
    const seat = game.keeps[game.factions[P].seat], target = firstTarget(seat);
    game.events.push({ type: 'say', text: 'You hold ' + seat.name + '. Your banner is the blue one.', tone: 'crown', k: seat.id });
    openOn(seat, target);
    // The first reign is walked through its first order, and shown the controls once.
    if (recall('taught') !== '1') coach = { step: 0, t: 0, ping: -9, target: target, army: -1, dest: -1, text: '', w: 0, h: 0 };
    if (recall('helped') !== '1') openHelp();
    if (document.activeElement && document.activeElement !== document.body && !helpOpen) document.activeElement.blur();
  }

  /* ---------- chronicle and banner ---------- */

  function chronicle(text, tone) {
    const list = $('chronicle'), li = document.createElement('li');
    li.className = tone; li.textContent = text;
    list.appendChild(li);
    const max = stage.clientHeight < 300 ? 2 : stage.clientWidth < 640 ? 3 : 4;
    while (list.children.length > max) list.firstChild.remove();
    setTimeout(() => li.classList.add('old'), 9000);
    setTimeout(() => li.remove(), 10000);
  }

  function herald(text, sub, tone) {
    const b = $('banner');
    b.className = 'banner show ' + tone;
    b.firstElementChild.textContent = text;
    b.lastElementChild.textContent = sub; b.lastElementChild.hidden = !sub;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => b.classList.remove('show'), 3600);
  }

  function drain() {
    if (game.fx.length) {
      if (mode === 'play') {
        for (const e of game.fx) {
          if (e.type === 'battle' && (e.a === P || e.b === P)) BC.audio.play('battle');
          else if (e.type === 'take') { if (e.owner === P) BC.audio.play('take'); else if (e.prev === P) BC.audio.play('lost'); }
        }
        R.ingest(game.fx);
      } else R.ingest(game.fx.filter((e) => e.type !== 'float'));
      game.fx.length = 0;
    }
    if (!game.events.length) return;
    const list = game.events.slice();
    game.events.length = 0;
    if (mode !== 'play') return;
    for (const e of list) {
      if (e.type === 'say') { chronicle(e.text, e.tone); if (e.k >= 0) R.ping(e.k, e.tone); if (e.tone === 'omen') BC.audio.play('omen'); }
      else if (e.type === 'banner') { herald(e.text, e.sub, e.tone); BC.audio.play(e.tone === 'crown' ? 'crown' : 'omen'); }
      else if (e.type === 'sfx') BC.audio.play(e.name);
      else if (e.type === 'season') { if (e.season === 3) BC.audio.play('winter'); }
    }
  }

  /* ---------- orders ---------- */

  /** What would happen if these sources were ordered to this town: lines to draw and a sentence. */
  function preview(keys, to) {
    const T = game.keeps[to];
    if (!T) return null;
    const lines = [], alone = keys.size === 1;
    let men = 0, storming = null, sally = null, any = false;
    for (const key of keys) {
      const id = +key.slice(1);
      if (key[0] === 'k') {
        const k = game.keeps[id];
        if (k.owner !== P) continue;
        if (k.camp) { if (id === to && alone) sally = k; continue; }
        if (id === to || k.men < 1) continue;
        const path = game.route(id, to, P);
        if (!path) continue;
        lines.push(path.map((i) => R.at(game.keeps[i].x, game.keeps[i].y)));
        men += Math.max(1, Math.floor(k.men * frac)); any = true;
      } else if (key[0] === 'c') {
        const c = campById(id);
        if (!c || c.owner !== P) continue;
        if (c.at === to) { if (alone) storming = c; continue; }
        const path = game.route(c.at, to, P);
        if (!path) continue;
        const pts = path.map((i) => R.at(game.keeps[i].x, game.keeps[i].y));
        pts[0] = R.campAt(c);
        lines.push(pts);
        men += Math.max(1, Math.floor(c.men * frac)); any = true;
      } else {
        // A column already on the road: it carries on or turns round, whichever is shorter.
        const a = armyById(id);
        if (!a || a.owner !== P || a.state !== 'march' || a.rout) continue;
        const plan = game.redirectPlan(a, to);
        if (!plan) continue;
        const pts = plan.path.slice(1).map((i) => R.at(game.keeps[i].x, game.keeps[i].y));
        pts.unshift(R.armyAt(a));
        lines.push(pts);
        men += Math.floor(a.men); any = true;
      }
    }
    let text, tone = 'info';
    if (storming && !any) {
      const o = game.stormOdds(storming);
      text = 'Storm the walls: ' + o.word + ', about ' + num(o.loss) + ' dead';
      tone = o.ratio >= 1.12 ? 'good' : 'bad';
    } else if (sally && !any) {
      text = 'Sally out: ' + num(Math.floor(sally.men * frac)) + ' against ' + num(sally.camp.men) + ' in the camp';
    } else if (!any) {
      let asked = false;
      for (const key of keys) if (key !== 'k' + to) asked = true;
      if (!asked) return null;
      text = 'No road through your own lands'; tone = 'bad';
    } else if (T.owner === P) {
      text = T.camp ? 'Relieve ' + T.name + ': ' + num(men) + ' against ' + num(T.camp.men) + ' besiegers' : 'Reinforce ' + T.name + ' with ' + num(men);
    } else {
      const mine = T.camp && T.camp.owner === P ? T.camp : null;
      const wall = game.wall(T, mine), total = men + (mine ? mine.men : 0);
      if (T.camp && !mine) text = num(men) + ' against ' + num(T.camp.men) + ' already camped at ' + T.name;
      else if (total >= T.men * wall * 3) { text = num(men) + ' men: the gates will open'; tone = 'good'; }
      else text = num(men) + ' against ' + num(T.men) + ' behind walls ×' + wall.toFixed(1) + ': a siege';
    }
    return { lines: lines, target: to, text: text, tone: tone };
  }

  /** Say no, at the town the order was aimed at. */
  function refuse(to, text) {
    const T = game.keeps[to];
    R.floats.push({ x: T.x, y: T.y, text: text, tone: 'bad', life: 1.8, max: 1.8 });
    BC.audio.play('deny');
  }

  /**
   * Carry out an order from every source in `keys` toward town `to`. Returns true if anyone moved.
   * A camp storms and a besieged town sallies only when it was asked on its own: swept up in a
   * larger selection it stays where it is, so gathering men never starts an assault by accident.
   */
  function command(to, keys) {
    if (to < 0) return false;
    if (paused) { refuse(to, 'Paused: resume to give orders'); return false; }
    const alone = keys.size === 1;
    let done = 0, asked = 0, road = false, busy = false;
    for (const key of Array.from(keys)) {
      const id = +key.slice(1);
      if (key[0] === 'k') {
        const k = game.keeps[id];
        if (k.owner !== P) continue;
        if (k.camp) { if (id !== to || !alone) continue; road = true; if (k.battle || k.camp.state !== 'camp') busy = true; }
        else if (id === to) continue;
        else if (game.route(id, to, P)) { road = true; if (k.battle) busy = true; }
        asked++;
        if (game.orderKeep(id, to, frac)) done++;
      } else if (key[0] === 'c') {
        const c = campById(id);
        if (!c || c.owner !== P) continue;
        if (c.at === to && !alone) continue;
        asked++;
        if (c.at === to || game.route(c.at, to, P)) road = true;
        if (c.state !== 'camp' || (c.at === to && game.keeps[to].battle)) busy = true;
        if (game.orderCamp(id, to, frac)) done++;
      } else {
        const a = armyById(id);
        if (!a || a.owner !== P) continue;
        asked++;
        if (a.state !== 'march') { busy = true; road = true; }
        if (game.orderArmy(id, to)) { done++; road = true; }
      }
    }
    if (done) BC.audio.play('march');
    else if (asked) refuse(to, busy ? 'They are in the fight' : road ? 'No men to send' : 'No road through your own lands');
    if (done && adding) setAdding(false);
    prune();
    return done > 0;
  }

  /** Drop what is no longer ours from the selection, and follow the men where they went. */
  function prune() {
    for (const key of Array.from(sel)) {
      const id = +key.slice(1);
      if (key[0] === 'k') { if (game.keeps[id].owner !== P) sel.delete(key); continue; }
      const c = campById(id), a = armyById(id);
      const live = key[0] === 'c' ? c : a, other = key[0] === 'c' ? a : c;
      if (live && live.owner === P && !live.rout) { bound.set(id, key[0] === 'c' ? live.at : live.path[live.path.length - 1]); continue; }
      sel.delete(key);
      // The same men in a new shape stay selected: a column that pitched camp, a camp that
      // marched off, or the town they walked into.
      if (other && other.owner === P && !other.rout) sel.add((key[0] === 'c' ? 'a' : 'c') + id);
      else if (!live && !other && bound.has(id) && game.keeps[bound.get(id)].owner === P) sel.add('k' + bound.get(id));
      if (!other) bound.delete(id);
    }
    if (inspect && inspect.type !== 'keep' && !campById(inspect.id) && !armyById(inspect.id)) inspect = null;
  }

  function selectAll() {
    sel.clear();
    for (const k of game.keeps) if (k.owner === P) sel.add('k' + k.id);
    for (const a of game.armies) if (a.owner === P && a.men >= 1 && !a.rout) sel.add((isCamp(a) ? 'c' : 'a') + a.id);
  }

  /**
   * The red button: storm with the selected camps, or sally from the selected besieged towns.
   * While the fight it started (or any fight at those walls) is on, it stays up but cannot be pressed.
   */
  function actionFor() {
    let camp = null, town = null, busy = null;
    for (const key of sel) {
      const id = +key.slice(1);
      if (key[0] === 'c') {
        const c = campById(id);
        if (!c || c.owner !== P) continue;
        if (c.state === 'camp' && !game.keeps[c.at].battle) { if (!camp) camp = c; }
        else if (!busy) busy = c.battle || game.keeps[c.at].battle;
      } else if (key[0] === 'k') {
        const k = game.keeps[id];
        if (k.owner !== P || !k.camp) continue;
        if (!k.battle && k.camp.state === 'camp') { if (!town) town = k; }
        else if (!busy) busy = k.battle || k.camp.battle;
      }
    }
    if (camp) return { kind: 'storm', camp: camp };
    if (town) return { kind: 'sally', town: town };
    if (busy) return { kind: 'busy', battle: busy };
    return null;
  }

  function act() {
    const a = actionFor();
    if (!a || a.kind === 'busy') return;
    if (paused) { refuse(a.kind === 'storm' ? a.camp.at : a.town.id, 'Paused: resume to give orders'); return; }
    let done = 0;
    if (a.kind === 'storm') {
      for (const key of Array.from(sel)) if (key[0] === 'c') { const c = campById(+key.slice(1)); if (c && c.owner === P && game.orderCamp(c.id, c.at, 1)) done++; }
    } else {
      for (const key of Array.from(sel)) if (key[0] === 'k') { const k = game.keeps[+key.slice(1)]; if (k.owner === P && k.camp && game.orderKeep(k.id, k.id, frac)) done++; }
    }
    if (!done) BC.audio.play('deny');
    prune(); hud(true);
  }

  /* ---------- pointer ---------- */

  function point(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  const same = (a, b) => a && b && a.type === b.type && a.id === b.id;
  function dragKeys(hit) {
    const key = keyOf(hit);
    return sel.has(key) && sel.size > 1 ? new Set(sel) : new Set([key]);
  }
  /**
   * What is under a screen point. A column still inside the walls it is leaving (or entering) sits
   * on top of its town; if the pointer is nearer the town's centre than the column's head, the
   * town is what was meant.
   */
  function pickAt(x, y) {
    const hit = R.pick(x, y);
    if (!hit || hit.type !== 'army') return hit;
    const a = armyById(hit.id);
    if (!a || a.state !== 'march') return hit;
    const p = R.armyAt(a), da = Math.hypot(p[0] - x, p[1] - y);
    for (const id of [a.path[a.i], a.path[a.i + 1]]) {
      const k = game.keeps[id];
      if (!k || Math.hypot(a.x - k.x, a.y - k.y) > 26) continue;
      const q = R.at(k.x, k.y);
      if (Math.hypot(q[0] - x, q[1] - y) < da) return { type: 'keep', id: id };
    }
    return hit;
  }

  /** True when the only thing an order to this town could mean is an assault by the one selected camp. */
  function stormOnly(to) {
    if (sel.size !== 1) return false;
    const key = sel.values().next().value;
    if (key[0] !== 'c') return false;
    const c = campById(+key.slice(1));
    return !!c && c.at === to;
  }
  /** Holding or right-clicking the only thing selected, when it has nothing to answer with, is not an order. */
  function idle(to) {
    return sel.size === 1 && sel.has('k' + to) && !game.keeps[to].camp;
  }

  // Camera: two fingers pinch, twist and drag; the right mouse button swings, the middle one drags, the wheel zooms.
  const touches = new Map();
  let gesture = null, swing = null;
  function twoFingers() {
    const [a, b] = Array.from(touches.values());
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1, ang: Math.atan2(b.y - a.y, b.x - a.x), twist: 0 };
  }
  function cancelPointer() {
    if (ptr) clearTimeout(ptr.timer);
    ptr = null; R.pull = null; R.box = null; R.aim = null;
  }

  canvas.addEventListener('wheel', (e) => {
    if (mode !== 'play') return;
    e.preventDefault();
    const p = point(e);
    // Wheels report lines or pixels, and a trackpad pinch arrives as a wheel with Ctrl held and tiny steps.
    const d = e.deltaY * (e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 300 : 1) * (e.ctrlKey ? 6 : 1);
    R.zoomAt(p.x, p.y, Math.exp(clamp(d, -300, 300) * 0.0014));
  }, { passive: false });

  canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'play') return;
    const p = point(e), touch = e.pointerType === 'touch';
    if (touch) {
      if (R.coarse === false) R.coarse = true;   // a finger on a screen that also has a mouse: pick as generously as on a phone
      R.hover = null;
      if (e.isPrimary) touches.clear();          // a first finger starts afresh, whatever an earlier touch left behind
      touches.set(e.pointerId, p);
      if (touches.size === 2) { cancelPointer(); gesture = twoFingers(); return; }
      if (touches.size > 2) return;
    } else if (e.button === 2 || e.button === 1) {
      swing = { id: e.pointerId, x: p.x, y: p.y, x0: p.x, y0: p.y, moved: false, pan: e.button === 1 };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
      e.preventDefault();
      return;
    } else if (e.button !== 0) return;
    BC.audio.boot();
    if (ptr) clearTimeout(ptr.timer);
    const hit = pickAt(p.x, p.y);
    ptr = { id: e.pointerId, x0: p.x, y0: p.y, x: p.x, y: p.y, hit: hit, mine: isMine(hit), moved: false, shift: e.shiftKey, timer: 0, touch: touch, drift: false, stamp: e.timeStamp, hold: -1 };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
    // Press and hold on a town sends the selection there, the way a right click does. Never on our
    // own camp or column: holding those must not start an assault. After a moment the order is
    // drawn on the land, and letting go gives it. How long the press lasted is read from the
    // events themselves in release(), so a slow frame can never turn a quick tap into a hold.
    const to = hit && sel.size && (hit.type === 'keep' || (hit.type === 'camp' && !isMine(hit))) ? townOf(hit) : -1;
    if (to >= 0 && !idle(to)) {
      ptr.hold = to;
      ptr.timer = setTimeout(() => { if (ptr && ptr.hold === to && !ptr.moved && !paused) R.aim = preview(sel, to); }, HOLD);
    }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (mode !== 'play') return;
    const p = point(e);
    if (touches.has(e.pointerId)) {
      touches.set(e.pointerId, p);
      if (gesture && touches.size === 2) {
        const g = twoFingers();
        R.pan(g.x - gesture.x, g.y - gesture.y);
        R.zoomAt(g.x, g.y, gesture.d / g.d);
        let turn = g.ang - gesture.ang;
        if (turn > Math.PI) turn -= 2 * Math.PI; else if (turn < -Math.PI) turn += 2 * Math.PI;
        // A pinch always wobbles a little: the land only turns once the fingers have clearly twisted.
        g.twist = gesture.twist + turn;
        if (Math.abs(g.twist) > 0.16) R.orbit(-turn, 0);
        gesture = g;
        return;
      }
    }
    if (swing && e.pointerId === swing.id) {
      // If the button came up somewhere we could not see, let go rather than drag for ever.
      if (!(e.buttons & (swing.pan ? 4 : 2))) { swing = null; return; }
      if (!swing.moved && Math.hypot(p.x - swing.x0, p.y - swing.y0) > 5) swing.moved = true;
      if (swing.moved) { if (swing.pan) R.pan(p.x - swing.x, p.y - swing.y); else R.orbit(-(p.x - swing.x) * 0.006, (p.y - swing.y) * 0.004); }
      swing.x = p.x; swing.y = p.y;
      return;
    }
    // A mouse that moves with no button down has been released somewhere we could not see.
    if (ptr && e.pointerId === ptr.id && e.pointerType === 'mouse' && !(e.buttons & 1)) cancelPointer();
    if (!ptr) {
      if (e.pointerType !== 'mouse') return;
      const hit = pickAt(p.x, p.y);
      R.hover = hit;
      canvas.style.cursor = hit ? 'pointer' : 'default';
      R.aim = hit && sel.size && !isMine(hit) && !paused ? preview(sel, townOf(hit)) : null;
      return;
    }
    if (e.pointerId !== ptr.id) return;
    if (!ptr.moved && Math.hypot(p.x - ptr.x0, p.y - ptr.y0) > (ptr.touch ? 12 : 7)) { ptr.moved = true; ptr.hold = -1; clearTimeout(ptr.timer); R.aim = null; }
    if (!ptr.moved) return;
    if (ptr.mine) {
      // Dragging from one of ours: an order in the making, shown before it is given.
      const over = pickAt(p.x, p.y);
      if (over && !same(over, ptr.hit)) { R.aim = preview(dragKeys(ptr.hit), townOf(over)); R.pull = null; }
      else R.aim = null;
      if (!R.aim) {
        const c = ptr.hit.type === 'camp' ? campById(ptr.hit.id) : null;
        const k = ptr.hit.type === 'keep' ? game.keeps[ptr.hit.id] : null;
        const a = ptr.hit.type === 'army' ? armyById(ptr.hit.id) : null;
        const from = k ? R.at(k.x, k.y) : c ? R.campAt(c) : a ? R.armyAt(a) : null;
        R.pull = from ? { from: from, to: [p.x, p.y] } : null;
      }
    } else if (ptr.drift || (ptr.touch && R.is3d && !adding)) {
      // Anywhere else a finger drags the land, even if it came down on someone else's town.
      R.pan(p.x - ptr.x, p.y - ptr.y);
    } else {
      // A mouse draws a selection box. So does a finger on the flat map, or with Several pressed.
      R.box = { x0: ptr.x0, y0: ptr.y0, x1: p.x, y1: p.y };
    }
    ptr.x = p.x; ptr.y = p.y;
  });

  function boxSelect(box, add) {
    if (!add) sel.clear();
    const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1), y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
    const inside = (pt) => pt[2] !== false && pt[0] >= x0 && pt[0] <= x1 && pt[1] >= y0 && pt[1] <= y1;
    for (const k of game.keeps) if (k.owner === P && inside(R.at(k.x, k.y))) sel.add('k' + k.id);
    for (const a of game.armies) {
      if (a.owner !== P || a.men < 1 || a.rout) continue;
      if (isCamp(a)) { if (inside(R.campAt(a))) sel.add('c' + a.id); } else if (inside(R.armyAt(a))) sel.add('a' + a.id);
    }
    inspect = null;
  }

  function release(e) {
    touches.delete(e.pointerId);
    const wasGesture = gesture;
    if (touches.size < 2) gesture = null;
    if (swing && e.pointerId === swing.id) {
      const s = swing;
      swing = null;
      // A right click that did not turn into a drag is an order for the selection.
      if (!s.moved && !s.pan && mode === 'play') {
        const hit = pickAt(s.x, s.y), to = hit ? townOf(hit) : -1;
        if (to >= 0 && sel.size && !idle(to) && !(hit.type !== 'keep' && isMine(hit))) { command(to, sel); R.aim = null; hud(true); }
      }
      return;
    }
    if (wasGesture && touches.size === 1) {
      // One finger of a pinch is still down: it goes on dragging the land and is never a tap.
      const [id, pt] = touches.entries().next().value;
      ptr = { id: id, x0: pt.x, y0: pt.y, x: pt.x, y: pt.y, hit: null, mine: false, moved: true, shift: false, timer: 0, touch: true, drift: true, stamp: e.timeStamp, hold: -1 };
      return;
    }
    if (!ptr || e.pointerId !== ptr.id) return;
    clearTimeout(ptr.timer);
    const q = ptr, p = point(e);
    ptr = null; R.pull = null; R.aim = null;
    const box = R.box; R.box = null;
    if (mode !== 'play') return;
    if (q.moved) {
      if (q.mine) {
        const over = pickAt(p.x, p.y);
        if (over && !same(over, q.hit)) command(townOf(over), dragKeys(q.hit));
      } else if (box) boxSelect(box, q.shift || adding);
      // (a finger that dragged the land has nothing more to say)
    } else if (q.hold >= 0 && e.timeStamp - q.stamp >= HOLD) {
      command(q.hold, sel);                       // pressed and held: the selection goes there
    } else if (q.mine) {
      const key = keyOf(q.hit);
      if (q.shift || adding) { if (sel.has(key)) sel.delete(key); else sel.add(key); }
      else if (lastTap.key === key && e.timeStamp - lastTap.t < 340) selectAll();
      else { sel.clear(); sel.add(key); }
      lastTap = { key: key, t: e.timeStamp };
      inspect = null;
    } else if (q.hit) {
      // Something that is not ours: a target for the selection, or else something to read about.
      // A finger cannot see the odds before it lands, so a tap alone never starts a storm.
      const to = townOf(q.hit);
      if (to >= 0 && sel.size && !(q.touch && stormOnly(to))) { command(to, sel); inspect = null; }
      else inspect = q.hit;
    } else if (!adding) { sel.clear(); inspect = null; }
    hud(true);
  }
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', (e) => {
    // The browser took the touch away (a system gesture, a call): forget it without acting on it.
    touches.delete(e.pointerId);
    if (touches.size < 2) gesture = null;
    if (swing && e.pointerId === swing.id) swing = null;
    if (ptr && e.pointerId === ptr.id) cancelPointer();
  });
  canvas.addEventListener('pointerleave', () => { if (!ptr) { R.hover = null; R.aim = null; } });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // The hints speak of taps or clicks according to the hand last used, anywhere on the page.
  window.addEventListener('pointerdown', (e) => { touchy = e.pointerType === 'touch'; }, true);
  window.addEventListener('blur', () => { touches.clear(); gesture = null; swing = null; cancelPointer(); });

  /* ---------- buttons and keys ---------- */

  function press(groupId, attr, value) {
    for (const b of $(groupId).children) b.setAttribute('aria-pressed', String(b.dataset[attr] === String(value)));
  }
  function setFrac(v) { frac = v; press('seg-send', 'frac', v); hud(true); }
  function setLevy(v) { game.setLevy(v); press('seg-levy', 'levy', v); hud(true); }
  function setAdding(v) {
    adding = v;
    $('b-add').setAttribute('aria-pressed', String(v));
  }
  function setPaused(v) {
    paused = v;
    $('halt').hidden = !v || mode !== 'play' || helpOpen;
    $('ico-pause').setAttribute('d', v ? 'M4 2l10 6-10 6z' : 'M3 2h4v12H3zM9 2h4v12H9z');
    $('b-pause').setAttribute('aria-label', v ? 'Resume' : 'Pause');
    $('b-pause').title = v ? 'Resume (space)' : 'Pause (space)';
    if (v) R.aim = null;
  }
  function setSound(v) {
    BC.audio.set(v);
    $('b-sound').setAttribute('aria-pressed', String(v));
    $('b-sound').setAttribute('aria-label', v ? 'Sound on' : 'Sound off');
    $('ico-sound').setAttribute('d', v ? 'M2 6h3l4-3.5v11L5 10H2z M11 5.2a4 4 0 0 1 0 5.6l-1-1a2.6 2.6 0 0 0 0-3.6z' : 'M2 6h3l4-3.5v11L5 10H2z M10.6 6l3.4 4m0-4-3.4 4 .7.7L14.7 6.7z');
    remember('sound', v ? '1' : '0');
  }

  /* The help card: the controls for the hand in use. The war waits while it is open. */
  function showHelp(kind) {
    press('seg-help', 'help', kind);
    $('help-touch').hidden = kind !== 'touch';
    $('help-mouse').hidden = kind !== 'mouse';
  }
  function openHelp() {
    if (helpOpen) return;
    helpOpen = true; helpHeld = paused;
    if (mode === 'play') setPaused(true);
    showHelp(touchy ? 'touch' : 'mouse');
    $('veil-help').hidden = false;
    $('b-help-close').focus({ preventScroll: true });
  }
  function closeHelp() {
    if (!helpOpen) return;
    helpOpen = false;
    $('veil-help').hidden = true;
    if (mode === 'play') setPaused(helpHeld);
    remember('helped', '1');
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  }

  $('seg-send').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setFrac(+b.dataset.frac); });
  $('seg-levy').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && mode === 'play') setLevy(b.dataset.levy); });
  $('seg-help').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showHelp(b.dataset.help); });
  $('b-act').addEventListener('click', act);
  $('b-add').addEventListener('click', () => { if (mode === 'play') { setAdding(!adding); hud(true); } });
  $('b-pause').addEventListener('click', () => { if (mode === 'play') setPaused(!paused); });
  $('b-sound').addEventListener('click', () => { BC.audio.boot(); setSound(!BC.audio.on); });
  $('b-start').addEventListener('click', play);
  $('b-again').addEventListener('click', play);
  $('b-view').addEventListener('click', () => setView(R === solid ? 'map' : 'world'));
  $('b-home').addEventListener('click', () => R.home());
  $('b-help').addEventListener('click', openHelp);
  $('b-help-close').addEventListener('click', closeHelp);
  $('veil-help').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeHelp(); });
  // A button pressed with a mouse or a finger must not keep the keyboard: the next press of
  // space is meant for the war, not for that button again.
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (b && e.detail > 0 && !b.closest('.veil') && document.activeElement === b) b.blur();
  });

  // Keys held down to move the camera, applied a little every frame.
  const held = new Set();
  window.addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => held.clear());
  function steer(dt) {
    if (!held.size || mode !== 'play' || helpOpen) return;
    const step = 620 * dt;
    if (held.has('arrowleft')) R.pan(step, 0);
    if (held.has('arrowright')) R.pan(-step, 0);
    if (held.has('arrowup')) R.pan(0, step);
    if (held.has('arrowdown')) R.pan(0, -step);
    if (held.has('q')) R.orbit(1.4 * dt, 0);
    if (held.has('e')) R.orbit(-1.4 * dt, 0);
    if (held.has('=') || held.has('+')) R.zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, Math.exp(-1.6 * dt));
    if (held.has('-') || held.has('_')) R.zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, Math.exp(1.6 * dt));
  }

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (helpOpen) { if (k === 'escape' || k === '?') { e.preventDefault(); closeHelp(); } return; }
    if (mode !== 'play') { if (k === 'enter' && document.activeElement === document.body) play(); return; }
    if (k === '1') setFrac(0.25);
    else if (k === '2') setFrac(0.5);
    else if (k === '3') setFrac(1);
    else if (k === ' ' || k === 'p') { if (e.target.tagName !== 'BUTTON' || k === 'p') { e.preventDefault(); setPaused(!paused); } }
    else if (k === 'a') { selectAll(); hud(true); }
    else if (k === 'escape') { sel.clear(); inspect = null; cancelPointer(); setAdding(false); hud(true); }
    else if (k === 'm') setSound(!BC.audio.on);
    else if (k === 's') act();
    else if (k === 'v') setView(R === solid ? 'map' : 'world');
    else if (k === 'h' || k === 'home') R.home();
    else if (k === '?') openHelp();
    else if (k.startsWith('arrow') || 'qe=+-_'.includes(k)) { held.add(k); if (k.startsWith('arrow')) e.preventDefault(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden || mode !== 'play' || game.over) return;
    if (helpOpen) helpHeld = true; else setPaused(true);
  });

  /* ---------- first-reign hints, pinned to things in the land ---------- */

  /** A screen point just above a town's highest banner (or its tower, on the flat map). */
  function overTown(k) {
    if (!R.is3d) { const p = R.at(k.x, k.y); return [p[0], p[1] - 30, true]; }
    const s = R.towns && R.towns.site && R.towns.site(k.id);
    return R.at(k.x, k.y, (s && s.top ? s.top : 12 + k.tier * 5) + 12);
  }
  function overArmy(a) {
    const p = isCamp(a) ? R.campAt(a) : R.armyAt(a);
    return [p[0], p[1] - 18, p[2] !== false];
  }

  /** Decide what the hint says and where it points, then move the bubble there. */
  function teach(dt) {
    const el = $('hint');
    if (!coach || mode !== 'play' || helpOpen) { if (!el.hidden) el.hidden = true; return; }
    const c = coach, seat = game.keeps[game.factions[P].seat];
    if (!paused) c.t += dt;
    let text = '', at = null, mark = -1;
    const mine = (a) => a.owner === P && a.men >= 1;
    if (c.step < 2) {
      const out = game.armies.find(mine);
      if (out) { c.step = 2; c.t = 0; c.army = out.id; remember('taught', '1'); }
      else if (!seat || seat.owner !== P) { coach = null; el.hidden = true; return; }
      else if (!sel.size) { c.step = 0; text = seat.name + ' is yours. ' + tapWord() + ' it.'; at = overTown(seat); mark = seat.id; }
      else {
        c.step = 1;
        const T = game.keeps[c.target >= 0 && game.keeps[c.target].owner !== P ? c.target : (c.target = firstTarget(seat))];
        if (T) { text = 'Now ' + tapWord().toLowerCase() + ' ' + T.name + ' to march on it.'; at = overTown(T); mark = T.id; }
      }
      // A ring on the ground every few seconds says the same thing in the land itself, and where
      // the view can, an arrow at the edge of the screen when the town has been dragged out of sight.
      if (mark >= 0 && !paused && c.t - c.ping > 2.8) { c.ping = c.t; R.ping(mark, 'crown'); }
    }
    if (c.step === 2) {
      // The first men on the road, then what became of them.
      const a = game.armies.find((x) => x.id === c.army && mine(x));
      if (!a) { c.step = 4; c.t = 0; }
      else if (isCamp(a)) { c.step = 3; c.t = 0; }
      else {
        c.dest = a.path[a.path.length - 1];
        if (c.t < 9) { text = R.is3d ? 'Your men are on the road. Zoom in to watch them.' : 'Your men are on the road.'; at = overArmy(a); }
      }
    }
    if (c.step === 3) {
      const a = game.armies.find((x) => x.id === c.army && mine(x) && isCamp(x));
      if (!a) { c.step = 4; c.t = 0; }
      else if (c.t < 12) { text = 'They have camped at the walls. Wait for hunger to open the gates, or select the camp and press Storm.'; at = overArmy(a); }
      else { coach = null; el.hidden = true; return; }
    }
    if (c.step === 4) {
      // The column is gone: into a town it took or reinforced, or into the ground.
      const k = c.dest >= 0 && game.keeps[c.dest].owner === P && (!seat || c.dest !== seat.id) ? game.keeps[c.dest] : null;
      if (k && c.t < 7) { text = k.name + ' is yours. Its people now feed and fill your armies.'; at = overTown(k); }
      else { coach = null; el.hidden = true; return; }
    }
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!text || !at || at[2] === false || at[0] < -10 || at[0] > W + 10 || at[1] < 0 || at[1] > H + 30) { if (!el.hidden) el.hidden = true; return; }
    if (c.text !== text || el.hidden) {
      c.text = text; $('hint-text').textContent = text;
      el.hidden = false;
      c.w = el.offsetWidth; c.h = el.offsetHeight;
    }
    const x = clamp(at[0] - c.w / 2, 8, Math.max(8, W - c.w - 8));
    let y = at[1] - c.h - 10, below = false;
    if (y < 6) { y = at[1] + 44; below = true; }           // no room above: hang under it instead
    y = clamp(y, 6, Math.max(6, H - c.h - 6));
    el.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
    el.style.setProperty('--ax', Math.round(clamp(at[0] - x, 12, c.w - 12)) + 'px');
    el.classList.toggle('below', below);
  }

  /* ---------- the ledger and the briefing line ---------- */

  function span(cls, text) { return '<span' + (cls ? ' class="' + cls + '"' : '') + '>' + text + '</span>'; }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** A battle being fought right now, in one sentence. */
  function briefFight(b) {
    const side = (s) => (s.owner === P ? 'your ' + num(s.men0) : num(s.men0) + (s.owner < 0 ? ' townsmen' : ' of ' + esc(game.factions[s.owner].name)));
    const ours = b.att.owner === P || b.def.owner === P;
    return span(ours ? 'warn wrap' : 'wrap', FIGHTS[b.kind] + ': ' + side(b.att) + ' against ' + side(b.def)) + ' ' +
      span('dim', num(b.att.dead) + ' and ' + num(b.def.dead) + ' dead so far');
  }

  function briefTown(k) {
    const tier = BC.TIERS[k.tier].label, mine = k.owner === P;
    const out = ['<b>' + esc(k.name) + '</b>', span('dim', tier + ', ' + esc(owner(k.owner)))];
    if (k.battle) out.push(briefFight(k.battle));
    if (mine) {
      out.push(span('', num(k.men) + ' men ' + span('dim', '(can feed ' + num(game.feeds(k)) + ')')));
      if (k.camp && !k.battle) out.push(span('warn', 'besieged by ' + num(k.camp.men)));
      out.push(k.hungry ? span('warn', 'no grain, men deserting') : span('', 'grain ' + pct(k.food / k.cap)));
      if (k.unrest >= 0.15) {
        const why = game.grievances(k).slice(0, 2).join(', ');
        out.push(span(k.unrest > 0.7 ? 'warn' : '', 'unrest ' + pct(Math.min(1, k.unrest)) + (why ? ': ' + why : '')));
      } else out.push(span('fine', 'quiet'));
      out.push(span('', num(k.pop) + ' people'));
      if (!k.camp && k.pool >= 20) out.push(span('dim', num(k.pool) + ' more answering the levy'));
    } else {
      const camp = k.camp && k.camp.owner === P ? k.camp : null;
      out.push(span('', num(k.men) + ' men behind walls ×' + game.wall(k, camp).toFixed(1)));
      out.push(k.hungry ? span('fine', 'starving') : span('', 'grain ' + pct(k.food / k.cap)));
      if (k.camp && !k.battle) out.push(span(camp ? 'fine' : '', 'besieged by ' + (camp ? 'your ' + num(camp.men) : num(k.camp.men) + ' of ' + esc(game.factions[k.camp.owner].name))));
      out.push(span('', num(k.pop) + ' people'));
      if (k.owner >= 0 && k.unrest > 0.6) out.push(span('', 'restless'));
    }
    return out.join(' ');
  }

  function briefCamp(c) {
    const k = game.keeps[c.at], mine = c.owner === P, fight = c.battle || k.battle;
    const out = ['<b>' + (mine ? 'Your camp at ' : esc(game.factions[c.owner].name) + ' camp at ') + esc(k.name) + '</b>', span('', num(c.men) + ' men'),
      c.hungry ? span(mine ? 'warn' : 'fine', 'starving') : span(mine ? 'fine' : '', 'fed')];
    if (fight) out.push(briefFight(fight));
    else {
      out.push(span('', 'walls breached ' + pct(c.breach)));
      if (mine) { const o = game.stormOdds(c); out.push(span(o.ratio >= 1.12 ? 'fine' : 'warn', 'storm: ' + o.word + ' (about ' + num(o.loss) + ' dead)')); }
    }
    out.push(span('dim', 'town has ' + num(k.men) + ' men, grain ' + pct(k.food / k.cap)));
    if (!mine && k.owner === P && !fight) out.push(span('tip', 'Select ' + esc(k.name) + ' to sally out, or send it relief.'));
    return out.join(' ');
  }

  function briefArmy(a) {
    const to = game.keeps[a.path[a.path.length - 1]], mine = a.owner === P;
    const bread = a.men >= 1 ? a.food / a.men : 0;
    return ['<b>' + (mine ? 'Your column' : esc(game.factions[a.owner].name) + ' column') + '</b>', span('', num(a.men) + ' men'),
      a.battle ? briefFight(a.battle) : span('dim', a.rout ? 'routed, running for ' + esc(to.name) : 'marching on ' + esc(to.name)),
      a.hungry ? span(mine ? 'warn' : 'fine', 'out of bread, men dying') : span('', 'bread for ' + Math.max(1, Math.round(bread)) + (Math.round(bread) === 1 ? ' more second' : ' more seconds')),
      mine && !a.rout && !a.battle ? span('tip', tapWord() + ' a town to send them there instead.') : ''].join(' ');
  }

  function briefOf(h) {
    if (h.type === 'keep') return briefTown(game.keeps[h.id]);
    if (h.type === 'camp') { const c = campById(h.id); return c ? briefCamp(c) : ''; }
    const a = armyById(h.id);
    return a ? briefArmy(a) : '';
  }

  /** Several things selected: what they are, how many men, and how many of those will go. */
  function briefGroup() {
    let towns = 0, camps = 0, cols = 0, men = 0, go = 0;
    for (const key of sel) {
      const id = +key.slice(1);
      if (key[0] === 'k') { const k = game.keeps[id]; towns++; men += k.men; if (!k.camp) go += Math.floor(k.men * frac); }
      else if (key[0] === 'c') { const c = campById(id); if (c) { camps++; men += c.men; go += Math.floor(c.men * frac); } }
      else { const a = armyById(id); if (a) { cols++; men += a.men; go += Math.floor(a.men); } }
    }
    const parts = [];
    if (towns) parts.push(towns + (towns === 1 ? ' town' : ' towns'));
    if (camps) parts.push(camps + (camps === 1 ? ' camp' : ' camps'));
    if (cols) parts.push(cols + (cols === 1 ? ' column' : ' columns'));
    return ['<b>' + parts.join(', ') + ' selected</b>', span('', num(men) + ' men'), span('dim', num(go) + ' will march'),
      span('tip', adding ? tapWord() + ' more of yours to add them, then ' + tapWord().toLowerCase() + ' the target.'
        : touchy ? 'Tap a town to send them. Hold one of your own to gather there.' : 'Click a town to send them. Right-click one of your own to gather there.')].join(' ');
  }

  function briefRealm() {
    const f = game.factions[P];
    let grain = 0, n = 0, hungry = 0, angry = 0, fight = null;
    for (const k of game.keeps) if (k.owner === P) { grain += k.food / k.cap; n++; if (k.hungry) hungry++; if (k.unrest > 0.7) angry++; }
    for (const b of game.battles) if (!fight && (b.att.owner === P || b.def.owner === P)) fight = b;
    const w = tapWord();
    return ['<b>Your realm</b>', span('', num(f.people) + ' people'), span('', num(f.men) + ' under arms'),
      span(hungry ? 'warn' : '', n ? 'grain ' + pct(grain / n) : 'no granary'),
      angry ? span('warn', angry + (angry === 1 ? ' town' : ' towns') + ' near revolt') : '',
      fight ? briefFight(fight)
        : span('tip', paused ? 'Paused. Look around and read the land; resume to give orders.'
          : adding ? w + ' each town, camp or column of yours that should go, then ' + w.toLowerCase() + ' the target.'
            : w + ' one of your towns, then ' + w.toLowerCase() + ' where its men should march.')].join(' ');
  }

  function brief() {
    if (mode === 'title') return span('dim', 'A war between four houses, already a year old. One of them could be yours.');
    if (mode === 'over') return span('dim', 'The realm carries on without you.');
    const h = R.hover || inspect;
    if (h) { const s = briefOf(h); if (s) return s; }
    if (sel.size === 1) {
      const key = sel.values().next().value;
      const s = briefOf({ type: key[0] === 'k' ? 'keep' : key[0] === 'c' ? 'camp' : 'army', id: +key.slice(1) });
      if (s) return s;
    }
    return sel.size > 1 ? briefGroup() : briefRealm();
  }

  function hud(force) {
    const now = performance.now();
    if (!force && now - hudAt < 160) return;
    hudAt = now;
    const f = game.factions[P], st = game.stats;
    if (mode === 'play') prune();
    $('v-reign').textContent = years(st.reign);
    $('f-reign').classList.toggle('crowned', game.crown === P && !game.over);
    $('v-year').textContent = 'Year ' + (Math.floor(game.time / BC.YEAR) + 1);
    if ($('v-season').textContent !== BC.SEASONS[game.season] || force) {
      $('v-season').textContent = BC.SEASONS[game.season];
      $('v-season-ico').innerHTML = SEASON_ICON[game.season];
    }
    $('v-age').textContent = game.age;
    $('v-realm').textContent = f.keeps + (f.keeps === 1 ? ' town, ' : ' towns, ') + pct(game.share);
    const d = game.dread;
    $('v-dread').style.width = pct(d);
    $('m-dread').setAttribute('aria-valuenow', String(Math.round(d * 100)));
    $('v-dread-name').textContent = game.league === P ? 'United against you' : 'Dread: ' + (d < 0.2 ? 'unnoticed' : d < 0.45 ? 'watched' : d < 0.75 ? 'envied' : 'feared');

    // Share of the people under each banner, yours first.
    const live = game.factions.filter((x) => x.alive && x.keeps > 0).sort((a, b) => (a.id === P ? -1 : b.id === P ? 1 : b.people - a.people));
    let freePeople = 0;
    for (const k of game.keeps) if (k.owner < 0) freePeople += k.pop;
    const key = live.map((x) => x.id).join(',') + '|' + (freePeople > 0);
    const bar = $('power');
    if (key !== powerKey) {
      powerKey = key;
      bar.textContent = '';
      for (const x of live) { const i = document.createElement('i'); i.style.background = 'var(--f' + x.color + ')'; i.title = x.name; bar.appendChild(i); }
      if (freePeople > 0) { const i = document.createElement('i'); i.style.background = 'var(--free)'; i.title = 'Free towns'; bar.appendChild(i); }
    }
    live.forEach((x, i) => { bar.children[i].style.flexGrow = String(Math.max(1, Math.round(x.people))); bar.children[i].classList.toggle('crowned', game.crown === x.id); });
    if (freePeople > 0) bar.lastChild.style.flexGrow = String(Math.round(freePeople));

    // The red button. Its words only change when they have to, so it can be pressed while it updates.
    const a = mode === 'play' ? actionFor() : null, btn = $('b-act');
    let label = '';
    if (a && a.kind === 'storm') label = 'Storm <small>' + esc(game.stormOdds(a.camp).word) + '</small>';
    else if (a && a.kind === 'sally') label = 'Sally out <small>' + num(Math.floor(a.town.men * frac)) + ' men</small>';
    else if (a) {
      const b = a.battle, ours = b && b.att.owner === P;
      label = b && b.kind === 'storm' ? (ours ? 'Storming the walls' : 'The walls are stormed') : b && b.kind === 'sally' && ours ? 'Sallying out' : 'Fighting at the gates';
    }
    if (btn.hidden !== !a) btn.hidden = !a;
    if (a) {
      if (actNow !== label) { actNow = label; btn.innerHTML = label; }
      if (btn.disabled !== (a.kind === 'busy')) btn.disabled = a.kind === 'busy';
    }
    const text = brief();
    if (briefNow !== text) { briefNow = text; $('brief').innerHTML = text; }
    let mine = 0;
    for (const b of game.battles) if (b.att.owner === P || b.def.owner === P) mine++;
    BC.audio.scene({ playing: mode === 'play' && !paused, season: game.season, battles: game.battles.length, mine: mine, zoom: R.is3d ? clamp(1 - (R.cam.dist - 110) / Math.max(1, R.far - 110), 0, 1) : 0 });
  }

  /* ---------- the loop ---------- */

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!paused && !document.hidden) {
      game.update(dt);
      drain();
      if (mode === 'play' && game.over) finish();
      // The title screen's war restarts if it ends, or after a few minutes.
      if (mode === 'title' && (game.over || now - demoAt > 240000)) begin(true);
    }
    steer(dt);
    if (mode === 'title' && R.is3d && !R.calm) R.orbit(dt * 0.035, 0);       // the title screen circles the realm slowly
    R.draw(dt);
    teach(dt);
    hud(false);
    requestAnimationFrame(frame);
  }

  function boot() {
    const best = +recall('best') || 0, sound = recall('sound') !== '0';
    if (best) $('t-best').textContent = 'Your longest hold on the crown: ' + yearsLong(best) + '.';
    BC.audio.set(sound);
    $('b-sound').setAttribute('aria-pressed', String(sound));
    if (!sound) setSound(false);
    setMode('title');
    // The title card speaks of clicks to a mouse and taps to a finger.
    for (const el of document.querySelectorAll('[data-tap]')) el.textContent = touchy ? (el.dataset.tap ? 'tap' : 'Tap') : (el.dataset.tap ? 'click' : 'Click');
    R = (recall('view') || 'world') === 'map' || !solid ? flat : solid;
    glCanvas.hidden = R !== solid;
    R.resize();
    begin(true);
    setView(R === solid ? 'world' : 'map');
    const fit = () => { frameMap(); R.resize(); if (coach) coach.text = ''; };
    if (window.ResizeObserver) new ResizeObserver(fit).observe(stage);
    else window.addEventListener('resize', fit);
    // Follow the page theme: the system setting, or an explicit data-theme on the root.
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    const retheme = () => { flat.readTheme(); if (solid) solid.readTheme(); };
    if (mq && mq.addEventListener) mq.addEventListener('change', retheme);
    new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(retheme);
    requestAnimationFrame((t) => { last = t; frame(t); });
  }

  // Handy from the browser console, and for the smoke test: BC.live.game is the running simulation.
  // restart(seed) begins a fresh reign on a known map with the whole realm in view and no hints or
  // help card in the way, which makes screenshots repeatable.
  BC.live = {
    get game() { return game; }, get renderer() { return R; }, setView: setView,
    restart(seed) { setMode('play'); $('veil-title').hidden = true; $('veil-end').hidden = true; closeHelp(); begin(false, seed); },
    help: openHelp,
  };

  boot();
})();
