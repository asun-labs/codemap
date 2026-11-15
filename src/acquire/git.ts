import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { runAsync, type SpawnResult } from '../util/spawn.js';

/** 远端地址的形态判定：http(s):// 、git@ 、ssh:// 、.git 结尾 */
export function looksLikeGitUrl(input: string): boolean {
  if (/^git@[\w.-]+:[\w.\-/]+?\.git$/.test(input)) return true;
  if (/^ssh:\/\/.+/.test(input)) return true;
  if (/^git:\/\/.+/.test(input)) return true;
  try {
    const u = new URL(input);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // 本机路径不会解析成 http URL；剩下看是否像仓库地址
    return true;
  } catch {
    return false;
  }
}

/** 从 clone 地址推出仓库名（用于展示与目录名） */
export function repoNameFromUrl(url: string): string {
  const cleaned = url.replace(/[#?].*$/, '').replace(/\/+$/, '');
  const base = cleaned.split(/[/\\:]/).pop() ?? 'repo';
  return base.replace(/\.git$/i, '') || 'repo';
}

export interface AcquireInput {
  /** 本地路径或 git 地址 */
  target: string;
  /** 克隆根目录，默认 <cwd>/.codemap/work */
  workRoot?: string;
  /** 指定分支/标签/commit */
  ref?: string;
  /** 已有工作区时强制重新克隆 */
  force?: boolean;
  /** 浅克隆深度，默认 1（只看结构，不需要历史） */
  depth?: number;
  /** 克隆时是否带上子模块，默认 true */
  recurseSubmodules?: boolean;
  /** 网络操作的超时 */
  timeoutMs?: number;
}

export interface Acquired {
  kind: 'local' | 'git';
  /** 分析根（绝对路径） */
  root: string;
  source: string;
  cloned: boolean;
  git?: { branch: string | null; commit: string | null; remote: string | null; dirty: boolean };
  notes: string[];
}

/** 工作区目录名：仓库名 + url 短哈希，保证同一地址稳定复用 */
export function workDirFor(workRoot: string, url: string): string {
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
  return path.join(workRoot, `${repoNameFromUrl(url)}-${hash}`);
}

/**
 * 获取被分析代码：本地目录直接用；远端地址克隆到工作区。
 * 克隆遵循「绝不静默」——命令与目标目录都会打印到 stderr，由调用方呈现。
 */
export async function acquire(
  input: AcquireInput,
  log: (msg: string) => void = () => {},
): Promise<Acquired> {
  const notes: string[] = [];
  const target = input.target.trim();
  if (target === '') throw new Error('目标为空：请给出本地路径或 git 地址');

  if (!looksLikeGitUrl(target)) {
    const abs = path.resolve(target);
    if (!fs.existsSync(abs)) throw new Error(`本地路径不存在: ${abs}`);
    if (!fs.statSync(abs).isDirectory()) throw new Error(`不是目录: ${abs}`);
    const git = await readGitInfo(abs);
    return { kind: 'local', root: abs, source: abs, cloned: false, git, notes };
  }

  // 默认放系统临时目录：克隆目录绝不能落在某个已注册 codegraph 的项目里，
  // 否则 codegraph 会沿目录向上找到那个项目、把索引进错库
  const workRoot = input.workRoot ?? defaultWorkRoot();
  fs.mkdirSync(workRoot, { recursive: true });
  const dest = workDirFor(workRoot, target);

  if (fs.existsSync(dest)) {
    if (input.force) {
      log(`[codemap] 移除旧工作区 ${dest}`);
      fs.rmSync(dest, { recursive: true, force: true });
    } else {
      notes.push(`复用已有克隆: ${dest}（加 --force 可重新克隆）`);
      const git = await readGitInfo(dest);
      return { kind: 'git', root: dest, source: target, cloned: false, git, notes };
    }
  }

  const depth = input.depth ?? 1;
  // 只带子模块开关、不带 --recurse-submodules 时，git 只是记录开关而不实际拉取，
  // 省钱且够用（我们要的结构在超级工程里）；需要子模块内容时再 `git submodule update`。
  const opts: string[] = [];
  if (input.recurseSubmodules !== false) opts.push('--recurse-submodules');
  const args = ['clone', ...opts];
  if (depth > 0) args.push('--depth', String(depth));
  if (input.ref) args.push('--branch', input.ref);
  args.push('--', target, dest);

  log(`[codemap] git ${args.join(' ')}`);
  const r = await runAsync('git', args, input.timeoutMs ?? 15 * 60_000);
  if (!r.ok) {
    // 浅克隆失败（某些服务端不支持）时退回全量克隆一次
    const full = ['clone', ...opts];
    if (input.ref) full.push('--branch', input.ref);
    full.push('--', target, dest);
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    log(`[codemap] 浅克隆失败，退回全量: git ${full.join(' ')}`);
    const r2 = await runAsync('git', full, input.timeoutMs ?? 30 * 60_000);
    if (!r2.ok) {
      throw new Error(`git clone 失败: ${describeFailure(r2) || describeFailure(r)}`);
    }
    notes.push('浅克隆不可用，已改为全量克隆');
  }
  const git = await readGitInfo(dest);
  return { kind: 'git', root: dest, source: target, cloned: true, git, notes };
}

function describeFailure(r: SpawnResult): string {
  const text = (r.stderr || r.stdout || r.error || '').trim();
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !/^\s*$/.test(l));
  return lines.slice(-3).join(' | ');
}

/** 读 git 元信息；非 git 仓库返回 undefined（调用方据此决定是否标注） */
export async function readGitInfo(dir: string): Promise<Acquired['git']> {
  const g = path.join(dir, '.git');
  if (!fs.existsSync(g)) return undefined;
  const [branch, commit, remote, status] = await Promise.all([
    runAsync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], 10_000),
    runAsync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], 10_000),
    runAsync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], 10_000),
    runAsync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no'], 15_000),
  ]);
  return {
    branch: branch.ok ? branch.stdout.trim() || null : null,
    commit: commit.ok ? commit.stdout.trim() || null : null,
    remote: remote.ok ? remote.stdout.trim() || null : null,
    dirty: status.ok ? status.stdout.trim() !== '' : false,
  };
}

/** 默认工作区根目录 */
export function defaultWorkRoot(): string {
  return path.join(os.tmpdir(), 'codemap-work');
}
