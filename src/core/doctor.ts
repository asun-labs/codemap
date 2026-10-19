import { CODEGRAPH_PACKAGE, REA_PACKAGE } from '../config.js';
import { detectCommand, type CommandProbe } from './detect.js';
import { getCodegraphStatus, type CodegraphStatus } from './codegraph-status.js';
import { readMirrorState, type MirrorState } from './mirror-state.js';
import { computeProjectCoverage, type Coverage } from './coverage.js';
import { openOwnDb } from '../db/own.js';
import { resolveProject } from '../util/paths.js';

export interface DoctorReport {
  projectPath: string;
  node: { version: string; nodeSqlite: boolean };
  codegraph: CommandProbe & { version?: string; status?: CodegraphStatus };
  rea: CommandProbe;
  mirror: MirrorState;
  coverage: Coverage;
  hints: string[];
  /** 硬依赖是否满足（决定 CLI 退出码） */
  ok: boolean;
}

/** P0 doctor：依赖体检 + 索引新鲜度 + 镜像状态 + 覆盖评级（v2 §4.4） */
export async function runDoctor(
  projectInput?: string,
  opts: { codegraphPath?: string } = {},
): Promise<DoctorReport> {
  const projectPath = resolveProject(projectInput);
  const nodeSqlite = await checkNodeSqlite();

  const cgProbe = detectCommand('codegraph', {
    explicit: opts.codegraphPath ?? process.env.CODEMAP_CODEGRAPH_PATH,
    package: CODEGRAPH_PACKAGE,
  });
  let status: CodegraphStatus | undefined;
  if (cgProbe.found) {
    // 一次 status --json 同时拿到 version + 索引状态（不再单独 --version）
    status = await getCodegraphStatus(projectPath, { codegraphPath: cgProbe.path ?? 'codegraph' });
  }
  const reaProbe = detectCommand('rea', { package: REA_PACKAGE });
  const mirror = readMirrorState(projectPath, status);

  let coverage: Coverage = { resolved: 0, unresolved: 0, ratio: null, state: 'unavailable' };
  if (mirror.present) {
    const db = openOwnDb(projectPath);
    try {
      coverage = computeProjectCoverage(db);
    } finally {
      try {
        db.close();
      } catch {
        /* 已关闭则忽略 */
      }
    }
  }

  const hints: string[] = [];
  if (!cgProbe.found) {
    hints.push(`缺少硬依赖 codegraph —— npm i -g ${CODEGRAPH_PACKAGE}（明示后需你确认，绝不静默安装）`);
  } else if (status && !status.available) {
    hints.push(`codegraph status 失败：${status.error}`);
  } else if (status && !status.initialized) {
    hints.push('工程未索引 —— 终端执行 codegraph init（小时级任务，CodeMap 不代跑）');
  }
  const pend = status?.pendingChanges;
  if (pend && pend.added + pend.modified + pend.removed > 0) {
    hints.push(`索引有待同步变更（+${pend.added} ~${pend.modified} -${pend.removed}）—— 终端执行 codegraph sync`);
  }
  if (status?.initialized && !mirror.present) {
    hints.push(`生成镜像 —— codemap mirror ${projectPath}`);
  }
  if (mirror.present && mirror.stale) {
    hints.push(`镜像已过期（${mirror.staleReasons.join('；')}）—— 重新运行 codemap mirror ${projectPath}`);
  }
  if (!reaProbe.found) {
    hints.push('rea 未安装（软依赖，不阻塞）—— P2 起边界扫描会列出哪些二进制需要它；届时按需安装：npm i -g rea-agents');
  }

  return {
    projectPath,
    node: { version: process.version, nodeSqlite },
    codegraph: { ...cgProbe, version: status?.version, status },
    rea: reaProbe,
    mirror,
    coverage,
    hints,
    ok: cgProbe.found,
  };
}

async function checkNodeSqlite(): Promise<boolean> {
  try {
    const m = (await import('node:sqlite')) as { DatabaseSync?: unknown };
    return typeof m.DatabaseSync === 'function';
  } catch {
    return false;
  }
}

export function renderDoctorText(r: DoctorReport): string {
  const L: string[] = [];
  L.push(`CodeMap doctor — ${r.projectPath}`);
  L.push(
    `node        ${r.node.nodeSqlite ? '✓' : '✗'} ${r.node.version}${r.node.nodeSqlite ? '（node:sqlite 可用）' : '（缺 node:sqlite，需 Node ≥ 22.5）'}`,
  );
  if (r.codegraph.found) {
    L.push(`codegraph   ✓ ${r.codegraph.version ?? '版本未知'}  (${r.codegraph.path ?? r.codegraph.source ?? '?'})`);
    const s = r.codegraph.status;
    if (!s || !s.available) {
      L.push(`            ✗ status 失败：${s?.error ?? r.codegraph.error ?? 'unknown'}`);
    } else if (s.initialized) {
      L.push(
        `            ✓ 本项目已索引  extraction v${s.index?.builtWithExtractionVersion ?? '?'} · ${fmtNum(s.nodeCount)} nodes · lastIndexed ${s.lastIndexed ?? '?'}`,
      );
    } else {
      L.push('            ✗ 本项目未索引 —— 终端执行 codegraph init');
    }
  } else {
    L.push(`codegraph   ✗ 未安装 —— npm i -g ${CODEGRAPH_PACKAGE}（需确认后执行）`);
  }

  if (r.mirror.present) {
    const flag = r.mirror.stale ? '⚠' : '✓';
    L.push(
      `${flag} 镜像       ${flag === '⚠' ? '已过期' : '新鲜'}    mirrored ${r.mirror.mirroredAt ?? '?'}（extraction v${r.mirror.extractionVersion ?? '?'}）`,
    );
    if (r.mirror.stale) {
      for (const reason of r.mirror.staleReasons) L.push(`              · ${reason}`);
    }
  } else {
    L.push('–  镜像       不存在 —— codemap mirror <path>');
  }

  if (r.rea.found) {
    L.push(`rea         ✓ ${r.rea.path ?? r.rea.source}`);
  } else {
    L.push('rea         – 未安装（软依赖，不阻塞；P2 边界扫描会给出哪些二进制需要它）');
  }

  if (r.coverage.ratio != null) {
    L.push(
      `覆盖评级    ${r.coverage.state}（resolved ${fmtNum(r.coverage.resolved)} / unresolved ${fmtNum(r.coverage.unresolved)} → ${(r.coverage.ratio * 100).toFixed(1)}%）`,
    );
  } else {
    L.push(`覆盖评级    ${r.coverage.state}`);
  }

  if (r.hints.length > 0) {
    L.push('');
    L.push('提示:');
    for (const h of r.hints) L.push(`  - ${h}`);
  }
  return L.join('\n');
}

function fmtNum(n: number | undefined): string {
  return n == null ? '?' : n.toLocaleString('en-US');
}
