import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSync, extractJson } from '../util/spawn.js';

export type ProbeSource = 'explicit' | 'path' | 'npm-prefix-shim' | 'npm-global-list';

export interface CommandProbe {
  name: string;
  found: boolean;
  path?: string;
  source?: ProbeSource;
  error?: string;
}

/** Windows 上可执行后缀的优先级（.ps1 不能直接 spawn，排最后） */
const WIN_EXT_PRIORITY = ['.cmd', '.exe', '.bat', '.ps1', ''];

function basename(p: string): string {
  return path.basename(p.trim());
}

function pickWindowsCandidate(lines: string[], name: string): string | undefined {
  for (const ext of WIN_EXT_PRIORITY) {
    const hit = lines.find((l) => basename(l).toLowerCase() === (name + ext).toLowerCase());
    if (hit) return hit.trim();
  }
  return lines.map((l) => l.trim()).find((l) => basename(l).toLowerCase().startsWith(name.toLowerCase()));
}

/** 第 2 步：PATH 探测（where.exe / which） */
function probePath(name: string): string | undefined {
  const r = process.platform === 'win32' ? runSync('where.exe', [name], 5_000) : runSync('which', [name], 5_000);
  if (!r.ok) return undefined;
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  if (process.platform === 'win32') return pickWindowsCandidate(lines, name);
  return lines[0]?.trim();
}

/**
 * 第 3 步：npm prefix -g 下的 bin shim。
 * v1 方案写的是 npm root -g，是错的——shim 在 prefix 根目录
 * （实测：C:\nvm\nodejs\codegraph.ps1，而 npm root -g 指向其下的 node_modules）。
 */
function probeNpmPrefixShim(name: string): string | undefined {
  const r = runSync('npm', ['prefix', '-g'], 10_000);
  if (!r.ok) return undefined;
  const prefix = r.stdout.trim().split(/\r?\n/).at(-1)?.trim();
  if (!prefix) return undefined;
  const candidates =
    process.platform === 'win32'
      ? [path.join(prefix, `${name}.cmd`), path.join(prefix, `${name}.ps1`), path.join(prefix, name)]
      : [path.join(prefix, 'bin', name), path.join(prefix, name)];
  return candidates.find((c) => fs.existsSync(c));
}

/** 第 4 步：npm ls -g 确认包在册（只读查询，绝不下载） */
function probeNpmGlobalList(packageName: string): boolean {
  const r = runSync('npm', ['ls', '-g', '--depth=0', '--json'], 20_000);
  if (!r.ok) return false;
  const json = extractJson(r.stdout) as
    | { dependencies?: Record<string, { dependencies?: Record<string, unknown> }> }
    | undefined;
  const deps = json?.dependencies;
  if (!deps) return false;
  if (deps[packageName]) return true;
  const [scope, name] = packageName.split('/');
  if (!scope?.startsWith('@') || !name) return false;
  const scoped = deps[scope];
  return Boolean(scoped?.dependencies?.[name]);
}

/**
 * 四步探测（v2 §4.1）：
 * 显式路径 → PATH → npm prefix -g shim → npm ls -g。
 * 全部只是「找」，找不到就报告；存在性检查禁止 npx -y（会静默下载，违反铁律 1）。
 */
export function detectCommand(name: string, opts: { explicit?: string; package?: string } = {}): CommandProbe {
  if (opts.explicit) {
    if (fs.existsSync(opts.explicit)) return { name, found: true, path: opts.explicit, source: 'explicit' };
    return { name, found: false, error: `显式路径不存在: ${opts.explicit}` };
  }
  const viaPath = probePath(name);
  if (viaPath) return { name, found: true, path: viaPath, source: 'path' };
  const viaShim = probeNpmPrefixShim(name);
  if (viaShim) return { name, found: true, path: viaShim, source: 'npm-prefix-shim' };
  if (opts.package && probeNpmGlobalList(opts.package)) {
    return { name, found: true, source: 'npm-global-list' };
  }
  return { name, found: false, error: '未找到（已探测 PATH、npm prefix -g shim、npm ls -g）' };
}
