/*
 * Borrowed Crown: the page around the map.
 * Pointer and keyboard orders, the ledger and orders bars, the chronicle,
 * and the title and ending cards.
 */
(function () {
  'use strict';
  const BC = window.BC, P = BC.PLAYER;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const num = (n) => Math.round(n).toLocaleString('en-US');
  const pct = (v) => Math.round(v * 100) + '%';

  const stage = $('stage'), canvas = $('map');
  const R = new BC.Renderer(canvas);
  const sel = R.sel;

  let game = null;
  let mode = 'title';            // title | play | over
  let paused = false, frac = 0.5;
  let inspect = null;            // the last thing tapped that is not ours, so touch players can read it
  let ptr = null, lastTap = { key: '', t: 0 };
  let hudAt = 0, powerKey = '', bannerTimer = 0, demoAt = 0;

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

  /* ---------- small helpers ---------- */

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
  function campById(id) {
    for (const a of game.armies) if (a.id === id && a.state === 'camp' && a.men >= 1) return a;
    return null;
  }
  const keyOf = (hit) => (hit.type === 'keep' ? 'k' : 'c') + hit.id;
  function isMine(hit) {
    if (!hit) return false;
    if (hit.type === 'keep') return game.keeps[hit.id].owner === P;
    const c = campById(hit.id);
    return !!c && c.owner === P;
  }
  function townOf(hit) {
    if (hit.type === 'keep') return hit.id;
    const c = campById(hit.id);
    return c ? c.at : -1;
  }
  function owner(id) { return id < 0 ? 'a free town' : id === P ? 'yours' : game.factions[id].name; }

  /* ---------- starting and ending ---------- */

  /** Keep the bottom of the map clear of the chronicle, as far as the screen can afford. */
  function frameMap() {
    const w = stage.clientWidth, h = stage.clientHeight;
    R.pad.b = h < 300 ? 30 : w < 640 ? 80 : 58;
    R.pad.t = 6;
  }

  function begin(demo) {
    const r = stage.getBoundingClientRect();
    frameMap();
    game = new BC.Game({
      seed: (Math.random() * 0x7fffffff) | 0,
      keeps: clamp(Math.round(r.width * r.height / 26000), r.height < 300 ? 12 : 15, 22),
      aspect: Math.max(60, r.width - R.pad.l - R.pad.r) / Math.max(60, r.height - R.pad.t - R.pad.b),
      bot: demo,
    });
    if (demo) {
      // The title screen opens on a war already a year old.
      for (let i = 0; i < 1500 && !game.over; i++) game.update(0.05);
      game.events.length = 0; game.fx.length = 0;
      demoAt = performance.now();
    }
    R.setGame(game);
    R.quietMap = demo;
    sel.clear(); inspect = null; ptr = null; powerKey = '';
    $('chronicle').textContent = '';
    press('seg-levy', 'levy', 'standard');
    setPaused(false);
    hud(true);
  }

  function finish() {
    mode = 'over';
    sel.clear(); R.quietMap = true; R.aim = null; R.box = null; R.pull = null;
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

    let best = 0;
    try { best = +localStorage.getItem('borrowed-crown-best') || 0; } catch (e) { /* storage is optional */ }
    if (st.reign > best && st.reign > 0) {
      $('e-best').textContent = best ? 'Your longest hold on the crown yet.' : 'That is the time to beat.';
      try { localStorage.setItem('borrowed-crown-best', String(Math.round(st.reign))); } catch (e) { /* ignore */ }
    } else $('e-best').textContent = best ? 'Your longest hold: ' + yearsLong(best) + '.' : 'Next time, take the crown before they take you.';
    $('veil-end').hidden = false;
    BC.audio.play('fall');
    $('b-again').focus({ preventScroll: true });
  }

  function play() {
    BC.audio.boot();
    mode = 'play';
    $('veil-title').hidden = true; $('veil-end').hidden = true;
    begin(false);
    const seat = game.keeps[game.factions[P].seat];
    game.events.push({ type: 'say', text: 'You hold ' + seat.name + '. Your banner is the blue one.', tone: 'crown', k: seat.id });
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
    const lines = [];
    let men = 0, storming = null, sally = null, any = false;
    for (const key of keys) {
      const id = +key.slice(1);
      if (key[0] === 'k') {
        const k = game.keeps[id];
        if (k.owner !== P) continue;
        if (k.camp) { if (id === to) sally = k; continue; }
        if (id === to || k.men < 1) continue;
        const path = game.route(id, to, P);
        if (!path) continue;
        lines.push(path.map((i) => R.at(game.keeps[i].x, game.keeps[i].y)));
        men += Math.max(1, Math.floor(k.men * frac)); any = true;
      } else {
        const c = campById(id);
        if (!c || c.owner !== P) continue;
        if (c.at === to) { storming = c; continue; }
        const path = game.route(c.at, to, P);
        if (!path) continue;
        const pts = path.map((i) => R.at(game.keeps[i].x, game.keeps[i].y));
        pts[0] = R.campAt(c);
        lines.push(pts);
        men += Math.max(1, Math.floor(c.men * frac)); any = true;
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

  /** Carry out an order from every source in `keys` toward town `to`. */
  function command(to, keys) {
    if (to < 0) return;
    let done = 0, road = false;
    for (const key of Array.from(keys)) {
      const id = +key.slice(1);
      if (key[0] === 'k') {
        const k = game.keeps[id];
        if (k.owner !== P) continue;
        if (id === to && !k.camp) continue;
        if (!k.camp && game.route(id, to, P)) road = true;
        if (game.orderKeep(id, to, frac)) done++;
      } else {
        const c = campById(id);
        if (!c) continue;
        if (c.at === to || game.route(c.at, to, P)) road = true;
        if (game.orderCamp(id, to, frac)) done++;
      }
    }
    if (done) BC.audio.play('march');
    else {
      const T = game.keeps[to];
      R.floats.push({ x: T.x, y: T.y, text: road ? 'No men to send' : 'No road through your own lands', tone: 'bad', life: 1.8, max: 1.8 });
      BC.audio.play('deny');
    }
    prune();
  }

  function prune() {
    for (const key of Array.from(sel)) {
      const id = +key.slice(1);
      if (key[0] === 'k' ? game.keeps[id].owner !== P : !campById(id) || campById(id).owner !== P) sel.delete(key);
    }
    if (inspect && inspect.type === 'camp' && !campById(inspect.id)) inspect = null;
  }

  function selectAll() {
    sel.clear();
    for (const k of game.keeps) if (k.owner === P) sel.add('k' + k.id);
    for (const a of game.armies) if (a.owner === P && a.state === 'camp' && a.men >= 1) sel.add('c' + a.id);
  }

  /** The red button: storm with the selected camps, or sally from the selected besieged towns. */
  function actionFor() {
    let camp = null, town = null;
    for (const key of sel) {
      const id = +key.slice(1);
      if (key[0] === 'c') { if (!camp) camp = campById(id); } else if (game.keeps[id].camp && !town) town = game.keeps[id];
    }
    if (camp) return { kind: 'storm', camp: camp };
    if (town) return { kind: 'sally', town: town };
    return null;
  }

  function act() {
    const a = actionFor();
    if (!a) return;
    if (a.kind === 'storm') {
      for (const key of Array.from(sel)) if (key[0] === 'c') { const c = campById(+key.slice(1)); if (c) game.orderCamp(c.id, c.at, 1); }
    } else {
      for (const key of Array.from(sel)) if (key[0] === 'k') { const k = game.keeps[+key.slice(1)]; if (k.owner === P && k.camp) game.orderKeep(k.id, k.id, frac); }
    }
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

  canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'play' || paused || e.button === 2) return;
    BC.audio.boot();
    const p = point(e), hit = R.pick(p.x, p.y);
    ptr = { id: e.pointerId, x0: p.x, y0: p.y, hit: hit, mine: isMine(hit), moved: false, shift: e.shiftKey, done: false, timer: 0 };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
    // Press and hold on any town sends the selection there, the way a right click does.
    if (hit && sel.size) {
      ptr.timer = setTimeout(() => {
        if (!ptr || ptr.moved || ptr.done) return;
        ptr.done = true; R.aim = null;
        command(townOf(hit), sel);
      }, 520);
    }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (mode !== 'play') return;
    const p = point(e);
    if (!ptr) {
      if (e.pointerType !== 'mouse') return;
      const hit = R.pick(p.x, p.y);
      R.hover = hit;
      canvas.style.cursor = hit ? 'pointer' : 'default';
      R.aim = hit && sel.size && !isMine(hit) ? preview(sel, townOf(hit)) : null;
      return;
    }
    if (ptr.done || e.pointerId !== ptr.id) return;
    if (!ptr.moved && Math.hypot(p.x - ptr.x0, p.y - ptr.y0) > 9) { ptr.moved = true; clearTimeout(ptr.timer); }
    if (!ptr.moved) return;
    if (ptr.mine) {
      const over = R.pick(p.x, p.y);
      if (over && !same(over, ptr.hit)) { R.aim = preview(dragKeys(ptr.hit), townOf(over)); R.pull = null; }
      else R.aim = null;
      if (!R.aim) {
        const c = ptr.hit.type === 'camp' ? campById(ptr.hit.id) : null;
        const k = ptr.hit.type === 'keep' ? game.keeps[ptr.hit.id] : null;
        const from = k ? R.at(k.x, k.y) : c ? R.campAt(c) : null;
        R.pull = from ? { from: from, to: [p.x, p.y] } : null;
      }
    } else if (!ptr.hit) R.box = { x0: ptr.x0, y0: ptr.y0, x1: p.x, y1: p.y };
  });

  function release(e) {
    if (!ptr || e.pointerId !== ptr.id) return;
    clearTimeout(ptr.timer);
    const q = ptr, p = point(e);
    ptr = null; R.pull = null;
    const box = R.box; R.box = null;
    if (q.done || mode !== 'play') { R.aim = null; return; }
    if (q.mine) {
      if (q.moved) {
        const over = R.pick(p.x, p.y);
        if (over && !same(over, q.hit)) command(townOf(over), dragKeys(q.hit));
      } else {
        const key = keyOf(q.hit), now = performance.now();
        if (q.shift) { if (sel.has(key)) sel.delete(key); else sel.add(key); }
        else if (lastTap.key === key && now - lastTap.t < 340) selectAll();
        else { sel.clear(); sel.add(key); }
        lastTap = { key: key, t: now };
        inspect = null;
      }
    } else if (q.hit) {
      if (sel.size) command(townOf(q.hit), sel); else inspect = q.hit;
    } else if (q.moved && box) {
      if (!q.shift) sel.clear();
      const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1), y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
      const inside = (pt) => pt[0] >= x0 && pt[0] <= x1 && pt[1] >= y0 && pt[1] <= y1;
      for (const k of game.keeps) if (k.owner === P && inside(R.at(k.x, k.y))) sel.add('k' + k.id);
      for (const a of game.armies) if (a.owner === P && a.state === 'camp' && a.men >= 1 && inside(R.campAt(a))) sel.add('c' + a.id);
    } else { sel.clear(); inspect = null; }
    R.aim = null;
    hud(true);
  }
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', (e) => {
    if (!ptr || e.pointerId !== ptr.id) return;
    clearTimeout(ptr.timer); ptr = null; R.pull = null; R.box = null; R.aim = null;
  });
  canvas.addEventListener('pointerleave', () => { if (!ptr) { R.hover = null; R.aim = null; } });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (mode !== 'play' || paused) return;
    const p = point(e), hit = R.pick(p.x, p.y);
    if (hit && sel.size) { command(townOf(hit), sel); hud(true); }
  });

  /* ---------- buttons and keys ---------- */

  function press(groupId, attr, value) {
    for (const b of $(groupId).children) b.setAttribute('aria-pressed', String(b.dataset[attr] === String(value)));
  }
  function setFrac(v) { frac = v; press('seg-send', 'frac', v); }
  function setLevy(v) { game.setLevy(v); press('seg-levy', 'levy', v); hud(true); }
  function setPaused(v) {
    paused = v;
    $('halt').hidden = !v || mode !== 'play';
    $('ico-pause').setAttribute('d', v ? 'M4 2l10 6-10 6z' : 'M3 2h4v12H3zM9 2h4v12H9z');
    $('b-pause').setAttribute('aria-label', v ? 'Resume' : 'Pause');
  }
  function setSound(v) {
    BC.audio.set(v);
    $('b-sound').setAttribute('aria-pressed', String(v));
    $('b-sound').setAttribute('aria-label', v ? 'Sound on' : 'Sound off');
    $('ico-sound').setAttribute('d', v ? 'M2 6h3l4-3.5v11L5 10H2z M11 5.2a4 4 0 0 1 0 5.6l-1-1a2.6 2.6 0 0 0 0-3.6z' : 'M2 6h3l4-3.5v11L5 10H2z M10.6 6l3.4 4m0-4-3.4 4 .7.7L14.7 6.7z');
    try { localStorage.setItem('borrowed-crown-sound', v ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  $('seg-send').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setFrac(+b.dataset.frac); });
  $('seg-levy').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && mode === 'play') setLevy(b.dataset.levy); });
  $('b-act').addEventListener('click', act);
  $('b-pause').addEventListener('click', () => { if (mode === 'play') setPaused(!paused); });
  $('b-sound').addEventListener('click', () => { BC.audio.boot(); setSound(!BC.audio.on); });
  $('b-start').addEventListener('click', play);
  $('b-again').addEventListener('click', play);

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (mode !== 'play') { if (k === 'enter' && document.activeElement === document.body) play(); return; }
    if (k === '1') setFrac(0.25);
    else if (k === '2') setFrac(0.5);
    else if (k === '3') setFrac(1);
    else if (k === ' ' || k === 'p') { if (e.target.tagName !== 'BUTTON' || k === 'p') { e.preventDefault(); setPaused(!paused); } }
    else if (k === 'a') { selectAll(); hud(true); }
    else if (k === 'escape') { sel.clear(); inspect = null; R.aim = null; hud(true); }
    else if (k === 'm') setSound(!BC.audio.on);
    else if (k === 's') act();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && mode === 'play' && !game.over) setPaused(true); });

  /* ---------- the ledger and the briefing line ---------- */

  function span(cls, text) { return '<span' + (cls ? ' class="' + cls + '"' : '') + '>' + text + '</span>'; }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function briefTown(k) {
    const tier = BC.TIERS[k.tier].label, mine = k.owner === P;
    const out = ['<b>' + esc(k.name) + '</b>', span('dim', tier + ', ' + esc(owner(k.owner))), span('', num(k.pop) + ' people')];
    if (mine) {
      out.push(span('', num(k.men) + ' men ' + span('dim', '(can feed ' + num(game.feeds(k)) + ')')));
      out.push(k.hungry ? span('warn', 'no grain, men deserting') : span('', 'grain ' + pct(k.food / k.cap)));
      if (k.unrest >= 0.15) {
        const why = game.grievances(k).slice(0, 2).join(', ');
        out.push(span(k.unrest > 0.7 ? 'warn' : '', 'unrest ' + pct(Math.min(1, k.unrest)) + (why ? ': ' + why : '')));
      } else out.push(span('fine', 'quiet'));
      if (k.camp) out.push(span('warn', 'besieged by ' + num(k.camp.men)));
      else if (k.pool >= 20) out.push(span('dim', num(k.pool) + ' more answering the levy'));
    } else {
      const camp = k.camp && k.camp.owner === P ? k.camp : null;
      out.push(span('', num(k.men) + ' men behind walls ×' + game.wall(k, camp).toFixed(1)));
      out.push(k.hungry ? span('fine', 'starving') : span('', 'grain ' + pct(k.food / k.cap)));
      if (k.owner >= 0 && k.unrest > 0.6) out.push(span('', 'restless'));
    }
    return out.join(' ');
  }

  function briefCamp(c) {
    const k = game.keeps[c.at], o = game.stormOdds(c);
    return ['<b>Camp at ' + esc(k.name) + '</b>', span('', num(c.men) + ' men'),
      c.hungry ? span('warn', 'starving') : span('fine', 'fed'),
      span('', 'walls breached ' + pct(c.breach)),
      span(o.ratio >= 1.12 ? 'fine' : 'warn', 'storm: ' + o.word + ' (about ' + num(o.loss) + ' dead)'),
      span('dim', 'town has ' + num(k.men) + ' men, grain ' + pct(k.food / k.cap))].join(' ');
  }

  function brief() {
    if (mode === 'title') return span('dim', 'A war between four houses, already a year old. One of them could be yours.');
    if (mode === 'over') return span('dim', 'The realm carries on without you.');
    const h = R.hover || inspect;
    if (h) {
      if (h.type === 'camp') { const c = campById(h.id); if (c && c.owner === P) return briefCamp(c); if (c) return briefTown(game.keeps[c.at]); }
      else return briefTown(game.keeps[h.id]);
    }
    if (sel.size === 1) {
      const key = sel.values().next().value, id = +key.slice(1);
      if (key[0] === 'k') return briefTown(game.keeps[id]);
      const c = campById(id);
      if (c) return briefCamp(c);
    }
    const f = game.factions[P];
    let grain = 0, n = 0, hungry = 0, angry = 0;
    for (const k of game.keeps) if (k.owner === P) { grain += k.food / k.cap; n++; if (k.hungry) hungry++; if (k.unrest > 0.7) angry++; }
    if (sel.size > 1) {
      let men = 0;
      for (const key of sel) { const id = +key.slice(1); men += key[0] === 'k' ? game.keeps[id].men : (campById(id) || { men: 0 }).men; }
      return ['<b>' + sel.size + ' selected</b>', span('', num(men) + ' men'), span('dim', 'Tap a target to march. Hold on one of your own towns to gather there.')].join(' ');
    }
    return ['<b>Your realm</b>', span('', num(f.people) + ' people'), span('', num(f.men) + ' under arms'),
      span(hungry ? 'warn' : '', n ? 'grain ' + pct(grain / n) : 'no granary'),
      angry ? span('warn', angry + (angry === 1 ? ' town' : ' towns') + ' near revolt') : '',
      span('dim', 'Tap a town to select it, then tap where to march.')].join(' ');
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

    const a = mode === 'play' ? actionFor() : null, btn = $('b-act');
    btn.hidden = !a;
    if (a) {
      if (a.kind === 'storm') { const o = game.stormOdds(a.camp); btn.innerHTML = 'Storm <small>' + esc(o.word) + '</small>'; }
      else btn.innerHTML = 'Sally out';
    }
    $('brief').innerHTML = brief();
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
    R.draw(dt);
    hud(false);
    requestAnimationFrame(frame);
  }

  function boot() {
    let best = 0, sound = true;
    try { best = +localStorage.getItem('borrowed-crown-best') || 0; sound = localStorage.getItem('borrowed-crown-sound') !== '0'; } catch (e) { /* storage is optional */ }
    if (best) $('t-best').textContent = 'Your longest hold on the crown: ' + yearsLong(best) + '.';
    BC.audio.set(sound);
    $('b-sound').setAttribute('aria-pressed', String(sound));
    if (!sound) setSound(false);
    R.resize();
    begin(true);
    const fit = () => { frameMap(); R.resize(); };
    if (window.ResizeObserver) new ResizeObserver(fit).observe(stage);
    else window.addEventListener('resize', fit);
    // Follow the page theme: the system setting, or an explicit data-theme on the root.
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) mq.addEventListener('change', () => R.readTheme());
    new MutationObserver(() => R.readTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => R.readTheme());
    requestAnimationFrame((t) => { last = t; frame(t); });
  }

  // Handy from the browser console, and for the smoke test: BC.live.game is the running simulation.
  BC.live = { get game() { return game; }, renderer: R };

  boot();
})();
