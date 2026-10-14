/** 终端颜色统一开关：true 显示颜色；false 请求程序关闭颜色。
 * 修改后重启网页后台，新建会话生效；不会改变已运行程序的环境。
 * 遵循 NO_COLOR 的程序（如 Codex）会关闭颜色，强制输出 ANSI 的程序可忽略它。
 */
export const TERMINAL_COLORS_ENABLED = false;

export function terminalEnvironment(
  source: NodeJS.ProcessEnv,
  enabled = TERMINAL_COLORS_ENABLED,
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
export function tmuxColorArgs(enabled = TERMINAL_COLORS_ENABLED): string[] {
  const env = terminalEnvironment({}, enabled);
  return ['NO_COLOR', 'COLORTERM', 'CLICOLOR', 'FORCE_COLOR', 'CLICOLOR_FORCE'].flatMap(key =>
    env[key] === undefined
      ? ['set-environment', '-gu', key, ';']
      : ['set-environment', '-g', key, env[key]!, ';']);
}
