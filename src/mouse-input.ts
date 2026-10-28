/** Windows mux/ConPTY can leak idle SGR mouse motion into a shell/TUI prompt.
 * Drop hover-only reports (including modifiers), but preserve clicks, dragging
 * and wheels. Only inspect complete mouse-only messages: pasted text is data.
 * This deliberately disables hover interaction on Windows terminals.
 */
export function withoutMouseHover(input: string): string {
  if (!/^(?:\x1b\[<\d+;\d+;\d+[Mm])+$/.test(input)) return input;
  return input.replace(/\x1b\[<(\d+);\d+;\d+([Mm])/g, (report, code: string, end: string) =>
    end === 'M' && (Number(code) & ~28) === 35 ? '' : report);
}
