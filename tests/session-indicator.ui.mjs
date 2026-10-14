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
    for (const surface of ['tab', 'm-title', 'drawer-body']) {
      const parent = document.createElement('div'); parent.className = surface;
      const dot = document.createElement('span'); parent.append(dot); document.body.append(parent);
      for (const state of ['', 'idle', 'connected', 'connected unread', 'connected unread working', 'connected working']) {
        dot.className = 'tab-dot ' + state;
        const style = getComputedStyle(dot);
        results.push({surface, state, color: style.backgroundColor, animation: style.animationName});
      }
    }
    document.body.textContent = JSON.stringify(results);
  });
  </script>`);
  const html = execFileSync(browser, ['--headless', '--disable-gpu', '--no-first-run', '--user-data-dir=' + join(folder, 'profile'), '--dump-dom', 'file://' + fixture], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
  const results = JSON.parse(html.match(/<body[^>]*>([^<]*)<\/body>/)[1]);
  for (const result of results) {
    const working = result.state.includes('working');
    const unread = result.state.includes('unread');
    assert.equal(result.color, working ? 'rgba(0, 0, 0, 0)' : unread ? 'rgb(35, 209, 139)' : 'rgb(106, 106, 106)', JSON.stringify(result));
    assert.equal(result.animation, working ? 'terminal-output-spin' : 'none');
  }
  console.log('PASS: 18 browser-rendered indicator states across desktop, mobile title and drawer');
} finally {
  rmSync(folder, { recursive: true, force: true });
}
