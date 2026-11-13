# Where the 3D rebuild stands

The game is being rebuilt from a flat 2D map into a 3D world with armies you can see.
This note says what is finished, what was stopped half way, and what comes next. The
rules themselves are described in `README.md` (which still describes the old flat page).

## Running and testing

- Play: open `index.html` in a browser, or `npm start` and open the address it prints.
- Rules tests: `npm test` (29 tests, about 10 seconds).
- Screenshots and smoke tests: `node tools/shot.js --out shot.png` (see the comment at the
  top of the file for every flag). It needs Playwright with Chromium. It exits 1 on any
  page error and prints draw calls and triangles.
- One-file page for publishing: `node tools/bundle.js` writes `dist/borrowed-crown.html`.

## The modules

| File | What it is | State |
| --- | --- | --- |
| `js/sim.js` | the rules, no DOM, runs under Node | finished; two small fixes this round (below) |
| `js/terrain.js` | `BC.buildTerrain(game)`: height field, coast, roads, sites, woods, fields | finished |
| `js/scenery3d.js` | `BC.Scenery`: ground, sea, sky, roads, woods, fields, seasons, realm colours and frontier lines | finished |
| `js/towns3d.js` | `BC.Towns`: villages, towns and cities, banners, siege/hunger/sack/unrest states | finished |
| `js/units3d.js` | `BC.Units`: every soldier | rewrite stopped part way (below) |
| `js/view3d.js` | `BC.View3D`: renderer, camera, labels, picking | rework stopped part way (below) |
| `js/main.js`, `index.html`, `style.css` | the page: input, bars, cards | rework stopped part way (below) |
| `js/render.js` | `BC.Renderer`: flat map, second view and fallback without WebGL | not yet updated |
| `js/audio.js` | `BC.audio`: synthesised sound | not yet updated |
| `test/*.js` | `npm test` | battles, soak and invariant tests added |

Every module has a header comment with its contract. The 3D modules are built by
`View3D.setGame`: `new BC.Scenery|Towns|Units(THREE, scene, game, terrain)`, each with
`setTheme(theme)`, `update(dt, game, t[, view])` and `dispose()`. `towns.site(id)` gives the
wall radius, wall height, gate angles and banner height of each town as built.

Constraints worth keeping: no dependencies and no build step; three.js r149 from cdnjs is the
only network script; colours come from the CSS tokens and `theme.f[...]` banner colours are
the only saturated colours on the map; light and dark themes; reduced motion respected; at the
whole-realm view stay under about 60 draw calls and 300k triangles (now about 20 and 185k);
player-facing text in plain British English with no em-dashes.

## Stopped part way

- **Soldiers (`js/units3d.js`).** Figures with tunics and shields in banner colours, standards,
  ranks on the muster ground, columns on the road and battles all draw and run without errors.
  Still to check or finish: columns no more than two abreast through gates (gate passages are
  4.3 to 5.6 wide), siege camp works (tents, fires, ladders as `army.breach` rises), routs,
  baggage that thins as `army.food` runs low, fallen men fading, reduced motion, `dispose()`.
- **Camera and labels (`js/view3d.js`).** Still to check or finish: keep the camera out of
  mountains (peaks reach about 115), make `ground()` follow the terrain height instead of a
  flat plane, lift town plates clear of the keep banner (`towns.site(id).top + 6`), declutter
  labels when zoomed out, an off-screen arrow for pings.
- **Page (`js/main.js`, `index.html`, `style.css`).** A "?" help card and a "Several" select
  button for touch were added. Still to check: every control with real mouse and touch events,
  the help card shown once at the start of the first reign, explain March and Levy on screen,
  the title card rewritten for the 3D game, the title-screen demo pre-run into spring instead
  of winter, layout on phone portrait and landscape.

## Not started

- **Flat map (`js/render.js`):** draw the coast, lakes and relief from `BC.buildTerrain(game)`
  so it shows the same island as the 3D view; show battles in progress; selectable columns.
- **Sound (`js/audio.js`):** implement `BC.audio.scene({ playing, season, battles, mine, zoom })`
  (a seasonal ambient bed and a battle din), better cues, a limiter on the master.
- **README:** rewrite for the 3D game and its controls.
- **Opening balance:** check whether the starting garrison is too big for the capital's
  granary; new players run out of grain and lose men to desertion in the first minutes.

## Rule fixes made this round (`js/sim.js`)

- Men in a battle keep eating: a siege camp forages as it did before the fight, a column eats
  from its wagons.
- A column that comes level with a field battle in the same tick is held behind it instead of
  slipping past.
- Two columns that have already passed each other (one turned round) no longer start a battle.

## Next feature: town orders

Select one of your towns and a panel shows that town's own standing orders. The rival houses
get the same rules (no advantage either way).

1. **Levy per town:** Light, Fair or Heavy. The bottom-bar levy buttons set every town at once
   when nothing is selected. The unrest from the levy becomes per town.
2. **Hold:** the minimum garrison the town keeps: None, Guard (3 per 100 people) or Full
   (4.5 per 100). March orders never take the town below it.
3. **Grain:** Share (wagons move grain to and from neighbours, as now) or Hoard (keep it home).
4. **Rally point (optional):** another of your towns; men above the floor march there on their
   own as they are levied, if a road through your own towns reaches it.

Add rules tests for each, show the settings on the town's plate or briefing line, and explain
them in the help card.
