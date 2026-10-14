/** xterm's mouse protocol reports direction but drops the wheel's magnitude.
 * Use 2x acceleration for small movements and larger wheel steps
 * without letting a single event flood tmux. Touch gestures use a separate path.
 */
export function mouseWheelReports(deltaY: number, deltaMode: number, rows: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  const units = Math.abs(deltaY) * (deltaMode === 1 ? 1 : deltaMode === 2 ? rows : 1 / 40);
  return Math.min(8, Math.max(2, Math.round(units * 2)));
}
