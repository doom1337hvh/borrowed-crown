# Borrowed Crown

A real-time strategy game about holding a crown nobody gets to keep.

You start with one town and four hundred men. Take the realm, wear the crown for as long as you can, and watch everyone come for it. There is no victory screen, because there is no victory.

## Play

Open `index.html` in a browser. That is the whole install. It runs on a phone as well as a desk.

To serve it locally instead:

```bash
npm start
```

## How it works

Every banner on the map, yours included, plays by the same rules. Nothing is scripted and nobody cheats.

**Men come from people.** Each town has a population. Young men come of age into a levy pool and are mustered into the garrison. Every soldier is a farmer taken off the land, so a bigger army means a smaller harvest. The dead stay dead. No unit in the game is ever created from nothing.

**Armies eat.** A soldier eats one ration a second. Towns grow grain in spring, summer and autumn and nothing in winter. An army on the march carries about ten seconds of bread. After that it lives off a friendly granary next door, forages the land it is camped on, or starves and deserts. Each road can only haul so much, which caps how many men you can mass in one place.

**Walls hold.** A garrison behind walls counts for one and a half to nearly four times its number. You have three ways in: bring so many men the town opens its gates, sit outside until its granary is empty, or storm it and pay for it. A storm ends in a sack, which kills townsfolk and leaves the survivors hating you.

**Winter kills.** Men in the field freeze. Sieges started in autumn are a gamble.

**People have limits.** Conquered towns resent foreign rule. Heavy conscription, hunger, a realm too wide to govern and a rule gone on too long all push a town toward revolt. A garrison holds the lid down, but a garrison is men you cannot use elsewhere. When a town rises, one in twenty of its people take up arms.

**Power makes enemies.** Whoever rules the most people wears the crown. When the crowned head grows strong enough, the other houses stop fighting each other and unite against it. That applies to them as much as to you.

**Nobody outlives it.** Hold on long enough and age does what your rivals could not.

## Controls

| Action | Mouse | Touch |
| --- | --- | --- |
| Select a town or siege camp | Click it | Tap it |
| March | Click a target, or drag from the town to the target | Tap a target, or drag |
| Gather at one of your own towns | Right click it, or drag to it | Press and hold it, or drag to it |
| Select several | Drag a box, or shift click | Drag a box |
| Select everything | `A`, or double click a town | Double tap a town |
| How many to send | `1` `2` `3` | The quarter, half and all buttons |
| Storm the walls or sally out | `S` | The red button |
| Pause, sound | `Space`, `M` | The buttons bottom right |

## The code

No build step, no dependencies.

| File | What it holds |
| --- | --- |
| `js/sim.js` | The rules. No DOM, so it also runs under Node. |
| `js/render.js` | Everything drawn on the map canvas. |
| `js/main.js` | Input, the bars around the map, title and ending cards. |
| `js/audio.js` | Synthesised sound. No audio files. |
| `test/` | The claims above, checked. |

## Tests

```bash
npm test
```

The tests play dozens of full reigns headless and check three things:

1. **You cannot win.** Every reign ends, including ones where the player is handed triple the recruits, and ones where the player does nothing at all.
2. **No troops from thin air.** A ledger of births and deaths has to match the head count at every sample, and men under arms can only rise when civilians fall by the same amount.
3. **Logistics bite.** An army cut off from bread starves.

Need Node 20 or newer for the test runner.

From the browser console, `BC.live.game` is the running simulation if you want to poke at it.
