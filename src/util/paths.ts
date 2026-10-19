import * as fs from 'node:fs';
import * as path from 'node:path';
import { CODEMAP_DIR, CODEGRAPH_DIR, OWN_DB_FILE, UPSTREAM_DB_FILE } from '../config.js';

/** 解析工程路径：缺省 = 当前工作目录；必须是存在的目录 */
export function resolveProject(p?: string): string {
  const resolved = path.resolve(p && p.trim() ? p : process.cwd());
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`工程路径不存在或不是目录: ${resolved}`);
  }
  return resolved;
}

export const codemapDir = (project: string): string => path.join(project, CODEMAP_DIR);
export const ownDbPath = (project: string): string => path.join(codemapDir(project), OWN_DB_FILE);
export const upstreamDbPath = (project: string): string => path.join(project, CODEGRAPH_DIR, UPSTREAM_DB_FILE);

export function ownDbExists(project: string): boolean {
  return fs.existsSync(ownDbPath(project));
}

/** 删除自家镜像的 db / -wal / -shm（绝不碰上游） */
export function removeOwnDbFiles(project: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = ownDbPath(project) + suffix;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
}
