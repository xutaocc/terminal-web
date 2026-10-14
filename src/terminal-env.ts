/** 终端颜色默认开关：设置菜单中保存的值优先于此默认值。
 * 设置修改后新建会话生效；不会改变已运行程序的环境。
 * 遵循 NO_COLOR 的程序（如 Codex）会关闭颜色，强制输出 ANSI 的程序可忽略它。
 */
import fs from 'node:fs';
import path from 'node:path';

export const TERMINAL_COLORS_ENABLED = true;
let colorsEnabled = TERMINAL_COLORS_ENABLED;
let policyFile: string | undefined;

export function configureColorPolicy(file: string): void {
  policyFile = file;
  colorsEnabled = TERMINAL_COLORS_ENABLED;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof value?.enabled === 'boolean') colorsEnabled = value.enabled;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[colors] Cannot load saved policy; using default');
  }
}

export function getTerminalColors(): boolean { return colorsEnabled; }

export function setTerminalColors(enabled: boolean): void {
  if (!policyFile) throw new Error('Color policy not configured');
  fs.mkdirSync(path.dirname(policyFile), { recursive: true });
  const temp = `${policyFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ enabled }), { mode: 0o600 });
  fs.renameSync(temp, policyFile);
  colorsEnabled = enabled;
}

export function terminalEnvironment(
  source: NodeJS.ProcessEnv,
  enabled = getTerminalColors(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, TERM: 'xterm-256color' };
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  if (enabled) {
    delete env.NO_COLOR;
    env.COLORTERM = 'truecolor';
    env.CLICOLOR = '1';
  } else {
    env.NO_COLOR = '1';
    env.CLICOLOR = '0';
    delete env.COLORTERM;
  }
  return env;
}

/** Apply the same policy to an existing tmux server before creating a shell.
 * Sanitizing only the client's environment does not update tmux's cached env.
 */
export function tmuxColorArgs(enabled = getTerminalColors()): string[] {
  const env = terminalEnvironment({}, enabled);
  return ['NO_COLOR', 'COLORTERM', 'CLICOLOR', 'FORCE_COLOR', 'CLICOLOR_FORCE'].flatMap(key =>
    env[key] === undefined
      ? ['set-environment', '-gu', key, ';']
      : ['set-environment', '-g', key, env[key]!, ';']);
}
