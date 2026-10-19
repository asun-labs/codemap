import { EXTRACTION_VERSION_WHITELIST } from '../config.js';
import { runAsync, extractJson, lastErrorLine } from '../util/spawn.js';

export interface CodegraphIndexInfo {
  builtWithVersion?: string;
  builtWithExtractionVersion?: number;
  currentExtractionVersion?: number;
  reindexRecommended?: boolean;
}

export interface CodegraphStatus {
  available: boolean;
  error?: string;
  initialized?: boolean;
  version?: string;
  projectPath?: string;
  indexPath?: string;
  lastIndexed?: string | null;
  fileCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  journalMode?: string;
  pendingChanges?: { added: number; modified: number; removed: number };
  index?: CodegraphIndexInfo;
}

/**
 * `codegraph status --json`（稳定 CLI 通道，字段已按 1.2.0 源码核对）。
 * 版本白名单与 staleness 都走这里，不摸内部元数据表。
 */
export async function getCodegraphStatus(
  projectPath: string,
  opts: { codegraphPath?: string; timeoutMs?: number } = {},
): Promise<CodegraphStatus> {
  const cmd = opts.codegraphPath ?? 'codegraph';
  const r = await runAsync(cmd, ['status', projectPath, '--json'], opts.timeoutMs ?? 30_000);
  if (!r.ok) {
    const detail = r.error ?? lastErrorLine(r.stderr) ?? `exit ${r.code ?? '?'}`;
    return { available: false, error: detail };
  }
  const json = extractJson(r.stdout);
  if (!json || typeof json !== 'object') {
    return { available: false, error: 'status --json 输出无法解析为 JSON' };
  }
  const s = json as Record<string, unknown>;
  const status: CodegraphStatus = { available: true };
  status.initialized = s['initialized'] === true;
  status.version = asString(s['version']);
  status.projectPath = asString(s['projectPath']);
  status.indexPath = asString(s['indexPath']);
  status.lastIndexed = (s['lastIndexed'] ?? null) as string | null;
  status.fileCount = asNumber(s['fileCount']);
  status.nodeCount = asNumber(s['nodeCount']);
  status.edgeCount = asNumber(s['edgeCount']);
  status.journalMode = asString(s['journalMode']);
  const pc = s['pendingChanges'] as Record<string, unknown> | undefined;
  if (pc) {
    status.pendingChanges = {
      added: asNumber(pc['added']) ?? 0,
      modified: asNumber(pc['modified']) ?? 0,
      removed: asNumber(pc['removed']) ?? 0,
    };
  }
  const idx = s['index'] as Record<string, unknown> | undefined;
  if (idx) {
    status.index = {
      builtWithVersion: asString(idx['builtWithVersion']),
      builtWithExtractionVersion: asNumber(idx['builtWithExtractionVersion']),
      currentExtractionVersion: asNumber(idx['currentExtractionVersion']),
      reindexRecommended: idx['reindexRecommended'] === true,
    };
  }
  return status;
}

/**
 * extraction 版本白名单校验（v2 §4.2 铁律 3）。
 * 不在白名单 → 不建/不读镜像，绝不猜未知 schema。
 */
export function extractionWhitelistCheck(status: CodegraphStatus): { ok: boolean; built?: number; reason?: string } {
  const built = status.index?.builtWithExtractionVersion;
  if (built == null) {
    return { ok: false, reason: 'status 输出缺少 index.builtWithExtractionVersion' };
  }
  if (!EXTRACTION_VERSION_WHITELIST.includes(built)) {
    return {
      ok: false,
      built,
      reason: `extraction v${built} 不在白名单 [${EXTRACTION_VERSION_WHITELIST.join(', ')}] —— codegraph index 重建或升级 CodeMap`,
    };
  }
  return { ok: true, built };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
