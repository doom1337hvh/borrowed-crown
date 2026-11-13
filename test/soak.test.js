// Many reigns, watched closely.
// The rival AI plays every seat, and every few ticks the whole world is audited (see
// invariants.js): nobody is locked in a fight that is over, no battle has lost its army or
// outlived its time, towns only point at battles and camps that are really there, armies that
// fight are at the fight, nothing is negative or NaN, the head count matches the books, and
// no column stands on a road without a reason.
const test = require('node:test');
const assert = require('node:assert');
const { Game, YEAR } = require('./harness.js');
const { auditor, KINDS } = require('./invariants.js');

const STEP = 0.05, EVERY = 3;

/** Play one reign to its end, auditing as it goes. `meddle(game, tick)` may give orders before each tick. */
function watch(seed, tally, meddle) {
  const game = new Game({ seed, quiet: true, bot: true });
  const audit = auditor(game);
  let ticks = 0, last = 0;
  while (!game.over && game.time < 45 * YEAR) {
    if (meddle) meddle(game, ticks);
    game.update(STEP);
    for (const b of game.battles) if (b.id > last) tally[b.kind] = (tally[b.kind] || 0) + 1;
    last = game.battleSeq;
    if (++ticks % EVERY === 0) {
      const wrong = audit();
      if (wrong.length) assert.fail(`seed ${seed}, year ${(game.time / YEAR).toFixed(2)}: ${wrong.slice(0, 5).join('; ')}`);
    }
  }
  assert.ok(game.over, `seed ${seed} was still reigning after ${(game.time / YEAR).toFixed(1)} years`);
  return game;
}

test('forty AI reigns, audited every few ticks, never leave the world in a state it cannot be in', () => {
  const tally = {};
  for (let seed = 1; seed <= 40; seed++) watch(seed, tally);
  for (const kind of KINDS) assert.ok(tally[kind] >= 40, `only ${tally[kind] || 0} ${kind} battles in forty reigns`);
});

test('nor does a player who keeps changing his mind: columns turned about, sallies, storms and camps split at random', () => {
  const tally = {}, did = { turned: 0, refused: 0, sally: 0, storm: 0, split: 0 };
  for (let seed = 101; seed <= 124; seed++) {
    let s = seed * 7919;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    watch(seed, tally, (game, tick) => {
      if (tick % 7) return;
      const mine = game.armies.filter((a) => a.owner === 0);
      if (mine.length) {
        const a = mine[Math.floor(rnd() * mine.length)], to = Math.floor(rnd() * game.n);
        if (a.state === 'camp') {
          if (rnd() < 0.3) { if (game.orderCamp(a.id, a.at, 1)) did.storm++; }
          else if (rnd() < 0.3 && game.orderCamp(a.id, to, 0.2 + 0.8 * rnd())) did.split++;
        } else if (game.orderArmy(a.id, to)) {
          did.turned++;
          // A new order never sends a column through a town that is not its owner's.
          for (let i = 1; i + 1 < a.path.length; i++) {
            assert.strictEqual(game.keeps[a.path[i]].owner, 0, `seed ${seed}: column ${a.id} was routed through town ${a.path[i]}, which is not ours`);
          }
          assert.strictEqual(a.path[a.path.length - 1], to);
        } else did.refused++;
      }
      const sieged = game.keeps.filter((k) => k.owner === 0 && k.camp);
      if (sieged.length && rnd() < 0.2 && game.orderKeep(sieged[0].id, 0, 0.3 + 0.7 * rnd())) did.sally++;
    });
  }
  assert.ok(did.turned > 500 && did.refused > 500 && did.sally > 20 && did.storm > 20 && did.split > 5, `orders given: ${JSON.stringify(did)}`);
  for (const kind of KINDS) assert.ok(tally[kind] >= 10, `only ${tally[kind] || 0} ${kind} battles`);
});

test('the audit is awake: each kind of fault, planted by hand, is caught', () => {
  // Play seed 3 until `ready` finds something to break, break it, and say what the audit made of it.
  const plant = (ready, fault, ticksAfter = 0) => {
    const game = new Game({ seed: 3, quiet: true, bot: true });
    const audit = auditor(game);
    let found = null;
    for (let i = 0; i < 20000 && !(found = ready(game)); i++) {
      game.update(STEP);
      assert.deepStrictEqual(audit(), [], 'the world is sound before anything is planted');
    }
    assert.ok(found, 'the reign offered something to break');
    fault(game, found);
    let said = audit().join('; ');
    for (let i = 0; i < ticksAfter && !said; i++) { game.update(STEP); fault(game, found); said = audit().join('; '); }
    return said;
  };
  const column = (g) => g.armies.find((a) => a.state === 'march' && !a.rout && a.d < a.len / 2);
  const field = (g) => g.battles.find((b) => b.kind === 'field');
  const anyBattle = (g) => g.battles[0];

  assert.match(plant(column, (g, a) => { a.state = 'fight'; }), /in state 'fight' with no live battle that lists it/);
  assert.match(plant(field, (g, b) => { g.armies = g.armies.filter((a) => a !== b.def.army); }), /army \d+ has gone/);
  assert.match(plant(field, (g, b) => { g.battles = []; }), /no live battle that lists it/);
  assert.match(plant(anyBattle, (g, b) => { b.t = b.dur + 0.05; }), /has outlived its duration/);
  assert.match(plant(column, (g) => { g.keeps[0].battle = { id: 999, at: 0 }; }), /points at battle 999, which is over or elsewhere/);
  assert.match(plant(column, (g, a) => { g.keeps[a.path[a.i + 1]].camp = a; }), /which is not camped there/);
  assert.match(plant(column, (g, a) => { a.food = NaN; }), /food is NaN/);
  assert.match(plant(column, (g) => { g.keeps[0].unrest = NaN; }), /unrest is NaN/);
  assert.match(plant(column, (g) => { g.keeps[0].food = -5; }), /has -5 food/);
  assert.match(plant(column, (g, a) => { a.men += 10; }), /the ledger is out by 10/);
  const d = {};
  assert.match(plant(column, (g, a) => { if (d[a.id] === undefined) d[a.id] = a.d; a.d = d[a.id]; }, 6), /is stuck on the road/);
});
