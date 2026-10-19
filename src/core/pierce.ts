import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { PIERCE_TIMEOUT_MS, REA_PACKAGE } from '../config.js';
import { detectCommand } from './detect.js';
import { scanEdges, type BoundaryHit } from './boundaries.js';
import { runAsync, extractJson } from '../util/spawn.js';
import { openOwnDb, readMeta, writeMeta } from '../db/own.js';
import { resolveProject } from '../util/paths.js';

export type PierceStatus = 'pierce-ok' | 'pierce-failed' | 'blocked' | 'cached';

export interface PierceResult {
  boundary: BoundaryHit;
  status: PierceStatus;
  result?: unknown;
  error?: string;
  guidance?: string[];
  cachedAt?: string;
  durationMs?: number;
}

export interface PierceRunner {
  (cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }>;
}

const defaultRunner: PierceRunner = async (cmd, args, timeoutMs) => {
  const r = await runAsync(cmd, args, timeoutMs);
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, error: r.error };
};

function findBoundary(projectPath: string, ref: string): BoundaryHit {
  const scan = scanEdges(projectPath);
  const hit =
    scan.boundaries.find((b) => b.id === ref) ??
    scan.boundaries.find((b) => b.path === ref.replace(/\\/g, '/')) ??
    scan.boundaries.find((b) => b.path.endsWith(ref.replace(/\\/g, '/')));
  if (!hit) {
    const list = scan.boundaries.map((b) => b.id).slice(0, 10).join(', ');
    throw new Error(`边界未找到: ${ref}（可用: ${list}${scan.boundaries.length > 10 ? ' …' : '，先用 codemap_edges 扫描'}）`);
  }
  return hit;
}

/**
 * P3 pierce（v2 §7）：对单个边界调 rea 穿透。
 * 铁律：rea 未安装 → 诚实返回 blocked + 安装指引（绝不静默 npm i -g）；
 * 结果按 boundaryId+内容哈希缓存进自家库；上游库零接触。
 */
export async function pierceBoundary(
  projectInput: string,
  boundaryRef: string,
  opts: { reaPath?: string; runner?: PierceRunner; timeoutMs?: number } = {},
): Promise<PierceResult> {
  const projectPath = resolveProject(projectInput);
  const boundary = findBoundary(projectPath, boundaryRef);
  const abs = path.join(projectPath, ...boundary.path.split('/'));

  // 缓存命中（内容哈希 = boundary 文件 sha256）
  let contentHash = '';
  try {
    contentHash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    /* 文件读不到就不走缓存 */
  }
  if (contentHash) {
    const db = openOwnDb(projectPath);
    try {
      const cached = readMeta(db, cacheKey(boundary.id, contentHash));
      if (cached) {
        return { boundary, status: 'cached', result: JSON.parse(cached), cachedAt: readMeta(db, cacheKey(boundary.id, contentHash) + ':at') ?? undefined };
      }
    } finally {
      try {
        db.close();
      } catch {
        /* 已关闭则忽略 */
      }
    }
  }

  const runner = opts.runner ?? defaultRunner;
  // 注入 runner 时不做 rea 探测（执行方由注入者负责）
  let cmd = 'rea';
  if (!opts.runner) {
    const probe = detectCommand('rea', { explicit: opts.reaPath ?? process.env.CODEMAP_REA_PATH, package: REA_PACKAGE });
    if (!probe.found) {
      return {
        boundary,
        status: 'blocked',
        guidance: [
          `rea 未安装（软依赖）—— 该边界 kind=${boundary.kind} 需要 rea 穿透`,
          `安装（明示后需你确认，绝不静默）: npm i -g ${REA_PACKAGE}`,
          `codegraph（硬依赖）与 rea 无关；未装 rea 不影响其余工具`,
        ],
      };
    }
    cmd = probe.path ?? 'rea';
  }
  const started = Date.now();
  const r = await runner(cmd, [boundary.reaCommand ?? 'inspect-artifact', abs, '--json'], opts.timeoutMs ?? PIERCE_TIMEOUT_MS);
  const durationMs = Date.now() - started;

  if (!r.ok) {
    const detail = r.error ?? r.stderr.trim().split(/\r?\n/).at(-1) ?? `exit ?`;
    return { boundary, status: 'pierce-failed', error: detail, durationMs };
  }
  let parsed: unknown;
  try {
    parsed = extractJson(r.stdout);
  } catch {
    return { boundary, status: 'pierce-failed', error: 'rea 输出无法解析为 JSON', durationMs };
  }
  if (contentHash) {
    const db = openOwnDb(projectPath);
    try {
      writeMeta(db, cacheKey(boundary.id, contentHash), JSON.stringify(parsed));
      writeMeta(db, cacheKey(boundary.id, contentHash) + ':at', new Date().toISOString());
    } finally {
      try {
        db.close();
      } catch {
        /* 已关闭则忽略 */
      }
    }
  }
  return { boundary, status: 'pierce-ok', result: parsed, durationMs };
}

function cacheKey(boundaryId: string, contentHash: string): string {
  return `pierce:${boundaryId}:${contentHash.slice(0, 16)}`;
}
