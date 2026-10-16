/** A directory the sidebar files sessions under. */
export interface ProjectInfo { path: string; name: string }

export interface ProjectGroup<T> {
  /** The project's path, or '' for sessions that belong to no project. */
  key: string;
  project: ProjectInfo | null;
  items: T[];
}

/** Whether `dir` is `root` itself or somewhere beneath it. */
function within(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/**
 * The project a working directory belongs to: the deepest one containing it,
 * so a project nested inside another claims its own sessions. '' when none does.
 */
export function projectKeyOf(cwd: string | null | undefined, projects: readonly ProjectInfo[]): string {
  if (!cwd) return '';
  let best = '';
  for (const p of projects) {
    if (p.path.length > best.length && within(cwd, p.path)) best = p.path;
  }
  return best;
}

/**
 * Every project in its saved order — empty ones too, so a new project shows up
 * before anything runs in it — then the sessions no project claims, if any.
 * Items keep their relative order inside each group.
 */
export function groupByProject<T>(
  items: readonly T[], cwdOf: (item: T) => string | null | undefined, projects: readonly ProjectInfo[],
): ProjectGroup<T>[] {
  const groups = new Map<string, ProjectGroup<T>>();
  for (const project of projects) groups.set(project.path, { key: project.path, project, items: [] });
  const other: ProjectGroup<T> = { key: '', project: null, items: [] };
  for (const item of items) {
    (groups.get(projectKeyOf(cwdOf(item), projects)) ?? other).items.push(item);
  }
  return other.items.length ? [...groups.values(), other] : [...groups.values()];
}

/** A session's directory as the card shows it: relative to its project, or with ~ for home. */
export function shortCwd(cwd: string | null | undefined, projectPath: string, home: string): string {
  if (!cwd) return '';
  if (projectPath && within(cwd, projectPath)) {
    const rest = cwd.slice(projectPath.length).replace(/^\//, '');
    return rest ? `./${rest}` : projectPath.split('/').filter(Boolean).pop() ?? projectPath;
  }
  if (home && within(cwd, home)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

export interface DirectoryGroup<T> {
  /** The exact working directory, or '' when it is not known. */
  cwd: string;
  items: T[];
}

/** Split a project's items by exact directory, in order of first appearance. */
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
