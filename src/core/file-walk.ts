import * as fs from 'node:fs';
import * as path from 'node:path';

export const WALK_CAP = 30_000;
export const SKIP_DIRS = new Set(['.git', '.codemap', '.codegraph', '.svn', '.next']);

export interface WalkStats {
  files: number;
  truncated: boolean;
}

/**
 * 共享文件遍历（有界）：onFile 对每个文件回调，skipDir 决定目录剪枝。
 * 超过 WALK_CAP 立即停止并标 truncated——绝不静默扫全盘。
 */
export function walkFiles(
  root: string,
  onFile: (fp: string) => void,
  skipDir: (name: string) => boolean = () => false,
): WalkStats {
  const stack: string[] = [root];
  let files = 0;
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++files > WALK_CAP) return { files, truncated: true };
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !skipDir(e.name)) stack.push(fp);
      } else if (e.isFile()) {
        onFile(fp);
      }
    }
  }
  return { files, truncated: false };
}

export function toRelPath(root: string, fp: string): string {
  const rel = path.relative(root, fp).replace(/\\/g, '/');
  return rel.startsWith('..') ? fp.replace(/\\/g, '/') : rel;
}
