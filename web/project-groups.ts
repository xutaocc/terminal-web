/** A sidebar folder: a named group the user puts sessions in. No path. */
export interface FolderInfo { id: string; name: string }

export interface FolderGroup<T> {
  /** The folder's id, or '' for sessions in no folder. */
  key: string;
  folder: FolderInfo | null;
  items: T[];
}

/**
 * Every folder in its saved order, then the sessions in none. A folder holds
 * exactly the sessions the user put there — where they are working has nothing
 * to do with it. Items keep their relative order inside each group.
 */
export function groupByFolder<T>(
  items: readonly T[], nameOf: (item: T) => string,
  folders: readonly FolderInfo[], members: Readonly<Record<string, string>>,
): FolderGroup<T>[] {
  const groups = new Map<string, FolderGroup<T>>();
  for (const folder of folders) groups.set(folder.id, { key: folder.id, folder, items: [] });
  const loose: FolderGroup<T> = { key: '', folder: null, items: [] };
  for (const item of items) (groups.get(members[nameOf(item)] ?? '') ?? loose).items.push(item);
  return loose.items.length ? [...groups.values(), loose] : [...groups.values()];
}

/** Whether moving these sessions out would leave their folder empty (and so delete it). */
export function wouldEmpty(folderId: string, leaving: readonly string[], members: Readonly<Record<string, string>>): boolean {
  if (!folderId) return false;
  const gone = new Set(leaving);
  return !Object.entries(members).some(([session, id]) => id === folderId && !gone.has(session));
}

/** Whether `dir` is `root` itself or somewhere beneath it. */
function within(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** A session's directory as the card shows it: with ~ for home. */
export function shortCwd(cwd: string | null | undefined, home: string): string {
  if (!cwd) return '';
  if (home && within(cwd, home)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

export interface DirectoryGroup<T> {
  /** The exact working directory, or '' when it is not known. */
  cwd: string;
  items: T[];
}

/** Split a folder's items by exact directory, in order of first appearance. */
export function groupByDirectory<T>(items: readonly T[], cwdOf: (item: T) => string | null | undefined): DirectoryGroup<T>[] {
  const groups = new Map<string, DirectoryGroup<T>>();
  for (const item of items) {
    const cwd = cwdOf(item) ?? '';
    let group = groups.get(cwd);
    if (!group) groups.set(cwd, group = { cwd, items: [] });
    group.items.push(item);
  }
  return [...groups.values()];
}
