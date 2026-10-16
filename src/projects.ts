import fs from 'node:fs/promises';
import path from 'node:path';

/** A directory the sidebar groups sessions under; shared by every device. */
export interface Project { path: string; name: string }

const MAX_PROJECTS = 100;

export function validProjectName(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value);
}

function validProjects(value: unknown): value is Project[] {
  return Array.isArray(value) && value.length <= MAX_PROJECTS && value.every(item =>
    item && typeof item.path === 'string' && path.isAbsolute(item.path) && validProjectName(item.name));
}

/** Projects are edited one operation at a time, so two devices never overwrite each other's list. */
export class ProjectStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  private async read(): Promise<Project[]> {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!validProjects(data.projects)) throw new Error('Invalid saved projects');
      return data.projects;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async list(): Promise<Project[]> { await this.queue; return this.read(); }
  /** Apply one edit to the saved list and return the result. */
  update(edit: (projects: Project[]) => Project[]): Promise<Project[]> {
    const task = this.queue.then(async () => {
      const projects = edit(await this.read());
      if (!validProjects(projects)) throw new Error('Invalid projects');
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify({ projects }, null, 2), { mode: 0o600 });
      await fs.rename(temp, this.file);
      return projects;
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
