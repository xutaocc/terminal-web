import path from 'node:path';
import { within } from './file-api.js';

/** Convenience guard for ordinary shell navigation, NOT a command sandbox.
 * Full-screen applications and Claude keep their existing input behavior.
 */
export class ShareInputGuard {
  private line = '';
  private reliable = true;
  constructor(private root: string, private cwd: () => Promise<{ cwd: string; command: string } | null>, private warn: () => void) {}
  async filter(input: string): Promise<string> {
    let out = '';
    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      if (input.startsWith('\x1b[200~', i) || input.startsWith('\x1b[201~', i)) { out += input.slice(i, i + 6); i += 5; continue; }
      if (char === '\r' || char === '\n') {
        const match = this.reliable && /^\s*(?:cd|chdir|pushd|set-location)(?:\s+(.+?))?\s*$/i.exec(this.line);
        let blocked = false;
        if (match) {
          const state = await this.cwd();
          if (state && /^(?:-?(?:ba|z|fi|da|k)?sh|pwsh|powershell|cmd)(?:\.exe)?$/i.test(path.basename(state.command))) {
            let arg = (match[1] ?? '').trim().replace(/^(?:\/d|-Path|-LiteralPath)\s+/i, '');
            if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) arg = arg.slice(1, -1);
            // Unknown expansions are deliberately not interpreted by this helper.
            if (!arg || arg === '-' || arg.startsWith('~')) blocked = true;
            else if (!/[;$`|&<>]/.test(arg)) blocked = !within(path.resolve(state.cwd, arg), this.root);
          }
        }
        out += blocked ? '\x03' : char;
        if (blocked) this.warn();
        this.line = ''; this.reliable = true;
      } else {
        out += char;
        if (char === '\x03' || char === '\x15') { this.line = ''; this.reliable = true; }
        else if (char === '\x7f' || char === '\b') this.line = this.line.slice(0, -1);
        else if (char >= ' ' && char !== '\x7f') this.line = (this.line + char).slice(-8192);
        else this.reliable = false; // history, cursor editing, completion: don't damage interactive input
      }
    }
    return out;
  }
}
