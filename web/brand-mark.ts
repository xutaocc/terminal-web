/**
 * The product mark: a small prompt glyph, WebTerminal in bold and the owner in
 * grey, in a quiet pill. Shared by the PC sidebar's top-left corner and the
 * phone's sheet headers, so both always look the same.
 */
export function brandMark(extraClass = ''): HTMLElement {
  const mark = document.createElement('span');
  mark.className = extraClass ? `brand-mark ${extraClass}` : 'brand-mark';
  mark.setAttribute('aria-label', 'WebTerminal xutaocc');
  const glyph = document.createElement('span');
  glyph.className = 'brand-glyph';
  glyph.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 4.5 3.5 3.5L3 11.5M8.5 11.5H13"/></svg>';
  const name = document.createElement('b');
  name.textContent = 'WebTerminal';
  const owner = document.createElement('span');
  owner.className = 'brand-owner';
  owner.textContent = 'xutaocc';
  mark.append(glyph, name, owner);
  return mark;
}
