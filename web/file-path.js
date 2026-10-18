/**
 * Paths on the server the file browser is looking at. That server may be a
 * Unix host ("/home/x") or a Windows one ("C:\Users\x"), and this page can show
 * either — a remote's files are browsed through this server — so every helper
 * reads the style from the path itself, never from the browser's platform.
 *
 * Windows paths are kept with backslashes, as the server reports them; any
 * forward slash typed or pasted is accepted and turned into one.
 */

const DRIVE = /^[A-Za-z]:([\\/]|$)/;

export function isWindowsPath(p) { return DRIVE.test(p); }

/** "/x" or "C:\x" (or "C:/x"); a relative or empty path is not absolute. */
export function isAbsolutePath(p) { return typeof p === 'string' && (p.startsWith('/') || DRIVE.test(p)); }

function separator(p) { return isWindowsPath(p) ? '\\' : '/'; }

/** One spelling per path: "C:\a\b" for "c:/a//b\\", "/a/b" for "/a//b/". */
export function normalizePath(p) {
  if (isWindowsPath(p)) {
    const parts = p.slice(2).split(/[\\/]+/).filter(Boolean);
    return `${p[0].toUpperCase()}:\\${parts.join('\\')}`;
  }
  return '/' + p.split('/').filter(Boolean).join('/');
}

/** The filesystem root a path sits under: "/" or "C:\". */
export function rootOf(p) { return isWindowsPath(p) ? `${p[0].toUpperCase()}:\\` : '/'; }

export function isRoot(p) { return normalizePath(p) === rootOf(p); }

/** The containing directory; a root is its own parent. */
export function parentPath(p) {
  const path = normalizePath(p), root = rootOf(path);
  if (path === root) return root;
  const cut = path.lastIndexOf(separator(path));
  return cut < root.length ? root : path.slice(0, cut);
}

export function childPath(p, name) {
  const path = normalizePath(p);
  return path === rootOf(path) ? path + name : path + separator(path) + name;
}

/** The last segment, or the root itself ("/" / "C:\") for a root. */
export function baseName(p) {
  const path = normalizePath(p);
  return path === rootOf(path) ? path : path.slice(path.lastIndexOf(separator(path)) + 1);
}

/** Windows compares paths case-insensitively; Unix does not. */
function sameText(a, b, windows) { return windows ? a.toLowerCase() === b.toLowerCase() : a === b; }

export function samePath(a, b) {
  const x = normalizePath(a), y = normalizePath(b);
  return isWindowsPath(x) === isWindowsPath(y) && sameText(x, y, isWindowsPath(x));
}

/** True for the ancestor itself or anything below it. */
export function isWithin(p, ancestor) {
  const path = normalizePath(p), base = normalizePath(ancestor);
  if (isWindowsPath(path) !== isWindowsPath(base)) return false;
  const windows = isWindowsPath(path);
  if (sameText(path, base, windows)) return true;
  const prefix = base === rootOf(base) ? base : base + separator(base);
  return sameText(path.slice(0, prefix.length), prefix, windows);
}

/**
 * Breadcrumb segments, each with the path it leads to: the root first ("/" or
 * "C:\"), then one per directory down to `p`.
 */
export function crumbs(p) {
  const path = normalizePath(p), root = rootOf(path);
  const out = [{ label: root, path: root }];
  let at = root;
  for (const part of path.slice(root.length).split(separator(path)).filter(Boolean)) {
    at = childPath(at, part);
    out.push({ label: part, path: at });
  }
  return out;
}

/** Path segments below the root, for "is any part hidden" checks. */
export function segments(p) {
  const path = normalizePath(p);
  return path.slice(rootOf(path).length).split(separator(path)).filter(Boolean);
}
