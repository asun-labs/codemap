import { CODEGRAPH_PACKAGE } from '../config.js';
import { detectCommand } from './detect.js';
import { extractionWhitelistCheck, getCodegraphStatus } from './codegraph-status.js';
import { readMirrorState, type MirrorState } from './mirror-state.js';
import { resolveProject } from '../util/paths.js';

export interface CheckIndexReport {
  projectPath: string;
  codegraph: { installed: boolean; path?: string; version?: string };
  index: {
    initialized: boolean;
    lastIndexed?: string | null;
    pendingChanges?: { added: number; modified: number; removed: number };
    extraction: { built?: number; current?: number; whitelistOk: boolean };
    reindexRecommended?: boolean;
  };
  mirror: MirrorState;
  guidance: string[];
}

/**
 * P0 check_index（v2 §7）：只检查不代跑——
 * 已索引？新鲜度（pendingChanges）？版本白名单？镜像 stale？
 * 绝不触发 init/index/sync（小时级任务不进 MCP），只返回指引。
 */
export async function checkIndex(
  projectInput?: string,
  opts: { codegraphPath?: string } = {},
): Promise<CheckIndexReport> {
  const projectPath = resolveProject(projectInput);
  const probe = detectCommand('codegraph', {
    explicit: opts.codegraphPath ?? process.env.CODEMAP_CODEGRAPH_PATH,
    package: CODEGRAPH_PACKAGE,
  });

  const guidance: string[] = [];
  let status: Awaited<ReturnType<typeof getCodegraphStatus>> | undefined;
  if (probe.found) {
    status = await getCodegraphStatus(projectPath, { codegraphPath: probe.path ?? 'codegraph' });
  }

  let initialized = false;
  let lastIndexed: string | null | undefined;
  let reindexRecommended: boolean | undefined;
  let extraction: CheckIndexReport['index']['extraction'] = { whitelistOk: false };

  if (!probe.found) {
    guidance.push(`缺少硬依赖 codegraph —— npm i -g ${CODEGRAPH_PACKAGE}（需确认后执行）`);
  } else if (!status || !status.available) {
    guidance.push(`codegraph status 不可用：${status?.error ?? probe.error}`);
  } else {
    initialized = status.initialized === true;
    lastIndexed = status.lastIndexed ?? null;
    reindexRecommended = status.index?.reindexRecommended;
    const wl = extractionWhitelistCheck(status);
    extraction = {
      built: status.index?.builtWithExtractionVersion,
      current: status.index?.currentExtractionVersion,
      whitelistOk: wl.ok,
    };
    if (!initialized) {
      guidance.push('工程未索引 —— 终端运行 codegraph init <path>（小时级任务，CodeMap 不代跑）');
    } else {
      if (!wl.ok && wl.reason) guidance.push(wl.reason);
      const pend = status.pendingChanges;
      if (pend && pend.added + pend.modified + pend.removed > 0) {
        guidance.push(`索引落后于源码（+${pend.added} ~${pend.modified} -${pend.removed}）—— 终端运行 codegraph sync <path>`);
      }
    }
  }

  const mirror = readMirrorState(projectPath, status);
  if (initialized) {
    if (!mirror.present) {
      guidance.push(`运行 codemap mirror ${projectPath} 生成镜像`);
    } else if (mirror.stale) {
      guidance.push(`重新运行 codemap mirror ${projectPath} 重建镜像（${mirror.staleReasons.join('；')}）`);
    }
  }
  if (guidance.length === 0) guidance.push('索引与镜像均新鲜');

  return {
    projectPath,
    codegraph: { installed: probe.found, path: probe.path, version: status?.version },
    index: { initialized, lastIndexed, pendingChanges: status?.pendingChanges, extraction, reindexRecommended },
    mirror,
    guidance,
  };
}

export function renderCheckText(r: CheckIndexReport): string {
  const L: string[] = [];
  L.push(`CodeMap check — ${r.projectPath}`);
  L.push(
    `codegraph   ${r.codegraph.installed ? `✓ ${r.codegraph.version ?? '?'}` : '✗ 未安装'}`,
  );
  L.push(
    `index       ${r.index.initialized ? '✓ 已初始化' : '✗ 未初始化'}${r.index.lastIndexed ? ` · lastIndexed ${r.index.lastIndexed}` : ''}`,
  );
  if (r.index.pendingChanges) {
    const p = r.index.pendingChanges;
    L.push(`pending     +${p.added} ~${p.modified} -${p.removed}`);
  }
  L.push(
    `extraction  built v${r.index.extraction.built ?? '?'} / current v${r.index.extraction.current ?? '?'} · 白名单 ${r.index.extraction.whitelistOk ? '✓' : '✗'}`,
  );
  const m = r.mirror;
  L.push(
    `mirror      ${m.present ? (m.stale ? `⚠ stale（${m.staleReasons.join('；')}）` : '✓ 新鲜') : '– 不存在'}${m.mirroredAt ? ` · mirrored ${m.mirroredAt}` : ''}`,
  );
  L.push('');
  L.push('指引:');
  for (const g of r.guidance) L.push(`  - ${g}`);
  return L.join('\n');
}
