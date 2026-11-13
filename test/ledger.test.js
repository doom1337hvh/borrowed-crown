// No troops from thin air.
// Every soldier is levied out of a town's population, and the dead stay dead, so at any moment
//   people alive  =  people at the start  +  births  -  deaths.
const test = require('node:test');
const assert = require('node:assert');
const { reign, Game, YEAR } = require('./harness.js');

test('the head count always matches the books', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const { game, drift } = reign(seed, { audit: true });
    assert.ok(drift < 0.5, `seed ${seed}: ${drift.toFixed(3)} people unaccounted for`);
    assert.ok(game.ledger.dead > 0, 'wars kill people');
  }
});

test('soldiers only ever come out of the population', () => {
  const game = new Game({ seed: 3, quiet: true, bot: true });
  let men = 0, pop = 0;
  const count = () => {
    men = 0; pop = 0;
    for (const k of game.keeps) { men += k.men; pop += k.pop; }
    for (const a of game.armies) men += a.men;
  };
  count();
  for (let i = 0; i < 20 * 60 * 4 && !game.over; i++) {
    const m0 = men, p0 = pop, born0 = game.ledger.born;
    game.update(0.05);
    count();
    // Any rise in men under arms must be paid for by an equal fall in civilians (births aside).
    const raised = men - m0, leftTheFields = p0 - pop + (game.ledger.born - born0);
    assert.ok(raised <= leftTheFields + 1e-6, `tick ${i}: ${raised.toFixed(3)} soldiers appeared, only ${leftTheFields.toFixed(3)} civilians left`);
  }
});

test('an army that outruns its bread starves', () => {
  const game = new Game({ seed: 5, quiet: true, rivals: 1 });
  const home = game.keeps.find((k) => k.owner === 0);
  home.men = 1000;
  const target = game.keeps[home.adj[0]];
  target.men = 5000; target.food = target.cap;        // far too strong to give up
  for (const v of target.adj) if (v !== home.id) game.keeps[v].men = 5000;
  const army = game.dispatch(home, target.id, 1000);
  home.food = 0;                                        // and nothing left at home to send after them
  for (const k of game.keeps) if (k.owner === 0) k.pool = 0;
  for (let i = 0; i < 40 * 20; i++) { game.update(0.05); home.food = 0; }
  assert.ok(army.men < 500, `${Math.round(army.men)} of 1000 still standing after forty seconds unfed`);
});

test('the same seed tells the same story', () => {
  const a = reign(11), b = reign(11);
  assert.strictEqual(a.game.time, b.game.time);
  assert.strictEqual(a.game.ending, b.game.ending);
  assert.strictEqual(Math.round(a.game.ledger.dead), Math.round(b.game.ledger.dead));
  assert.ok(a.years > 0.5 && YEAR === 80);
});
