// Shared helper: play one reign as fast as the machine allows.
// By default the rival AI sits in the player's seat; pass { bot: false } for a player who never gives an order.
const { Game, YEAR } = require('../js/sim.js');

function reign(seed, opts = {}) {
  const game = new Game(Object.assign({ seed, quiet: true, bot: true }, opts));
  const step = 0.05, limit = (opts.limitYears || 60) * YEAR;
  let drift = 0, ticks = 0;
  while (!game.over && game.time < limit) {
    game.update(step);
    if (opts.audit && ++ticks % 100 === 0) {
      const books = game.ledger.start + game.ledger.born - game.ledger.dead;
      drift = Math.max(drift, Math.abs(game.headcount() - books));
    }
  }
  return { game, years: game.time / YEAR, drift };
}

module.exports = { reign, Game, YEAR };
