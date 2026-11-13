// What must be true of the world after every tick, whatever happened in it.
// Shared by the soak test (many AI reigns) and the hand-built battle tests.
//
//   const audit = auditor(game);
//   game.update(0.05); const wrong = audit();     // [] when all is well, else plain sentences
//
// Call it after game.update, every tick or every few ticks. A column that has not moved since
// the last call must have had cause to wait, then or now; calls between which a battle began
// are let off, because a battle can begin and end inside one tick (a handful of men against a
// camp), and a column that is truly stuck will still be standing there at the next call.

const KINDS = ['field', 'gate', 'camp', 'sally', 'storm'];
const EPS = 1e-6;

function finite(obj, what, bad) {
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === 'number' && !Number.isFinite(v)) bad.push(`${what}: ${key} is ${v}`);
  }
}

/** True while an army came out of a siege camp to fight, or is sitting in one. */
function camped(a) {
  return a.state === 'camp' || (a.state === 'fight' && a.was === 'camp');
}

/** Has a marching column a reason to stand still? A battle on its road just ahead, or one at the gates it has reached. */
function mayWait(game, a) {
  const next = game.keeps[a.path[a.i + 1]];
  if (next && next.battle && a.d >= a.len - 0.02) return true;
  for (const b of game.battles) {
    if (b.kind === 'field' && Math.hypot(b.x - a.x, b.y - a.y) <= 16.01) return true;
  }
  return false;
}

function auditor(game) {
  let seen = new Map();            // army id -> where it stood at the last call, and whether it had cause to wait
  let seq = game.battleSeq;        // the last battle begun before the last call

  return function audit() {
    const bad = [], K = game.keeps;
    const live = new Set(game.battles), afield = new Set(game.armies), ids = new Set();

    for (const b of game.battles) {
      const tag = `battle ${b.id} (${b.kind})`;
      finite(b, tag, bad);
      if (!KINDS.includes(b.kind)) bad.push(`${tag} is of no known kind`);
      if (b.done) bad.push(`${tag} is over but still listed`);
      if (ids.has(b.id)) bad.push(`${tag} is listed twice`);
      ids.add(b.id);
      if (!(b.dur >= 2.6 && b.dur <= 6)) bad.push(`${tag} is set to last ${b.dur} s`);
      if (!(b.t >= 0 && b.t < b.dur)) bad.push(`${tag} has outlived its duration (${b.t} of ${b.dur} s)`);
      if ((b.kind === 'field') !== (b.at === -1)) bad.push(`${tag} is at town ${b.at}`);
      if (b.at >= 0 && K[b.at].battle !== b) bad.push(`${tag}: ${K[b.at].name} does not know it is being fought at its gates`);
      for (const [who, s] of [['attacker', b.att], ['defender', b.def]]) {
        finite(s, `${tag} ${who}`, bad);
        if (!s.army && !s.keep) bad.push(`${tag}: the ${who} is nobody`);
        if (s.army && !afield.has(s.army)) bad.push(`${tag}: the ${who}'s army ${s.army.id} has gone`);
        if (s.army && (s.army.state !== 'fight' || s.army.battle !== b)) bad.push(`${tag}: the ${who}'s army ${s.army.id} is not fighting in it (state ${s.army.state})`);
        if (s.keep && s.keep !== K[b.at]) bad.push(`${tag}: the ${who}'s garrison is not the one at town ${b.at}`);
        if (!(s.loss >= 0 && s.loss <= s.men0 + EPS)) bad.push(`${tag}: the ${who} is to lose ${s.loss} of ${s.men0}`);
        if (!(s.dead >= 0 && s.dead <= s.loss + EPS)) bad.push(`${tag}: the ${who} has ${s.dead} dead, more than the ${s.loss} decided`);
        // Columns that meet on a road fight where they stand: both are at the battle, not somewhere else on the road.
        if (b.kind === 'field' && s.army && Math.hypot(s.army.x - b.x, s.army.y - b.y) > 24) {
          bad.push(`${tag}: the ${who}'s army ${s.army.id} is ${Math.hypot(s.army.x - b.x, s.army.y - b.y).toFixed(1)} away from the fighting`);
        }
      }
    }

    const now = new Map(), calm = game.battleSeq === seq;
    seq = game.battleSeq;
    for (const a of game.armies) {
      const tag = `army ${a.id} (banner ${a.owner})`;
      finite(a, tag, bad);
      if (a.men < 1) bad.push(`${tag} has ${a.men} men and is still on the map`);
      if (a.food < -EPS) bad.push(`${tag} carries ${a.food} food`);
      if (a.state === 'fight') {
        const b = a.battle;
        if (!b || !live.has(b) || (b.att.army !== a && b.def.army !== a)) bad.push(`${tag} is in state 'fight' with no live battle that lists it`);
        if (a.was !== 'march' && a.was !== 'camp') bad.push(`${tag} is fighting and was '${a.was}' before`);
      } else {
        if (a.state !== 'march' && a.state !== 'camp') bad.push(`${tag} is in state '${a.state}'`);
        if (a.battle) bad.push(`${tag} is not fighting but still points at battle ${a.battle.id}`);
      }
      if (camped(a)) {
        if (!(a.at >= 0) || K[a.at].camp !== a) bad.push(`${tag} is camped at town ${a.at}, which does not have it as its camp`);
        continue;
      }
      // On the road: on a real road, and somewhere along it.
      const u = a.path[a.i], v = a.path[a.i + 1];
      const road = u === undefined || v === undefined ? 0 : game.len(u, v);
      if (!(road > 0)) { bad.push(`${tag} is on the march from ${u} to ${v}, and there is no such road`); continue; }
      if (Math.abs(a.len - road) > EPS) bad.push(`${tag} thinks its road is ${a.len} long, it is ${road}`);
      if (!(a.d >= 0 && a.d < a.len + (a.state === 'fight' ? 10 : EPS))) bad.push(`${tag} is ${a.d} along a road of ${a.len}`);
      if (a.state !== 'march') continue;
      const cause = mayWait(game, a), was = seen.get(a.id);
      if (calm && was && was.u === u && was.v === v && a.d <= was.d + 1e-9 && !cause && !was.cause) {
        bad.push(`${tag} is stuck on the road from ${u} to ${v} at ${a.d.toFixed(2)} of ${a.len.toFixed(2)}: not moving, not camped, not fighting`);
      }
      now.set(a.id, { u: u, v: v, d: a.d, cause: cause });
    }
    seen = now;

    for (const k of K) {
      finite(k, k.name, bad);
      if (k.men < -EPS) bad.push(`${k.name} has ${k.men} men`);
      if (k.food < -EPS) bad.push(`${k.name} has ${k.food} food`);
      if (!(k.pop > 0)) bad.push(`${k.name} has ${k.pop} people`);
      if (k.battle && (!live.has(k.battle) || k.battle.at !== k.id)) bad.push(`${k.name} points at battle ${k.battle.id}, which is over or elsewhere`);
      const c = k.camp;
      if (c && !(afield.has(c) && c.men >= 1 && c.at === k.id && camped(c))) {
        bad.push(`${k.name} has army ${c.id} as its camp, which is not camped there (state ${c.state}, at ${c.at}, ${c.men} men)`);
      }
    }

    const drift = game.headcount() - (game.ledger.start + game.ledger.born - game.ledger.dead);
    if (!(Math.abs(drift) < 0.5)) bad.push(`the ledger is out by ${drift} people`);
    return bad;
  };
}

module.exports = { auditor, camped, KINDS };
