/** Mouse gestures and terminal replies must not exit history browsing. */
export function isKeyboardInput(input: string): boolean {
  return input.replace(
    /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[[?>][\d;]*c|\x1b\[\d+;\d+R|\x1b\[\??\d+n|\x1b\[[IO]|\x1b\][\s\S]*?(?:\x07|\x1b\\)/g,
    '',
  ).length > 0;
}
