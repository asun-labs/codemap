import * as fs from 'node:fs';
import * as path from 'node:path';
import { walkFiles, toRelPath, type WalkStats } from './file-walk.js';

export type BoundaryKind = 'native' | 'wasm' | 'asar' | 'prebuilt';

export interface BoundaryHit {
  id: string;
  kind: BoundaryKind;
  path: string;
  sizeBytes: number | null;
  importers: string[];
  /** rea 能否穿透（P3 pierce 用） */
  pierceable: boolean;
  reaCommand: string | null;
}

export interface HttpEgress {
  file: string;
  lines: number[];
  samples: string[];
}

export interface EdgeScanResult {
  projectPath: string;
  boundaries: BoundaryHit[];
  httpEgress: HttpEgress[];
  envVars: Array<{ name: string; files: string[] }>;
  databases: Array<{ kind: string; detail: string }>;
  scanned: { sourceFiles: number; walkedFiles: number; truncated: boolean; notes: string[] };
}

const BOUNDARY_EXT: Record<string, { kind: BoundaryKind; pierceable: boolean; reaCommand: string | null }> = {
  '.node': { kind: 'native', pierceable: true, reaCommand: 'inspect-artifact' },
  '.dll': { kind: 'native', pierceable: true, reaCommand: 'inspect-artifact' },
  '.so': { kind: 'native', pierceable: true, reaCommand: 'inspect-artifact' },
  '.dylib': { kind: 'native', pierceable: true, reaCommand: 'inspect-artifact' },
  '.wasm': { kind: 'wasm', pierceable: true, reaCommand: 'inspect-wasm-artifact' },
  '.asar': { kind: 'asar', pierceable: true, reaCommand: 'analyze-javascript-application' },
  '.jar': { kind: 'prebuilt', pierceable: true, reaCommand: 'inspect-artifact' },
};

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_SOURCE_BYTES = 512 * 1024;

const HTTP_PATTERNS: RegExp[] = [
  /\bfetch\s*\(/,
  /\baxios\b\s*[.(]/,
  /\bhttps?\s*\.\s*request\s*\(/,
  /\bgot\s*\(/,
  /\bsuperagent\b/,
];

const ENV_PATTERN = /\b(?:process|import\.meta)\.env\.([A-Z0-9_]+)/g;

/**
 * P2 edges（v2 §6.2）：静态边界扫描——native/wasm/asar/预编译产物 + HTTP 出口 + 环境变量 + DB 指示器。
 * 只读文件系统与镜像库，不拉起任何进程；rea 穿透本身是 P3。
 */
export function scanEdges(projectPath: string): EdgeScanResult {
  const notes: string[] = [];
  const boundaries = new Map<string, BoundaryHit>();
  const sourceFiles: string[] = [];

  const walkStats: WalkStats = walkFiles(projectPath, (fp) => {
    const ext = path.extname(fp).toLowerCase();
    const hit = BOUNDARY_EXT[ext];
    if (hit) {
      const rel = toRelPath(projectPath, fp);
      let size: number | null = null;
      try {
        size = fs.statSync(fp).size;
      } catch {
        /* 大小拿不到就留空 */
      }
      boundaries.set(rel, {
        id: `boundary:${hit.kind}:${rel}`,
        kind: hit.kind,
        path: rel,
        sizeBytes: size,
        importers: [],
        pierceable: hit.pierceable,
        reaCommand: hit.reaCommand,
      });
    } else if (SOURCE_EXT.has(ext)) {
      sourceFiles.push(fp);
    }
  });
  if (walkStats.truncated) {
    notes.push(`文件遍历达上限 ${walkStats.files}，扫描可能不完整`);
  }

  // 源码扫描：HTTP 出口 / env / 边界引用证据（cap 保护大仓库）
  const SOURCE_READ_CAP = 3_000;
  const srcList = sourceFiles.slice(0, SOURCE_READ_CAP);
  if (sourceFiles.length > SOURCE_READ_CAP) {
    notes.push(`源码扫描抽样 ${SOURCE_READ_CAP}/${sourceFiles.length} 个文件`);
  }
  const egress: HttpEgress[] = [];
  const envMap = new Map<string, Set<string>>();
  const lowerBasenames = new Map<string, string[]>();
  for (const b of boundaries.keys()) {
    const base = path.posix.basename(b).toLowerCase();
    const arr = lowerBasenames.get(base) ?? [];
    arr.push(b);
    lowerBasenames.set(base, arr);
  }

  for (const fp of srcList) {
    let text: string;
    try {
      const st = fs.statSync(fp);
      if (st.size > MAX_SOURCE_BYTES) continue;
      text = fs.readFileSync(fp, 'utf8');
    } catch {
      continue;
    }
    const rel = toRelPath(projectPath, fp);
    const lines = text.split(/\r?\n/);

    // 边界引用证据：字符串字面量里出现边界文件 basename
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      for (const [base, targets] of lowerBasenames) {
        if (line.includes(base)) {
          for (const t of targets) {
            const b = boundaries.get(t);
            if (b && !b.importers.includes(rel)) b.importers.push(rel);
          }
        }
      }
    }

    // HTTP 出口
    const hitLines: number[] = [];
    const samples: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (HTTP_PATTERNS.some((re) => re.test(line))) {
        hitLines.push(i + 1);
        if (samples.length < 3) samples.push(line.trim().slice(0, 160));
      }
    }
    if (hitLines.length > 0) egress.push({ file: rel, lines: hitLines, samples });

    // 环境变量
    for (const m of text.matchAll(ENV_PATTERN)) {
      const name = m[1];
      if (!name) continue;
      const files = envMap.get(name) ?? new Set<string>();
      files.add(rel);
      envMap.set(name, files);
    }
  }

  // DB 指示器
  const databases: EdgeScanResult['databases'] = [];
  const prismaSchema = findUpwards(projectPath, ['prisma', 'schema.prisma']);
  if (prismaSchema) {
    const models = (fs.readFileSync(prismaSchema, 'utf8').match(/^model\s+\w+/gm) ?? []).length;
    databases.push({ kind: 'prisma', detail: `prisma/schema.prisma（${models} 个 model）` });
  }
  const typeormEntities = sourceFiles.filter((f) => f.endsWith('.entity.ts')).length;
  if (typeormEntities > 0) {
    databases.push({ kind: 'typeorm', detail: `${typeormEntities} 个 *.entity.ts` });
  }
  const knexfile = findUpwards(projectPath, ['knexfile.js', 'knexfile.ts']);
  if (knexfile) databases.push({ kind: 'knex', detail: 'knexfile' });

  return {
    projectPath,
    boundaries: [...boundaries.values()].sort((a, b) => a.path.localeCompare(b.path)),
    httpEgress: egress.sort((a, b) => b.lines.length - a.lines.length).slice(0, 50),
    envVars: [...envMap.entries()]
      .map(([name, files]) => ({ name, files: [...files].slice(0, 5) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 100),
    databases,
    scanned: { sourceFiles: srcList.length, walkedFiles: walkStats.files, truncated: walkStats.truncated, notes },
  };
}

function findUpwards(root: string, relParts: string[]): string | null {
  const fp = path.join(root, ...relParts);
  return fs.existsSync(fp) ? fp : null;
}
