import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const browser = process.env.BROWSER_BIN || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
if (!existsSync(browser)) {
  console.log('SKIP: set BROWSER_BIN to a Chromium browser');
  process.exit(0);
}
const folder = mkdtempSync(join(tmpdir(), 'terminal-indicator-'));
try {
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const fixture = join(folder, 'indicator.html');
  writeFileSync(fixture, `<style>${css}</style><script>
  addEventListener('DOMContentLoaded', () => {
    const results = [];
    for (const surface of ['tab', 'm-title', 'drawer-body', 'ps-card']) {
      const parent = document.createElement('div'); parent.className = surface;
      const dot = document.createElement('span'); parent.append(dot); document.body.append(parent);
      for (const state of ['', 'working', 'done', 'unread', 'waiting', 'working unread']) {
        dot.className = 'tab-dot ' + state;
        const style = getComputedStyle(dot);
        const mask = style.maskImage || style.webkitMaskImage || 'none';
        results.push({ surface, state, animation: style.animationName, border: style.borderTopWidth, width: style.width,
          filled: style.backgroundColor !== 'rgba(0, 0, 0, 0)',
          radius: style.borderTopLeftRadius, masked: mask !== 'none', badge: mask.includes('circle') });
      }
    }
    document.body.textContent = JSON.stringify(results);
  });
  </script>`);
  const html = execFileSync(browser, ['--headless', '--disable-gpu', '--no-first-run', '--user-data-dir=' + join(folder, 'profile'), '--dump-dom', 'file://' + fixture], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
  const results = JSON.parse(html.match(/<body[^>]*>([^<]*)<\/body>/)[1]);
  // Each state is its own SHAPE, so it reads without telling colours apart:
  // idle = hollow ring, done (read) = small solid dot, working = spinning arc,
  // unread = check with a corner badge, waiting = "?" tile. Colour is never
  // the only difference.
  const shapeOf = r => r.animation === 'terminal-output-spin' ? 'arc'
    : !r.masked ? (r.radius !== '50%' ? 'other' : r.border !== '0px' && !r.filled ? 'ring' : r.border === '0px' && r.filled ? 'dot' : 'other')
    : r.animation === 'agent-waiting-pulse' ? 'question'
    : r.badge ? 'check+badge' : 'check';
  const expected = { '': 'ring', working: 'arc', done: 'dot', unread: 'check+badge', waiting: 'question', 'working unread': 'arc' };
  for (const r of results) assert.equal(shapeOf(r), expected[r.state], JSON.stringify(r));
  for (const surface of ['tab', 'm-title', 'drawer-body', 'ps-card']) {
    const shapes = results.filter(r => r.surface === surface && r.state !== 'working unread').map(shapeOf);
    assert.equal(new Set(shapes).size, shapes.length, `${surface}: two states share a shape`);
    // The two greys: the read dot is smaller than the idle ring, not only filled.
    const px = state => parseFloat(results.find(r => r.surface === surface && r.state === state).width);
    assert.ok(px('done') < px(''), `${surface}: read dot should be smaller than the idle ring`);
  }
  console.log(`PASS: ${results.length} browser-rendered indicator states, five distinct shapes on each of four surfaces`);
} finally {
  rmSync(folder, { recursive: true, force: true });
}
