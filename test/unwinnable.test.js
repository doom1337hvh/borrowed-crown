// The promise of the game, checked: nobody keeps the crown.
// Every reign has to end, whoever plays it and whatever advantage they are handed.
const test = require('node:test');
const assert = require('node:assert');
const { reign } = require('./harness.js');

const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);

test('every reign ends, with the rival AI playing your seat', () => {
  for (const seed of SEEDS) {
    const { game, years } = reign(seed);
    assert.ok(game.over, `seed ${seed} was still reigning after ${years.toFixed(1)} years`);
    assert.ok(['fallen', 'died'].includes(game.ending), `seed ${seed} ended as "${game.ending}"`);
    assert.ok(years < 45, `seed ${seed} lasted ${years.toFixed(1)} years`);
  }
});

test('every reign ends even with three times the recruits', () => {
  for (const seed of SEEDS.slice(0, 16)) {
    const { game, years } = reign(seed, { cheat: { levy: 3 } });
    assert.ok(game.over, `seed ${seed} was still reigning after ${years.toFixed(1)} years`);
  }
});

test('doing nothing does not save you either', () => {
  for (const seed of SEEDS.slice(0, 12)) {
    const { game, years } = reign(seed, { bot: false });
    assert.ok(game.over, `seed ${seed} sat on one town for ${years.toFixed(1)} years`);
    assert.strictEqual(game.stats.reign, 0, 'an idle player never wears the crown');
  }
});

test('there is no way to end a reign except losing it', () => {
  const { game } = reign(7);
  assert.notStrictEqual(game.ending, 'won');
  assert.strictEqual(typeof game.win, 'undefined');
});
