#!/usr/bin/env node
/*
 * Screenshot / smoke-test the game in headless Chromium. Needs Playwright with Chromium (npm i -D playwright && npx playwright install chromium).
 * Uses software WebGL so it runs anywhere; on a machine with a GPU you can drop the --use-angle flags below.
 *
 *   node tools/shot.js [--root <repo dir, default: this repo>] --out <png> [--w 1280 --h 800] [--dpr 1] [--scheme light|dark] [--touch]
 *                [--play] [--seed N] [--pre "<js>"] [--bot] [--ff <game seconds>] [--cam "<js>"]
 *                [--wait <ms>] [--view world|map] [--no-three] [--eval "<js expression, printed as JSON>"]
 *
 *   Order of events: load page -> (--view) -> (--play) -> (--seed) -> (--pre) -> (--ff) -> (--cam) -> wait -> (--eval) -> shot
 *   --play     click "Raise your banner" (otherwise the title screen is shot)
 *   --seed N   restart the reign on map N, so the same scene can be shot again after a change (implies --play)
 *   --pre      javascript run before fast-forwarding, with g = the simulation, R = the view, BC = the namespace
 *   --bot      let the AI play the player's seat while fast-forwarding (a busy map without clicking)
 *   --ff       fast-forward the simulation this many game seconds (80 = one year) before the shot
 *   --cam      javascript run after fast-forwarding (same variables); the camera then snaps to its goal.
 *              e.g. --cam "const k=g.keeps[g.factions[0].seat]; R.focus(k.x,k.y); R.goal.dist=260; R.goal.pitch=0.6; R.goal.yaw=0.5"
 *   --no-three block the three.js download, to test the flat-map fallback
 *   NOTE: headless rendering is software (5-10 fps) and the game clock advances at most 0.05 s per frame, so --wait
 *   only advances the game a little. Use --ff for game time and --wait for letting frames render.
 *   Prints page errors. Exit code 1 if any page error (console warnings about WebGL ReadPixels are ignored).
 */
const { chromium } = require('playwright');
const path = require('path');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] === undefined || process.argv[i + 1].startsWith('--') ? true : process.argv[i + 1]); };
(async () => {
  const root = path.resolve(arg('root', path.join(__dirname, '..'))), out = arg('out', null);
  const W = +arg('w', 1280), H = +arg('h', 800), touch = !!arg('touch', false);
  // Without three.js there is no WebGL to render, and the software-GL flags make screenshots of the 60 fps flat canvas
  // take 40 s or more, so the flat fallback is shot with a plain browser.
  const b = await chromium.launch({ args: arg('no-three', false) ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: +arg('dpr', 1), colorScheme: arg('scheme', 'light'), hasTouch: touch, isMobile: touch });
  const page = await ctx.newPage();
  const errs = [];
  // With --no-three the blocked three.js request is expected and is not counted as an error.
  page.on('console', (m) => { if (m.type() === 'error' && !/ReadPixels|GPU stall/.test(m.text()) && !(arg('no-three', false) && /Failed to load resource/.test(m.text()))) errs.push('console.error: ' + m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message + '\n  ' + (e.stack || '').split('\n').slice(1, 5).join('\n  ')));
  if (arg('no-three', false)) await page.route('**/three.min.js', (r) => r.abort());
  await page.goto('file://' + path.join(root, arg('page', 'index.html')));
  await page.waitForTimeout(900);
  if (arg('view', null)) await page.evaluate((v) => BC.live.setView(v), arg('view'));
  if (arg('play', false) || arg('seed', null)) { await (touch ? page.tap('#b-start') : page.click('#b-start')); await page.waitForTimeout(500); }
  if (arg('seed', null)) { await page.evaluate((seed) => BC.live.restart(seed), +arg('seed')); await page.waitForTimeout(300); }
  if (arg('pre', null)) await page.evaluate((code) => { (new Function('g', 'R', 'BC', code))(BC.live.game, BC.live.renderer, BC); }, arg('pre'));
  const ff = +arg('ff', 0);
  if (ff > 0) {
    await page.evaluate(({ ff, bot }) => { const g = BC.live.game; const was = g.bot; if (bot) g.bot = true; for (let i = 0; i < ff * 20 && !g.over; i++) g.update(0.05); g.bot = was; g.fx.length = 0; if (g.events.length > 4) g.events.splice(0, g.events.length - 4); }, { ff, bot: !!arg('bot', false) });
  }
  if (arg('cam', null)) await page.evaluate((code) => { const R = BC.live.renderer; (new Function('g', 'R', 'BC', code))(BC.live.game, R, BC); if (R.cam && R.goal) Object.assign(R.cam, R.goal); }, arg('cam'));
  await page.waitForTimeout(+arg('wait', 1600));
  if (arg('eval', null)) console.log('eval:', JSON.stringify(await page.evaluate(arg('eval'))));
  const info = await page.evaluate(() => { const g = window.BC && BC.live && BC.live.game, R = BC.live && BC.live.renderer; return { view: R ? (R.is3d ? 'world' : 'map') : null, three: typeof THREE !== 'undefined' ? THREE.REVISION : null, year: g ? +(g.time / 80).toFixed(2) : null, armies: g ? g.armies.length : null, battles: g ? g.battles.length : null, scroll: [document.documentElement.scrollWidth, innerWidth, document.documentElement.scrollHeight, innerHeight], draw: R && R.renderer ? { calls: R.renderer.info.render.calls, tris: R.renderer.info.render.triangles } : null }; });
  console.log('info:', JSON.stringify(info));
  if (out) { await page.screenshot({ path: path.resolve(out), timeout: 90000 }); console.log('shot:', path.resolve(out)); }
  console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors');
  await b.close();
  process.exit(errs.length ? 1 : 0);
})();
