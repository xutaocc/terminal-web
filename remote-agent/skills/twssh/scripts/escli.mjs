#!/usr/bin/env node
// Emit a task spec locally; this generator does not connect or install software.
import fs from 'node:fs';
import path from 'node:path';
const [command, output, ...extra] = process.argv.slice(2);
if (command !== 'ensure' || !output || !path.isAbsolute(output) || extra.length) {
  console.error('Usage: node scripts/escli.mjs ensure /absolute/local/escli-task.json');
  process.exit(1);
}
const script = fs.readFileSync(new URL('./escli.ps1', import.meta.url), 'utf8');
const spec = {
  executable: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  cwd: 'C:/', timeoutMs: 120000
};
fs.writeFileSync(output, JSON.stringify(spec, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(output);
