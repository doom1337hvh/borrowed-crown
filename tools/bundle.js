// Inline style.css and the local js files into one page fragment (no doctype/html/head/body) for publishing.
// Usage: node tools/bundle.js  ->  dist/borrowed-crown.html (and dist/skeleton-test.html, a full page to open locally)
// Scripts with an absolute URL (three.js on cdnjs) are left as they are and moved to the top of the fragment.
const fs = require('fs'), path = require('path');
const root = process.argv[2] || path.join(__dirname, '..');
const outDir = path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]+>/)[0];
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const remote = [];
body = body.replace(/<script src="([^"]+)"><\/script>\n?/g, (m, src) => {
  if (/^https?:/.test(src)) { remote.push(m.trim()); return ''; }
  const js = fs.readFileSync(path.join(root, src), 'utf8');
  if (/<\/script/i.test(js)) throw new Error('script close tag inside ' + src);
  return '<script>\n' + js + '</script>\n';
});
const firstInline = body.indexOf('<script>');
body = body.slice(0, firstInline) + remote.join('\n') + '\n' + body.slice(firstInline);
const out = '<title>Borrowed Crown</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n' + fonts + '\n<style>\n' + css + '</style>\n' + body;
fs.writeFileSync(path.join(outDir, 'borrowed-crown.html'), out);
// A stand-in for the publish skeleton, to test the fragment in standards mode.
fs.writeFileSync(path.join(outDir, 'skeleton-test.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>:root{color-scheme:light;padding:env(safe-area-inset-top,0) 0 env(safe-area-inset-bottom,0);box-sizing:border-box}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>' + out + '</body></html>');
console.log('bundle bytes', out.length, 'remote scripts', remote.length);
