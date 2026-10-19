import type { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import {
  extractionWhitelistCheck,
  getCodegraphStatus,
  type CodegraphStatus,
} from '../core/codegraph-status.js';
import { openUpstreamReadonly } from './readonly.js';
import { openOwnDb, writeMeta } from './own.js';
import { removeOwnDbFiles, upstreamDbPath } from '../util/paths.js';

export type MirrorErrorCode =
  | 'status-failed'
  | 'not-initialized'
  | 'extraction-mismatch'
  | 'upstream-missing';

export class MirrorError extends Error {
  constructor(
    public code: MirrorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MirrorError';
  }
}

export interface MirrorCounts {
  nodes: number;
  edges: number;
  unresolvedRefs: number;
  files: number;
}

export interface BuildMirrorResult {
  projectPath: string;
  mirroredAt: string;
  extractionVersion: number;
  codegraphVersion?: string;
  counts: MirrorCounts;
  durationMs: number;
  copiedAside: boolean;
}

interface CopySpec {
  table: string;
  columns: string[];
  insert: string;
}

/**
 * 镜像 ETL（v2 §3.3）：status 校验白名单 → 只读打开上游 → 全量导 L0–L2 进 .codemap/codemap.db。
 * 上游节点 id 随挪行变化（已核对 generateNodeId），故不做 id 级增量，全量重建；
 * 10 万节点量级预算 < 60s。
 */
export async function buildMirror(
  projectPath: string,
  opts: { status?: CodegraphStatus } = {},
): Promise<BuildMirrorResult> {
  const started = Date.now();
  const status = opts.status ?? (await getCodegraphStatus(projectPath));
  if (!status.available) {
    throw new MirrorError('status-failed', `codegraph status 失败: ${status.error ?? 'unknown'}`);
  }
  if (!status.initialized) {
    throw new MirrorError('not-initialized', '工程未索引 —— 请先在终端运行 codegraph init（小时级任务，CodeMap 不代跑）');
  }
  const wl = extractionWhitelistCheck(status);
  if (!wl.ok || wl.built == null) {
    throw new MirrorError('extraction-mismatch', wl.reason ?? 'extraction 版本不在白名单');
  }
  const upstream = upstreamDbPath(projectPath);
  if (!fs.existsSync(upstream)) {
    throw new MirrorError('upstream-missing', `上游库不存在: ${upstream}`);
  }

  const src = openUpstreamReadonly(upstream);
  try {
    verifyUpstreamExtraction(src.db, wl.built);

    // 全量重建：先清自家旧文件（绝不碰上游），再建新库
    removeOwnDbFiles(projectPath);
    const own = openOwnDb(projectPath, { create: true });
    try {
      const counts: MirrorCounts = {
        nodes: copyTable(src.db, own, {
          table: 'nodes',
          columns: ['id', 'kind', 'name', 'qualified_name', 'file_path', 'language', 'start_line', 'end_line'],
          insert:
            'INSERT INTO nodes(id, kind, name, qualified_name, file_path, language, start_line, end_line) VALUES (?,?,?,?,?,?,?,?)',
        }),
        edges: copyTable(src.db, own, {
          table: 'edges',
          columns: ['source', 'target', 'kind', 'line', 'col', 'metadata'],
          insert: 'INSERT INTO edges(source, target, kind, line, col, metadata) VALUES (?,?,?,?,?,?)',
        }),
        unresolvedRefs: copyTable(src.db, own, {
          table: 'unresolved_refs',
          columns: ['from_node_id', 'reference_name', 'reference_kind', 'line', 'col', 'candidates', 'file_path', 'language'],
          insert:
            'INSERT INTO unresolved_refs(from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language) VALUES (?,?,?,?,?,?,?,?)',
        }),
        files: copyTable(src.db, own, {
          table: 'files',
          columns: ['path', 'content_hash', 'language', 'size'],
          insert: 'INSERT INTO files(path, content_hash, language, size) VALUES (?,?,?,?)',
        }),
      };

      const mirroredAt = new Date().toISOString();
      writeMeta(own, 'extraction_version', String(wl.built));
      if (status.version) writeMeta(own, 'codegraph_version', status.version);
      writeMeta(own, 'mirrored_at', mirroredAt);
      writeMeta(own, 'upstream_counts', JSON.stringify(counts));

      return {
        projectPath,
        mirroredAt,
        extractionVersion: wl.built,
        codegraphVersion: status.version,
        counts,
        durationMs: Date.now() - started,
        copiedAside: src.copiedAside,
      };
    } finally {
      try {
        own.close();
      } catch {
        /* 已关闭则忽略 */
      }
    }
  } finally {
    src.dispose();
  }
}

/** 双重校验：直读 project_metadata（belt & braces；status 是权威，读不到就跳过） */
function verifyUpstreamExtraction(db: DatabaseSync, expected: number): void {
  try {
    const row = db
      .prepare("SELECT value FROM project_metadata WHERE key = 'indexed_with_extraction_version'")
      .get() as { value: string } | undefined;
    if (row?.value != null && Number(row.value) !== expected) {
      throw new MirrorError(
        'extraction-mismatch',
        `上游库内 extraction_version=${row.value} 与 status 报告的 ${expected} 不一致 —— 拒绝镜像`,
      );
    }
  } catch (e) {
    if (e instanceof MirrorError) throw e;
    // 表结构不符：跳过双重校验（白名单校验已在 status 通道完成）
  }
}

/** 按 rowid 分块复制一张表（事务内批量插入） */
function copyTable(src: DatabaseSync, own: DatabaseSync, spec: CopySpec): number {
  const cols = spec.columns.join(', ');
  const stmt = src.prepare(`SELECT rowid AS _rid, ${cols} FROM ${spec.table} WHERE rowid > ? ORDER BY rowid LIMIT ?`);
  const ins = own.prepare(spec.insert);
  let last = 0;
  let inserted = 0;
  own.exec('BEGIN');
  try {
    for (;;) {
      const rows = stmt.all(last, 5_000) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const params = spec.columns.map((c) => (row[c] ?? null) as string | number | bigint | Uint8Array | null);
        ins.run(...params);
        last = Number(row['_rid']);
        inserted++;
      }
    }
    own.exec('COMMIT');
  } catch (e) {
    own.exec('ROLLBACK');
    throw e;
  }
  return inserted;
}
