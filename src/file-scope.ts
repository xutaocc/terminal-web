import fs from 'node:fs/promises';
import path from 'node:path';
import { within } from './file-api.js';
export class FileScopeError extends Error {}
export interface FileScope { root: string; owner: string; writable: boolean; authorize(): boolean }
/** Validate both lexical paths and resolved filesystem paths, including nonexistent destinations. */
export async function checkFileScope(scope: FileScope, value: string, mutation = false, deep = false): Promise<void> {
  if (!scope.authorize() || (mutation && !scope.writable)) throw new FileScopeError('文件操作权限已关闭或失效');
  const root = path.resolve(scope.root), target = path.resolve(value);
  if (!within(target, root) || path.resolve(await fs.realpath(root)) !== root) throw new FileScopeError('不能访问分享目录之外的路径');
  let current = target;
  while (true) {
    try {
      const stat = await fs.lstat(current);
      const real = await fs.realpath(current);
      if (!within(real, root)) throw new FileScopeError('链接指向分享目录之外');
      // Mutations never follow links (including hard-linked files) into other ownership domains.
      if (mutation && (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))) throw new FileScopeError('分享写操作不支持链接文件');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (current === root) throw error;
      current = path.dirname(current);
    }
  }
  // Detect linked ancestors too, even when their target currently happens to be inside the root.
  if (mutation) for (let p = path.dirname(target); within(p, root); p = path.dirname(p)) {
    if ((await fs.lstat(p)).isSymbolicLink()) throw new FileScopeError('分享写操作不支持链接目录');
    if (p === root) break;
  }
  if (deep) {
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) for (const name of await fs.readdir(target)) await checkFileScope(scope, path.join(target, name), mutation, true);
  }
}
