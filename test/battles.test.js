// Battles take time, and columns on the road can be turned.
// A battle is decided the moment it starts but is fought out over a few seconds: the dead fall
// steadily, everyone in it is locked in state 'fight', columns coming up wait, and only at the
// end does the loser rout or the town fall. Each kind of battle is played here in a small
// hand-built situation, tick by tick, with the world's invariants audited after every tick.
const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('./harness.js');
const { auditor } = require('./invariants.js');

const STEP = 0.05, SPEED = 72;
const close = (got, want, what, eps = 1e-6) => assert.ok(Math.abs(got - want) <= eps, `${what}: ${got}, expected ${want}`);
const apart = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

/**
 * A world where nothing happens unless the test orders it: no rival gives orders and no levy
 * musters. Granaries and wagons are kept full, so nobody goes hungry and every man lost is a
 * man killed in battle. Pass { lean: true } to leave supply alone, { loud: true } for effects.
 */
function world(seed, opts = {}) {
  const g = new Game({ seed, quiet: !opts.loud });
  for (const f of g.factions) f.think = Infinity;
  for (const k of g.keeps) k.pool = -1e9;
  const audit = auditor(g);
  const step = () => {
    if (!opts.lean) {
      for (const k of g.keeps) k.food = k.cap;
      for (const a of g.armies) a.food = Math.max(a.food, a.men * 10);
    }
    g.update(STEP);
    const wrong = audit();
    if (wrong.length) assert.fail(`at ${g.time.toFixed(2)} s: ${wrong.join('; ')}`);
  };
  const until = (what, cond, seconds = 12) => {
    for (let i = 0; i < seconds / STEP && !cond(); i++) step();
    assert.ok(cond(), `${what} (waited ${seconds} s)`);
  };
  return { g, step, until };
}

/** A town and `n` of its neighbours, none of them anybody's seat, so every house keeps its home. */
function crossroads(g, n) {
  const seats = new Set(g.factions.map((f) => f.seat));
  for (const k of g.keeps) {
    const near = k.adj.filter((id) => !seats.has(id));
    if (!seats.has(k.id) && near.length >= n) return [k].concat(near.slice(0, n).map((id) => g.keeps[id]));
  }
  throw new Error('no crossroads like that on this map');
}

/** Put a town under a banner with a garrison of `men`, drawn from (or sent home to) its own people. */
function hold(g, k, owner, men) {
  assert.ok(men < k.pop + k.men - 1000, `${k.name} has not the people for ${men} men`);
  k.pop += k.men - men; k.men = men;
  k.owner = k.origin = owner; k.food = k.cap; k.unrest = 0;
  g.version++;
  return k;
}

/**
 * Play battle `b` to its end. On every tick each side's dead must be exactly on schedule
 * (its decided loss times the share of the battle fought), and what was decided at the start
 * (who wins, what it costs, how long it takes) must not move.
 */
function fightOut(w, b) {
  const sides = [b.att, b.def];
  const decided = JSON.stringify([b.win, b.dur, b.att.loss, b.def.loss, b.att.men0, b.def.men0]);
  let ticks = 0;
  while (w.g.battles.includes(b)) {
    const before = sides.map((s) => s.dead);
    assert.ok(b.t < b.dur, 'a battle still being fought has time left');
    w.step();
    assert.ok(++ticks < 200, 'the battle ends');
    sides.forEach((s, i) => {
      assert.ok(s.dead >= before[i], 'the dead stay dead');
      assert.ok(s.dead - before[i] <= s.loss * STEP / b.dur + 1e-6, `${s.dead - before[i]} fell in one tick of a ${b.dur} s battle costing ${s.loss}`);
      close(s.dead, s.loss * Math.min(1, b.t / b.dur), `dead after ${b.t.toFixed(2)} of ${b.dur.toFixed(2)} s`);
    });
  }
  assert.strictEqual(JSON.stringify([b.win, b.dur, b.att.loss, b.def.loss, b.att.men0, b.def.men0]), decided, 'the outcome was settled at the start');
  assert.ok(b.t >= b.dur && b.t < b.dur + STEP + 1e-9, `lasted ${b.t} s, set for ${b.dur}`);
  for (const s of sides) close(s.dead, s.loss, 'the dead add up to what was decided');
  return ticks * STEP;
}

/** Two neighbouring towns at war, a column from each, stepped until they meet. Ours leaves first, so it is the attacker. */
function duel(seed, ours, theirs) {
  const w = world(seed), g = w.g;
  const [home, foe] = crossroads(g, 1);
  hold(g, home, 0, 3000); hold(g, foe, 1, 3000);
  const col = g.dispatch(home, foe.id, ours), enemy = g.dispatch(foe, home.id, theirs);
  assert.ok(col && enemy, 'both columns set out');
  return { w, g, home, foe, col, enemy, meet: () => { w.until('the columns meet', () => g.battles.length > 0, 6); return g.battles[0]; } };
}

/** A town of ours with a rival camp outside it. `friend` is ours too, `den` is where the camp came from. */
function siege(seed, garrison, besiegers, opts) {
  const w = world(seed, opts), g = w.g;
  const [town, friend, den] = crossroads(g, 2);
  hold(g, town, 0, garrison); hold(g, friend, 0, 3000); hold(g, den, 1, 3000);
  const camp = g.dispatch(den, town.id, besiegers);
  w.until('the besiegers make camp', () => camp.state === 'camp');
  assert.strictEqual(town.camp, camp);
  assert.strictEqual(camp.at, town.id);
  close(apart(camp, town), 34, 'the camp sits 34 from the town');
  assert.ok(apart(camp, den) < apart(town, den), 'on the side it marched in from');
  return { w, g, town, friend, den, camp };
}

test('field: two columns meet on the road, fight it out where they stand, and the loser routs', () => {
  const { w, g, home, foe, col, enemy, meet } = duel(7, 900, 400);
  const b = meet();
  assert.strictEqual(b.kind, 'field');
  assert.strictEqual(b.at, -1);
  assert.strictEqual(b.att.army, col);
  assert.strictEqual(b.def.army, enemy);
  assert.strictEqual(b.att.keep, null);
  assert.strictEqual(home.battle, null, 'a field battle is at no town');
  assert.strictEqual(foe.battle, null);
  assert.ok(b.dur >= 2.6 && b.dur <= 6);
  assert.strictEqual(b.win, true, '900 against 400 in the open is no contest');
  close(b.att.men0, 900, 'attackers'); close(b.def.men0, 400, 'defenders');
  for (const a of [col, enemy]) {
    assert.strictEqual(a.state, 'fight');
    assert.strictEqual(a.was, 'march');
    assert.strictEqual(a.battle, b);
    assert.ok(apart(a, b) < 8, 'both sides are at the battle');
  }
  const stood = [col.x, col.y, enemy.x, enemy.y];
  assert.strictEqual(g.orderArmy(col.id, home.id), null, 'no order reaches a column that is fighting');

  fightOut(w, b);
  assert.deepStrictEqual([col.x, col.y, enemy.x, enemy.y], stood, 'nobody moved while it lasted');
  assert.ok(b.def.loss >= 0.34 * 400 - 1e-9 && b.att.loss > 0 && b.att.loss < b.def.loss, 'the loser breaks, the winner still bleeds');
  assert.strictEqual(col.state, 'march');
  assert.strictEqual(col.rout, false);
  assert.strictEqual(col.battle, null);
  close(col.men, 900 - b.att.loss, 'the winner is short exactly its dead');
  assert.strictEqual(enemy.state, 'march');
  assert.strictEqual(enemy.rout, true);
  assert.deepStrictEqual(enemy.path, [home.id, foe.id], 'the loser runs back the way it came');
  close(enemy.men, 400 - b.def.loss, 'the loser is short exactly its dead');

  const garrison = foe.men, left = enemy.men;
  w.until('the rout reaches home', () => !g.armies.includes(enemy));
  close(foe.men, garrison + left, 'the survivors are back inside');
  w.until('the winner lays siege', () => col.state === 'camp');
  assert.strictEqual(foe.camp, col);
});

test('field: columns coming up behind a battle wait on the road, sixteen short of it', () => {
  const { w, g, home, foe, col, meet } = duel(7, 900, 400);
  for (let i = 0; i < 10; i++) w.step();
  const ours = g.dispatch(home, foe.id, 200), theirs = g.dispatch(foe, home.id, 200);
  const b = meet();
  const waited = new Map([[ours, 0], [theirs, 0]]);
  while (g.battles.includes(b)) {
    const was = [ours, theirs].map((a) => [a.x, a.y]);
    w.step();
    if (!g.battles.includes(b)) break;
    [ours, theirs].forEach((a, i) => {
      assert.strictEqual(a.state, 'march', 'a waiting column is not in the fight');
      assert.ok(apart(a, b) >= 16 - 1e-6, `a column came within ${apart(a, b).toFixed(2)} of the fighting`);
      if (a.x === was[i][0] && a.y === was[i][1]) { waited.set(a, waited.get(a) + 1); close(apart(a, b), 16, 'it halts sixteen short'); }
    });
  }
  assert.ok(waited.get(ours) > 20 && waited.get(theirs) > 20, 'both columns stood and waited for most of it');
  const spot = [ours.x, ours.y];
  w.step(); w.step();
  assert.ok(ours.x !== spot[0] || ours.y !== spot[1], 'the road is open again once it is over');

  // The winner goes on to meet the second enemy column; ours stays behind it all the way.
  w.until('the winner meets the next column', () => g.battles.length > 0, 6);
  const next = g.battles[0];
  assert.deepStrictEqual([next.att.army, next.def.army], [col, theirs]);
  while (g.battles.includes(next)) {
    w.step();
    if (g.battles.includes(next)) assert.ok(apart(ours, next) >= 16 - 1e-6, 'still nobody marches through a battle');
  }
});

test('gate: a relief column fights the camp at the gates, breaks it and marches in', () => {
  const { w, g, town, friend, den, camp } = siege(11, 300, 800);
  const relief = g.dispatch(friend, town.id, 1500);
  w.until('the relief column reaches the gates', () => g.battles.length > 0);
  const b = g.battles[0];
  assert.strictEqual(b.kind, 'gate');
  assert.strictEqual(b.at, town.id);
  assert.strictEqual(town.battle, b);
  assert.deepStrictEqual([b.att.army, b.def.army], [relief, camp]);
  assert.deepStrictEqual([b.x, b.y], [camp.x, camp.y], 'fought at the camp');
  assert.deepStrictEqual([relief.state, relief.was, camp.state, camp.was], ['fight', 'march', 'fight', 'camp']);
  assert.strictEqual(town.camp, camp, 'the town is still invested while they fight');
  assert.strictEqual(b.win, true);
  assert.strictEqual(g.dispatch(town, friend.id, 50), null, 'nobody leaves a town with a battle at its gates');

  // A second column sent now gets there while the fight is on, and has to wait outside.
  const second = g.dispatch(friend, town.id, 100);
  const inside = town.men;
  let waited = 0;
  const reliefMen = relief.men + b.att.dead;
  while (g.battles.includes(b)) {
    w.step();
    if (!g.battles.includes(b)) break;
    assert.ok(g.armies.includes(second) && second.state === 'march' && second.d < second.len, 'the second column is still outside');
    close(town.men, inside, 'nobody got in during the fight');
    if (second.d > second.len - 1) waited++;
  }
  assert.ok(waited > 10, `the second column stood at the gates for ${waited} ticks`);
  close(b.att.dead, b.att.loss, 'relief dead'); close(b.def.dead, b.def.loss, 'camp dead');

  assert.strictEqual(town.battle, null);
  assert.strictEqual(town.camp, null, 'the siege is broken');
  assert.strictEqual(town.owner, 0);
  assert.ok(!g.armies.includes(relief) || relief.men === 0, 'the relief column is inside');
  close(town.men, inside + reliefMen - b.att.loss, 'garrison plus the relief survivors');
  assert.deepStrictEqual([camp.state, camp.rout, camp.at], ['march', true, -1]);
  assert.deepStrictEqual(camp.path, [town.id, den.id], 'the besiegers run for home');
  w.step(); w.step();
  assert.ok(!g.armies.includes(second), 'and the second column walks in behind them');
  close(town.men, inside + reliefMen - b.att.loss + 100, 'garrison, relief and the second column');
});

test('gate: a relief column that is too weak is thrown back, and the siege goes on', () => {
  const { w, g, town, friend, camp } = siege(11, 300, 800);
  const relief = g.dispatch(friend, town.id, 400);
  w.until('the relief column reaches the gates', () => g.battles.length > 0);
  const b = g.battles[0];
  assert.strictEqual(b.kind, 'gate');
  assert.strictEqual(b.win, false);
  const breach = camp.breach;
  fightOut(w, b);
  assert.strictEqual(camp.breach, breach, 'no siege work gets done while the camp is fighting');
  assert.deepStrictEqual([relief.state, relief.rout], ['march', true]);
  assert.deepStrictEqual(relief.path, [town.id, friend.id]);
  close(relief.men, 400 - b.att.loss, 'what is left of the relief');
  assert.deepStrictEqual([camp.state, town.camp, town.battle, town.owner], ['camp', camp, null, 0]);
  w.step();
  assert.ok(camp.breach > breach, 'and the siege work starts again');
});

test('camp: a second besieger fights the camp already there, and takes its place', () => {
  const w = world(11), g = w.g;
  const [town, ours, theirs] = crossroads(g, 2);
  hold(g, town, 2, 500); hold(g, ours, 0, 3000); hold(g, theirs, 1, 3000);
  const first = g.dispatch(theirs, town.id, 700);
  w.until('the first besiegers make camp', () => first.state === 'camp');
  const mine = g.dispatch(ours, town.id, 1600);
  w.until('the second besiegers arrive', () => g.battles.length > 0);
  const b = g.battles[0];
  assert.strictEqual(b.kind, 'camp');
  assert.strictEqual(b.at, town.id);
  assert.strictEqual(town.battle, b);
  assert.deepStrictEqual([b.att.army, b.def.army], [mine, first]);
  assert.deepStrictEqual([mine.state, mine.was, first.state, first.was], ['fight', 'march', 'fight', 'camp']);
  assert.strictEqual(b.win, true);
  const garrison = town.men;
  fightOut(w, b);
  assert.strictEqual(town.owner, 2, 'the town itself has not fallen');
  close(town.men, garrison, 'and its garrison took no part');
  assert.deepStrictEqual([mine.state, mine.at, town.camp, town.battle], ['camp', town.id, mine, null]);
  close(mine.men, 1600 - b.att.loss, 'the new camp');
  close(apart(mine, town), 34, 'camped 34 from the town');
  assert.deepStrictEqual([first.state, first.rout], ['march', true]);
  assert.deepStrictEqual(first.path, [town.id, theirs.id]);
});

test('camp: a second besieger that loses is driven off and the first camp stays', () => {
  const w = world(11), g = w.g;
  const [town, ours, theirs] = crossroads(g, 2);
  hold(g, town, 2, 500); hold(g, ours, 0, 3000); hold(g, theirs, 1, 3000);
  const first = g.dispatch(theirs, town.id, 700);
  w.until('the first besiegers make camp', () => first.state === 'camp');
  const mine = g.dispatch(ours, town.id, 300);
  w.until('the second besiegers arrive', () => g.battles.length > 0);
  const b = g.battles[0];
  assert.deepStrictEqual([b.kind, b.win], ['camp', false]);
  fightOut(w, b);
  assert.deepStrictEqual([mine.state, mine.rout], ['march', true]);
  assert.deepStrictEqual(mine.path, [town.id, ours.id]);
  assert.deepStrictEqual([first.state, town.camp, town.battle, town.owner], ['camp', first, null, 2]);
});

test('sally: the garrison comes out, its dead come off the walls, and the camp breaks', () => {
  const { w, g, town, friend, den, camp } = siege(11, 1200, 500);
  assert.deepStrictEqual(g.orderKeep(town.id, den.id, 1), { sally: true });
  const b = g.battles[0];
  assert.strictEqual(b.kind, 'sally');
  assert.strictEqual(b.at, town.id);
  assert.strictEqual(town.battle, b);
  assert.deepStrictEqual([b.att.keep, b.att.army, b.def.army, b.def.keep], [town, null, camp, null]);
  assert.deepStrictEqual([b.x, b.y], [camp.x, camp.y]);
  assert.deepStrictEqual([camp.state, camp.was], ['fight', 'camp']);
  close(b.att.men0, 1200, 'the whole garrison went out');
  assert.strictEqual(b.win, true);
  assert.strictEqual(g.orderKeep(town.id, den.id, 1), null, 'one sally at a time');
  assert.strictEqual(g.dispatch(town, friend.id, 100), null, 'and nobody marches off in the middle of it');
  assert.strictEqual(g.storm(camp), false, 'a camp under attack cannot storm');
  const inside = town.men, outside = camp.men;
  fightOut(w, b);
  close(town.men, inside - b.att.loss, 'the garrison is short exactly its dead');
  close(camp.men, outside - b.def.loss, 'the camp is short exactly its dead');
  assert.deepStrictEqual([town.camp, town.battle, town.owner], [null, null, 0]);
  assert.deepStrictEqual([camp.state, camp.rout], ['march', true]);
  assert.deepStrictEqual(camp.path, [town.id, den.id]);
});

test('sally: only the share ordered goes out, and a sally that fails costs the town', () => {
  const { w, g, town, den, camp } = siege(11, 600, 1200);
  assert.deepStrictEqual(g.orderKeep(town.id, den.id, 0.5), { sally: true });
  const b = g.battles[0];
  close(b.att.men0, 300, 'half the garrison');
  assert.strictEqual(b.win, false);
  const inside = town.men;
  fightOut(w, b);
  close(town.men, inside - b.att.loss, 'the garrison is short exactly its dead');
  assert.ok(b.att.loss <= 300 + 1e-9, 'and never more than went out');
  assert.deepStrictEqual([camp.state, camp.rout, town.camp, town.battle], ['camp', false, camp, null]);
  assert.strictEqual(town.owner, 0, 'the town holds for now');
});

test('storm: the camp goes over the walls, a column arriving waits outside, and the town falls at the end', () => {
  const w = world(11, { loud: true }), g = w.g;
  const [town, base] = crossroads(g, 1);
  hold(g, town, 1, 200); hold(g, base, 0, 3000);
  const camp = g.dispatch(base, town.id, Math.round(2 * 200 * g.wall(town, null)));     // twice what the walls are worth
  w.until('our men make camp', () => camp.state === 'camp');
  assert.strictEqual(town.owner, 1, 'not enough to frighten it into opening the gates');
  g.fx.length = 0;
  assert.deepStrictEqual(g.orderCamp(camp.id, town.id, 1), { storm: true });
  const b = g.battles[0];
  assert.strictEqual(b.kind, 'storm');
  assert.strictEqual(b.at, town.id);
  assert.strictEqual(town.battle, b);
  assert.deepStrictEqual([b.att.army, b.att.keep, b.def.army, b.def.keep], [camp, null, null, town]);
  close(b.x, (camp.x + town.x) / 2, 'between camp and town'); close(b.y, (camp.y + town.y) / 2, 'between camp and town');
  assert.deepStrictEqual([camp.state, camp.was, town.camp], ['fight', 'camp', camp]);
  assert.strictEqual(b.win, true);
  assert.deepStrictEqual(g.fx.map((e) => e.type), ['battle']);
  assert.deepStrictEqual(g.fx[0], { type: 'battle', id: b.id, kind: 'storm', x: b.x, y: b.y, a: 0, b: 1, dur: b.dur });
  assert.strictEqual(g.orderCamp(camp.id, town.id, 1), null, 'it is already storming');
  assert.strictEqual(g.orderCamp(camp.id, base.id, 0.5), null, 'and nobody is pulled out of an assault');

  const late = g.dispatch(base, town.id, 200);
  const stormers = camp.men, defenders = town.men, people = town.pop;
  let waited = 0;
  while (g.battles.includes(b)) {
    w.step();
    if (!g.battles.includes(b)) break;
    assert.strictEqual(town.owner, 1, 'the town does not fall before the fight is over');
    assert.ok(g.armies.includes(late) && late.state === 'march' && late.d < late.len, 'the late column is still outside');
    if (late.d > late.len - 1) waited++;
  }
  assert.ok(waited > 10, `the late column stood at the gates for ${waited} ticks`);
  close(b.att.dead, b.att.loss, 'stormers dead'); close(b.def.dead, b.def.loss, 'defenders dead');

  assert.deepStrictEqual([town.owner, town.camp, town.battle], [0, null, null]);
  assert.ok(town.sacked > 0, 'a storm ends in a sack');
  close(town.men, stormers - b.att.loss, 'the survivors are the new garrison');
  close(town.pop, (people + defenders - b.def.loss) * 0.95, 'the old garrison went home and one in twenty died in the sack', 10);
  assert.ok(!g.armies.includes(camp), 'the camp is gone');
  const types = g.fx.map((e) => e.type);
  assert.deepStrictEqual(g.fx.find((e) => e.type === 'battleEnd'), { type: 'battleEnd', id: b.id, x: b.x, y: b.y, a: 0, b: 1, won: true });
  assert.deepStrictEqual(g.fx.find((e) => e.type === 'take'), { type: 'take', k: town.id, owner: 0, prev: 1, how: 'storm' });
  assert.ok(types.indexOf('battleEnd') < types.indexOf('take'), 'the battle ends, then the town changes hands');
  w.step(); w.step();
  assert.ok(!g.armies.includes(late), 'and the late column marches in');
  close(town.men, stormers - b.att.loss + 200, 'survivors plus the late column');
});

test('storm: a failed assault leaves the town standing and the walls a little lower', () => {
  const w = world(11), g = w.g;
  const [town, base] = crossroads(g, 1);
  hold(g, town, 1, 200); hold(g, base, 0, 3000);
  const camp = g.dispatch(base, town.id, Math.round(0.6 * 200 * g.wall(town, null)));
  w.until('our men make camp', () => camp.state === 'camp');
  assert.strictEqual(g.storm(camp), true);
  const b = g.battles[0];
  assert.deepStrictEqual([b.kind, b.win], ['storm', false]);
  const breach = camp.breach, stormers = camp.men, defenders = town.men;
  fightOut(w, b);
  assert.deepStrictEqual([town.owner, town.camp, town.battle, camp.state], [1, camp, null, 'camp']);
  close(camp.breach, breach + 0.15, 'the assault opened the breach a little');
  close(camp.men, stormers - b.att.loss, 'the camp is short exactly its dead');
  close(town.men, defenders - b.def.loss, 'the garrison is short exactly its dead');
  assert.ok(b.att.loss > b.def.loss, 'and it cost the stormers far more');
});

test('field: a column that comes up level with a battle is held too, and fights the survivor next', () => {
  const w = world(7), g = w.g;
  const [home, foe] = crossroads(g, 1);
  hold(g, home, 0, 3000); hold(g, foe, 1, 3000);
  const col = g.dispatch(home, foe.id, 900);
  const first = g.dispatch(foe, home.id, 400), level = g.dispatch(foe, home.id, 400);      // two columns, side by side
  w.until('the columns meet', () => g.battles.length > 0, 6);
  const b = g.battles[0];
  assert.deepStrictEqual([b.att.army, b.def.army], [col, first]);
  const spot = [level.x, level.y];
  while (g.battles.includes(b)) {
    w.step();
    if (!g.battles.includes(b)) break;
    assert.strictEqual(g.battles.length, 1, 'one battle at a time on this stretch of road');
    assert.deepStrictEqual([level.state, level.x, level.y], ['march', spot[0], spot[1]], 'the second column does not march through the fighting');
  }
  w.until('the survivor and the second column fight', () => g.battles.length > 0, 0.25);
  const next = g.battles[0];
  assert.deepStrictEqual([next.att.army, next.def.army], [col, level]);
  assert.ok(apart(col, level) < 24, `they fight where they stand, not ${apart(col, level).toFixed(1)} apart`);
  fightOut(w, next);
});

test('field: a column that turns round does not fight an enemy it is marching away from', () => {
  const { w, g, town, den, camp } = siege(11, 1200, 500);
  assert.deepStrictEqual(g.orderKeep(town.id, den.id, 1), { sally: true });
  fightOut(w, g.battles[0]);
  assert.deepStrictEqual([camp.state, camp.rout], ['march', true]);
  for (let i = 0; i < 8; i++) w.step();
  const chase = g.dispatch(town, den.id, 200);                // after them, half a minute behind
  for (let i = 0; i < 5; i++) w.step();
  assert.ok(g.armies.includes(camp) && camp.d - chase.d > 25, 'the broken camp is well ahead of the pursuit');
  const garrison = town.men;
  assert.strictEqual(g.orderArmy(chase.id, town.id), chase, 'the pursuit is called off');
  for (let i = 0; i < 4; i++) {
    w.step();
    assert.strictEqual(g.battles.length, 0, 'no battle between columns marching apart');
    assert.strictEqual(chase.state, 'march');
  }
  w.until('the pursuit is home', () => !g.armies.includes(chase));
  close(town.men, garrison + 200, 'all of them');
});

test('supply: a camp that is fed where it sits does not starve because it is fighting', () => {
  const { w, g, town, den, camp } = siege(11, 100, 250, { lean: true });
  camp.food = 0;                                              // it has eaten what it carried and lives off the land and the road home
  for (let i = 0; i < 10; i++) w.step();
  assert.strictEqual(camp.hungry, false, 'forage and the wagons from the next town feed 250 men');
  close(camp.men, 250, 'nobody has died');
  assert.deepStrictEqual(g.orderKeep(town.id, den.id, 1), { sally: true });
  const b = g.battles[0];
  assert.strictEqual(b.win, false);
  while (g.battles.includes(b)) {
    w.step();
    assert.strictEqual(camp.hungry, false, 'the camp still eats while it fights at its own lines');
  }
  close(camp.men, 250 - b.def.loss, 'the camp is short its battle dead and nobody else');
});

/* ----- new orders for a column already on the road ----- */

/** Road distance from every town to every other, going only through towns `me` holds (ends may be anyone's). */
function distances(g, me) {
  const n = g.keeps.length, D = Array.from({ length: n }, () => new Array(n).fill(Infinity));
  for (let i = 0; i < n; i++) D[i][i] = 0;
  for (const r of g.roads) D[r.a][r.b] = D[r.b][r.a] = r.len;
  for (let k = 0; k < n; k++) {
    if (g.keeps[k].owner !== me) continue;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (D[i][k] + D[k][j] < D[i][j]) D[i][j] = D[i][k] + D[k][j];
  }
  return D;
}

test('redirect: a column carries on through the town ahead when that is the way', () => {
  const w = world(7), g = w.g;
  const [mid, home, far] = crossroads(g, 2);
  hold(g, home, 0, 1000); hold(g, mid, 0, 100); hold(g, far, 0, 100);
  const col = g.dispatch(home, mid.id, 300);
  w.until('it is most of the way there', () => col.d > col.len * 0.6);
  const d = col.d, left = col.len - col.d + g.len(mid.id, far.id), t0 = g.time;
  assert.strictEqual(g.orderArmy(col.id, far.id), col);
  assert.deepStrictEqual(col.path, [home.id, mid.id, far.id]);
  assert.strictEqual(col.d, d, 'it does not jump');
  w.until('it arrives', () => !g.armies.includes(col));
  close(far.men, 400, 'all 300 marched in at the new destination');
  close(mid.men, 100, 'and none stopped on the way');
  close(g.time - t0, left / SPEED, 'it took as long as the road is', 2 * STEP);
});

test('redirect: a column turns round on the road when that is shorter', () => {
  const w = world(7), g = w.g;
  const [mid, home] = crossroads(g, 2);
  hold(g, home, 0, 1000); hold(g, mid, 0, 100);
  const col = g.dispatch(home, mid.id, 300);
  w.until('it is a little way out', () => col.d > col.len * 0.3);
  const d = col.d, spot = [col.x, col.y], t0 = g.time;
  assert.deepStrictEqual(g.redirectPlan(col, home.id), { path: [mid.id, home.id], back: true });
  assert.deepStrictEqual([col.path, col.d], [[home.id, mid.id], d], 'looking at a plan moves nobody');
  assert.strictEqual(g.orderArmy(col.id, home.id), col);
  assert.deepStrictEqual(col.path, [mid.id, home.id]);
  close(col.d, col.len - d, 'the same spot, measured from the other end');
  w.step();
  close(apart(col, { x: spot[0], y: spot[1] }), SPEED * STEP, 'one tick back down the road from where it stood');
  assert.ok(apart(col, home) < apart({ x: spot[0], y: spot[1] }, home), 'heading home');
  w.until('it is home', () => !g.armies.includes(col));
  close(home.men, 1000, 'everyone is back');
  close(g.time - t0, d / SPEED, 'it took as long as the way back is', 2 * STEP);
});

test('redirect: always the shorter of carrying on or turning round, and never through a town that is not ours', () => {
  let plans = 0, refused = 0, turned = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const w = world(seed), g = w.g, n = g.keeps.length;
    for (let round = 0; round < 60; round++) {
      // Who holds what changes every round; the column is somewhere along a random road.
      for (const k of g.keeps) k.owner = g.rng() < 0.55 ? 0 : 1;
      const road = g.roads[Math.floor(g.rng() * g.roads.length)], flip = g.rng() < 0.5;
      const from = flip ? road.b : road.a, next = flip ? road.a : road.b, to = Math.floor(g.rng() * n);
      const d = road.len * (0.02 + 0.96 * g.rng());
      const a = { id: 1, owner: 0, men: 100, state: 'march', path: [from, next], i: 0, d: d, len: road.len, rout: false };
      const D = distances(g, 0), mine = (id) => g.keeps[id].owner === 0;
      const via = (node) => (node === to ? 0 : mine(node) ? D[node][to] : Infinity);
      const fwd = road.len - d + via(next), back = d + via(from);

      const plan = g.redirectPlan(a, to);
      assert.deepStrictEqual([a.path, a.d, a.i], [[from, next], d, 0], 'a plan moves nobody');
      if (fwd === Infinity && back === Infinity) {
        assert.strictEqual(plan, null, `seed ${seed}: there is no road from ${from}-${next} to ${to}`);
        assert.strictEqual(g.redirect(a, to), false);
        assert.deepStrictEqual([a.path, a.d], [[from, next], d], 'a refused order changes nothing');
        refused++;
        continue;
      }
      assert.ok(plan, `seed ${seed}: there is a road from ${from}-${next} to ${to}`);
      const p = plan.path;
      assert.deepStrictEqual(p.slice(0, 2), plan.back ? [next, from] : [from, next], 'it starts on the road it is on');
      assert.strictEqual(p[p.length - 1], to);
      let length = plan.back ? d : road.len - d;
      for (let i = 1; i + 1 < p.length; i++) {
        assert.ok(g.len(p[i], p[i + 1]) > 0, 'every step is a road');
        assert.ok(mine(p[i]), `seed ${seed}: the way from ${from}-${next} to ${to} goes through ${p[i]}, which is not ours`);
        length += g.len(p[i], p[i + 1]);
      }
      close(length, Math.min(fwd, back), `seed ${seed}: the way from ${from}-${next} to ${to}`, 1e-3);
      assert.strictEqual(plan.back, back < fwd, 'it turns round only when that is shorter');
      assert.strictEqual(g.redirect(a, to), true);
      assert.deepStrictEqual([a.path, a.i, a.len], [p, 0, road.len]);
      close(a.d, plan.back ? road.len - d : d, 'its place on the road');
      plans++; if (plan.back) turned++;
    }
  }
  assert.ok(plans > 150 && refused > 30 && turned > 40, `${plans} plans, ${turned} turned round, ${refused} refused`);
});

test('redirect: refused when no road leads there through our own towns', () => {
  const w = world(7), g = w.g;
  const [foe, home] = crossroads(g, 1);
  hold(g, home, 0, 1000); hold(g, foe, 1, 3000);
  for (const k of g.keeps) if (k.owner === 0 && k !== home) hold(g, k, -1, k.men);        // home is all we hold
  const col = g.dispatch(home, foe.id, 300);
  w.until('it is on its way', () => col.d > col.len * 0.4);
  const beyond = g.keeps.find((k) => k !== home && k !== foe && !home.adj.includes(k.id));
  const before = JSON.stringify([col.path, col.i, col.d]);
  assert.strictEqual(g.redirectPlan(col, beyond.id), null);
  assert.strictEqual(g.orderArmy(col.id, beyond.id), null, 'the only roads there run through towns we do not hold');
  assert.strictEqual(g.orderArmy(col.id, 99), null, 'and there is no such town');
  assert.strictEqual(JSON.stringify([col.path, col.i, col.d]), before, 'a refused order changes nothing');
  w.until('it carries on to where it was going', () => col.state === 'camp');
  assert.strictEqual(foe.camp, col);
});

test('redirect: no orders for columns that are fighting, routed, camped or not ours', () => {
  const { w, g, home, foe, col, enemy, meet } = duel(7, 300, 900);
  assert.strictEqual(g.orderArmy(enemy.id, foe.id), null, 'the enemy does not take our orders');
  const b = meet();
  assert.strictEqual(b.win, false);
  const before = JSON.stringify([col.path, col.i, col.d]);
  assert.strictEqual(g.orderArmy(col.id, home.id), null, 'a column in a fight cannot be called off');
  assert.strictEqual(JSON.stringify([col.path, col.i, col.d]), before);
  fightOut(w, b);
  assert.strictEqual(col.rout, true);
  const running = JSON.stringify([col.path, col.i, col.d]);
  assert.strictEqual(g.orderArmy(col.id, foe.id), null, 'broken men do not turn back');
  assert.strictEqual(JSON.stringify([col.path, col.i, col.d]), running);
  w.until('the enemy lays siege', () => enemy.state === 'camp');
  assert.strictEqual(g.orderArmy(enemy.id, foe.id), null);

  const s = siege(11, 1200, 500);
  s.g.keeps[s.camp.at].owner = 1; s.camp.owner = 0;         // make the camp ours for a moment, to try the order on it
  assert.strictEqual(s.g.orderArmy(s.camp.id, s.friend.id), null, 'a camp is moved with orderCamp, not orderArmy');
});
