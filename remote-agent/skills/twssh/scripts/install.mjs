#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const [target = 'codex', custom] = process.argv.slice(2);
const roots = {
  codex: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills'),
  claude: path.join(os.homedir(), '.claude', 'skills')
};
if (!(target in roots) && target !== 'dir') {
  console.error('用法：node scripts/install.mjs [codex|claude|dir /绝对路径/skills]');
  process.exit(1);
}
if (target === 'dir' && (!custom || !path.isAbsolute(custom))) {
  console.error('dir 需要 skills 目录的绝对路径。'); process.exit(1);
}
const dest = path.resolve(target === 'dir' ? custom : roots[target], 'twssh');
if (path.resolve(source) !== dest) {
  if (fs.existsSync(dest)) {
    const backup = `${dest}.backup-${Date.now()}`;
    // Keep backups outside skills discovery directories.
    const backupDir = path.join(path.dirname(path.dirname(dest)), 'skill-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const saved = path.join(backupDir, path.basename(backup));
    fs.cpSync(dest, saved, { recursive: true, errorOnExist: true, force: false });
    console.log(`旧版本备份：${saved}`);
  }
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(source, dest, { recursive: true });
}
console.log(`已安装：${dest}\n无需 npm install 或全局 twssh。重新加载技能或开启新对话后使用 twssh skill。\n请在实际工作目录初始化 .twssh/connections.json；安装不会修改项目连接配置或旧全局配置。`);
