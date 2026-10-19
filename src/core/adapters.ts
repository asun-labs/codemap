import * as fs from 'node:fs';
import * as path from 'node:path';
import { walkFiles, toRelPath } from './file-walk.js';
import { SYMBOL_KINDS } from './map-fold.js';
import type { LoadedGraph } from './graph-load.js';

export type L4Kind = 'route' | 'ipc' | 'bridge' | 'table';

export interface L4Node {
  id: string;
  adapter: 'express' | 'electron' | 'prisma';
  kind: L4Kind;
  label: string;
  filePath: string;
  line: number;
  /** 缝合到的 codegraph 符号 id（按 file:line；缝不上就 null，绝不硬凑） */
  targetNodeId: string | null;
  confidence: 'inferred' | 'partial';
  evidence: string;
}

export interface L4Edge {
  source: string;
  target: string;
  kind: 'l4-route';
}

export interface L4Result {
  adapters: Array<{ name: string; detected: boolean; nodes: number }>;
  nodes: L4Node[];
  edges: L4Edge[];
  notes: string[];
}

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_BYTES = 512 * 1024;

const ROUTE_RE = /\.(get|post|put|delete|patch|all|use)\s*\(\s*['"`]([^'"`]+)['"`]/;
const IPC_RE = /\bipcMain\.(handle|on)\s*\(\s*['"`]([^'"`]+)['"`]/;
const BRIDGE_RE = /\bcontextBridge\.exposeInMainWorld\s*\(\s*['"`]([^'"`]+)['"`]/;

/**
 * P4 L4 适配器（v2 §6.2 口径）：不做全量 AST 解析，行级正则，产物 confidence=inferred/partial，
 * 与 codegraph 符号按 file:line 缝合；缝不上的如实标 null。识别不了的进 notes。
 */
export function buildL4Index(projectPath: string, g?: LoadedGraph): L4Result {
  const notes: string[] = [];
  const deps = readDependencies(projectPath);
  const detected = {
    express: ['express', 'koa', 'fastify', 'connect'].some((d) => deps.has(d)),
    electron: deps.has('electron'),
    prisma: deps.has('@prisma/client') || deps.has('prisma'),
  };

  // 符号缝合索引：file → 按行排序的符号
  const symbolsByFile = new Map<string, Array<{ id: string; start: number; end: number }>>();
  if (g) {
    for (const n of g.nodes.values()) {
      if (!SYMBOL_KINDS.has(n.kind) || !n.filePath || n.startLine == null) continue;
      const fp = n.filePath.replace(/\\/g, '/');
      const arr = symbolsByFile.get(fp) ?? [];
      arr.push({ id: n.id, start: n.startLine, end: n.endLine ?? n.startLine });
      symbolsByFile.set(fp, arr);
    }
    for (const arr of symbolsByFile.values()) arr.sort((a, b) => a.start - b.start);
  }

  const nodes: L4Node[] = [];
  const edges: L4Edge[] = [];
  const stitch = (fp: string, line: number): string | null => {
    const arr = symbolsByFile.get(fp);
    if (!arr) return null;
    // 包含该行的符号 → 否则该行之后最近的符号 → null
    const containing = arr.find((s) => s.start <= line && line <= s.end);
    if (containing) return containing.id;
    const next = arr.find((s) => s.start >= line);
    return next ? next.id : null;
  };

  const seenFiles: string[] = [];
  walkFiles(projectPath, (fp) => {
    const ext = path.extname(fp).toLowerCase();
    if (!SOURCE_EXT.has(ext)) return;
    let st;
    try {
      st = fs.statSync(fp);
      if (st.size > MAX_BYTES) return;
    } catch {
      return;
    }
    seenFiles.push(fp);
    const rel = toRelPath(projectPath, fp);
    let text: string;
    try {
      text = fs.readFileSync(fp, 'utf8');
    } catch {
      return;
    }
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (detected.express) {
        const m = line.match(ROUTE_RE);
        if (m) {
          const id = `l4:express:route:${rel}:${i + 1}`;
          const target = stitch(rel, i + 1);
          nodes.push({
            id,
            adapter: 'express',
            kind: 'route',
            label: `${m[1]?.toUpperCase()} ${m[2]}`,
            filePath: rel,
            line: i + 1,
            targetNodeId: target,
            confidence: target ? 'partial' : 'inferred',
            evidence: line.trim().slice(0, 200),
          });
          if (target) edges.push({ source: id, target, kind: 'l4-route' });
        }
      }
      if (detected.electron) {
        const mIpc = line.match(IPC_RE);
        if (mIpc) {
          const id = `l4:electron:ipc:${rel}:${i + 1}`;
          const target = stitch(rel, i + 1);
          nodes.push({
            id,
            adapter: 'electron',
            kind: 'ipc',
            label: `IPC ${mIpc[2]}`,
            filePath: rel,
            line: i + 1,
            targetNodeId: target,
            confidence: target ? 'partial' : 'inferred',
            evidence: line.trim().slice(0, 200),
          });
          if (target) edges.push({ source: id, target, kind: 'l4-route' });
        }
        const mBridge = line.match(BRIDGE_RE);
        if (mBridge) {
          nodes.push({
            id: `l4:electron:bridge:${rel}:${i + 1}`,
            adapter: 'electron',
            kind: 'bridge',
            label: `BRIDGE ${mBridge[1]}`,
            filePath: rel,
            line: i + 1,
            targetNodeId: stitch(rel, i + 1),
            confidence: 'inferred',
            evidence: line.trim().slice(0, 200),
          });
        }
      }
    }
  });

  if (detected.prisma) {
    const schemaPath = path.join(projectPath, 'prisma', 'schema.prisma');
    if (fs.existsSync(schemaPath)) {
      const text = fs.readFileSync(schemaPath, 'utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = (lines[i] as string).match(/^model\s+(\w+)/);
        if (m) {
          nodes.push({
            id: `l4:prisma:table:${m[1]}`,
            adapter: 'prisma',
            kind: 'table',
            label: `TABLE ${m[1]}`,
            filePath: 'prisma/schema.prisma',
            line: i + 1,
            targetNodeId: null,
            confidence: 'partial',
            evidence: (lines[i] as string).trim().slice(0, 200),
          });
        }
      }
    } else {
      notes.push('声明了 @prisma/client 但找不到 prisma/schema.prisma');
    }
  }

  return {
    adapters: [
      { name: 'express', detected: detected.express, nodes: nodes.filter((n) => n.adapter === 'express').length },
      { name: 'electron', detected: detected.electron, nodes: nodes.filter((n) => n.adapter === 'electron').length },
      { name: 'prisma', detected: detected.prisma, nodes: nodes.filter((n) => n.adapter === 'prisma').length },
    ],
    nodes,
    edges,
    notes,
  };
}

function readDependencies(projectPath: string): Set<string> {
  const deps = new Set<string>();
  const pkgPath = path.join(projectPath, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const k of Object.keys(pkg.dependencies ?? {})) deps.add(k);
    for (const k of Object.keys(pkg.devDependencies ?? {})) deps.add(k);
  } catch {
    /* 无 package.json → 全部适配器未检出 */
  }
  return deps;
}
