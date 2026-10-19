import { EXTRACTION_VERSION_WHITELIST } from '../config.js';
import type { CodegraphStatus } from './codegraph-status.js';
import { openOwnDb, readMeta } from '../db/own.js';
import { ownDbExists } from '../util/paths.js';

export interface MirrorCounts {
  nodes: number;
  edges: number;
  unresolvedRefs: number;
  files: number;
}

export interface MirrorState {
  present: boolean;
  mirroredAt?: string;
  extractionVersion?: number;
  codegraphVersion?: string;
  counts?: MirrorCounts;
  stale: boolean;
  staleReasons: string[];
}

/** 读取镜像状态并判定 staleness（source of truth = status --json，不自己用 git 猜） */
export function readMirrorState(projectPath: string, status?: CodegraphStatus): MirrorState {
  if (!ownDbExists(projectPath)) {
    return { present: false, stale: true, staleReasons: ['镜像不存在 —— 运行 codemap mirror <path> 生成'] };
  }
  const db = openOwnDb(projectPath);
  try {
    const mirroredAt = readMeta(db, 'mirrored_at') ?? undefined;
    const extractionVersion = Number(readMeta(db, 'extraction_version')) || undefined;
    const codegraphVersion = readMeta(db, 'codegraph_version') ?? undefined;
    let counts: MirrorCounts | undefined;
    const raw = readMeta(db, 'upstream_counts');
    if (raw) {
      try {
        counts = JSON.parse(raw) as MirrorCounts;
      } catch {
        /* 损坏的 meta 视为无 counts */
      }
    }
    const reasons: string[] = [];
    if (extractionVersion && !EXTRACTION_VERSION_WHITELIST.includes(extractionVersion)) {
      reasons.push(`镜像 extraction v${extractionVersion} 不在白名单`);
    }
    if (status?.index?.reindexRecommended) {
      reasons.push('上游建议重建索引（reindexRecommended）');
    }
    if (status?.lastIndexed && mirroredAt) {
      if (new Date(mirroredAt).getTime() < new Date(status.lastIndexed).getTime()) {
        reasons.push('上游索引时间晚于镜像');
      }
    }
    return {
      present: true,
      mirroredAt,
      extractionVersion,
      codegraphVersion,
      counts,
      stale: reasons.length > 0,
      staleReasons: reasons,
    };
  } finally {
    try {
      db.close();
    } catch {
      /* 已关闭则忽略 */
    }
  }
}
