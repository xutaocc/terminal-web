/**
 * What depends on which system a server runs, for a page that can show several
 * servers at once — a Mac page driving a Windows remote, or the other way round.
 * Everything here goes by the server's reported platform (GET /api/host-info),
 * or by the path itself, never by the browser's own system.
 */

/** Node's process.platform values that mean Windows. */
export function isWindowsPlatform(platform: string | undefined): boolean {
  return platform === 'win32';
}

/**
 * A path as an argument at that server's prompt. Unchanged when it needs no
 * quoting. Windows terminals run PowerShell (see src/tmux.ts), which takes
 * single quotes with '' for a quote inside; Unix shells take single quotes with
 * '\'' for one.
 */
export function quotePathForShell(p: string, platform: string | undefined): string {
  if (isWindowsPlatform(platform)) {
    return /[\s'"`$&;(){}@#,|<>]/.test(p) ? `'${p.replace(/'/g, "''")}'` : p;
  }
  return /\s|'/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
}

/** The last segment of a Unix or Windows path ("C:\a\b.txt" -> "b.txt"). */
export function lastSegment(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

/**
 * A directory as a card shows it: under the home directory it starts with "~",
 * in that path's own separator ("~/src", "~\Desktop"). Windows compares case-
 * insensitively, as its file system does.
 */
export function homeRelative(cwd: string, home: string): string {
  if (!cwd || !home) return cwd;
  const windows = /^[A-Za-z]:[\\/]/.test(home);
  const sep = windows ? '\\' : '/';
  const trim = (s: string) => (s.length > 1 && /[\\/]$/.test(s) && !/^[A-Za-z]:[\\/]$/.test(s) ? s.slice(0, -1) : s);
  const base = trim(home), dir = trim(cwd);
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(dir, base)) return '~';
  const prefix = base.endsWith(sep) ? base : base + sep;
  return same(dir.slice(0, prefix.length), prefix) ? `~${sep}${dir.slice(prefix.length)}` : cwd;
}

/** A short label for a platform: "Windows", "macOS", "Linux", or the raw value. */
export function platformLabel(platform: string | undefined): string {
  switch (platform) {
    case 'win32': return 'Windows';
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    case undefined: case '': return '';
    default: return platform;
  }
}
