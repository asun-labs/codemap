import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SystemSpec, SystemSpecEdge, SystemsFileModel } from '../model/schema.js';
import type { ExternalSys } from './systems-layer.js';

/**
 * `.codemap/systems.yaml` —— 第 1 层跨系统关系的人工确认入口。
 *
 * 刻意不引 yaml 依赖：这里只需要一个极小的子集（映射 + 列表 + 标量），
 * 自己写解析比多一个运行时依赖更划算，也保证零安装可跑。
 */

export const SYSTEMS_DIR = '.codemap';
export const SYSTEMS_FILE = 'systems.yaml';

export function systemsFilePath(root: string): string {
  return path.join(root, SYSTEMS_DIR, SYSTEMS_FILE);
}

export interface ParsedSystems {
  current?: { id?: string; name?: string; description?: string };
  systems: SystemSpec[];
  edges: SystemSpecEdge[];
}

/** 解析 systems.yaml 的受限子集（支持注释、嵌套映射、列表项、引号字符串） */
export function parseSystemsYaml(text: string): ParsedSystems {
  const out: ParsedSystems = { systems: [], edges: [] };
  const lines = text.split(/\r?\n/);
  let section: 'current' | 'systems' | 'edges' | null = null;
  let item: Record<string, string> | null = null;

  const flush = () => {
    if (!item) return;
    if (section === 'systems') {
      const id = item.id ?? item.name;
      if (id) {
        out.systems.push({
          id,
          name: item.name ?? id,
          kind: item.kind === 'current' ? 'current' : 'external',
          description: item.description,
          owner: item.owner,
          tags: item.tags ? item.tags.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        });
      }
    } else if (section === 'edges') {
      if (item.source && item.target) {
        out.edges.push({
          source: item.source,
          target: item.target,
          protocol: item.protocol ?? 'unknown',
          label: item.label,
          direction: item.direction === 'two-way' ? 'two-way' : 'one-way',
        });
      }
    } else if (section === 'current') {
      out.current = { id: item.id, name: item.name, description: item.description };
    }
    item = null;
  };

  for (const raw of lines) {
    const noComment = stripComment(raw);
    if (noComment.trim() === '') continue;
    const indent = noComment.length - noComment.trimStart().length;
    const line = noComment.trim();

    if (indent === 0 && line.endsWith(':')) {
      flush();
      const key = line.slice(0, -1).trim();
      section = key === 'current' || key === 'systems' || key === 'edges' ? key : null;
      continue;
    }
    if (!section) continue;
    if (line.startsWith('- ')) {
      flush();
      item = {};
      const rest = line.slice(2).trim();
      const kv = splitKeyValue(rest);
      if (kv) item[kv[0]] = kv[1];
      continue;
    }
    // 纯映射节（current:）没有 `- ` 前缀，首行键值要自己开 item
    if (!item && section === 'current' && indent > 0) item = {};
    if (item) {
      const kv = splitKeyValue(line);
      if (kv) item[kv[0]] = kv[1];
    }
  }
  flush();
  return out;
}

function stripComment(line: string): string {
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1] as string))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitKeyValue(line: string): [string, string] | null {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const key = line.slice(0, i).trim();
  let val = line.slice(i + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (val === '') return null;
  return [key, val];
}

/** 自动推测结果 → 建议稿（带 TODO 注释，用户改名补线后 draft=false 由 CLI 回写） */
export function renderSystemsYaml(opts: {
  projectName: string;
  projectRoot: string;
  detected: ExternalSys[];
  currentId?: string;
}): string {
  const L: string[] = [];
  L.push('# CodeMap 系统关系（第 1 层骨架）');
  L.push('#');
  L.push('# 这份文件由 `codemap systems` 自动生成，是第 1 层「系统 ↔ 系统」的唯一事实来源。');
  L.push('# 自动检测到的条目 confidence = inferred，请逐条核对；改完把 draft 改成 false。');
  L.push('# 外部系统 id 一旦确定就不要改（图里的节点 id 依赖它）。');
  L.push('');
  L.push('draft: true');
  L.push('');
  L.push('current:');
  L.push(`  id: ${opts.currentId ?? 'current'}`);
  L.push(`  name: ${yamlScalar(opts.projectName)}`);
  L.push('  # 当前系统的职责一句话');
  L.push('  description: ');
  L.push('');
  L.push('systems:');
  if (opts.detected.length === 0) {
    L.push('  # 没有自动识别到外部系统，请手工补，例如：');
    L.push('  # - id: sso');
    L.push('  #   name: 用户登录系统');
    L.push('  #   kind: external');
    L.push('  #   description: 统一身份认证，签发 JWT');
  }
  for (const d of opts.detected) {
    L.push(`  - id: ${d.id}`);
    L.push(`    name: ${yamlScalar(d.name)}`);
    L.push('    kind: external');
    L.push(`    # 来源：${describeHits(d)}`);
    L.push('    description: ');
  }
  L.push('');
  L.push('edges:');
  L.push('  # source / target 用上面的 id；protocol 是数据流转协议，direction 可写 two-way');
  for (const d of opts.detected) {
    const src = d.direction === 'call-in' ? d.id : (opts.currentId ?? 'current');
    const dst = d.direction === 'call-in' ? (opts.currentId ?? 'current') : d.id;
    L.push(`  - source: ${src}`);
    L.push(`    target: ${dst}`);
    L.push(`    protocol: ${d.protocol}`);
    L.push(`    label: ${yamlScalar(d.label ?? d.name)}`);
    if (d.direction === 'both') L.push('    direction: two-way');
  }
  L.push('');
  return L.join('\n');
}

function describeHits(sys: ExternalSys): string {
  return sys.evidence
    .map((e) => (e.line > 0 ? `${e.file}:${e.line}` : e.file || '?'))
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
}

function yamlScalar(v: string): string {
  if (v === '') return '""';
  if (/^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 .()（）/-]*$/.test(v) && !/: |#/.test(v)) return v;
  return JSON.stringify(v);
}

/** 读盘 + 解析；文件不存在返回 null */
export function loadSystems(root: string): { parsed: ParsedSystems; draft: boolean; configPath: string } | null {
  const fp = systemsFilePath(root);
  if (!fs.existsSync(fp)) return null;
  const text = fs.readFileSync(fp, 'utf8');
  const parsed = parseSystemsYaml(text);
  const draft = /^\s*draft:\s*true\s*$/m.test(text);
  return { parsed, draft, configPath: SYSTEMS_DIR + '/' + SYSTEMS_FILE };
}

/** 写盘（不覆盖已有文件，除非 force） */
export function writeSystems(root: string, content: string, force = false): { written: boolean; path: string } {
  const fp = systemsFilePath(root);
  if (fs.existsSync(fp) && !force) return { written: false, path: fp };
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, 'utf8');
  return { written: true, path: fp };
}

/** 把 systems.yaml 解析成图模型里的 SystemsFileModel */
export function toSystemsFileModel(parsed: ParsedSystems, configPath: string | null, draft: boolean): SystemsFileModel {
  return {
    systems: parsed.systems,
    edges: parsed.edges,
    configPath,
    draft,
  };
}

/** systems.yaml 的外部系统 → buildSystemsLayer 需要的 ExternalSys */
export function toExternalSys(parsed: ParsedSystems): ExternalSys[] {
  const out: ExternalSys[] = [];
  const currentId = parsed.current?.id ?? 'current';
  const known = new Map<string, SystemSpec>();
  for (const s of parsed.systems) {
    if (s.kind === 'current') continue;
    known.set(s.id, s);
    out.push({
      id: s.id,
      name: s.name,
      kind: guessKind(s),
      protocol: 'unknown',
      evidence: [],
      confidence: 'config',
      direction: 'call-out',
      notes: [parsed.current?.name ? `人工确认（当前系统：${parsed.current.name}）` : '人工确认'],
    });
  }
  // 用 edges 回填协议与方向
  for (const e of parsed.edges) {
    const isOut = e.source === currentId || e.source === 'current';
    const isIn = e.target === currentId || e.target === 'current';
    const otherId = isOut ? e.target : isIn ? e.source : null;
    if (!otherId) continue;
    const sys = out.find((s) => s.id === otherId);
    if (!sys) continue;
    sys.protocol = e.protocol;
    if (e.label) sys.label = e.label;
    if (e.direction === 'two-way') sys.direction = 'both';
    else if (isIn) sys.direction = 'call-in';
    else sys.direction = 'call-out';
  }
  if (known.size === 0) return [];
  return out;
}

function guessKind(s: SystemSpec): ExternalSys['kind'] {
  const t = (s.tags ?? []).map((x) => x.toLowerCase());
  if (t.includes('auth')) return 'auth';
  if (t.includes('gateway')) return 'gateway';
  if (t.includes('datastore') || t.includes('db')) return 'datastore';
  if (t.includes('queue') || t.includes('mq')) return 'queue';
  if (t.includes('third-party') || t.includes('thirdparty')) return 'third-party';
  const n = (s.name + s.id).toLowerCase();
  if (/(auth|sso|login|认证|登录)/.test(n)) return 'auth';
  if (/(gateway|网关)/.test(n)) return 'gateway';
  if (/(db|mysql|postgres|mongo|redis|数据库)/.test(n)) return 'datastore';
  if (/(kafka|mq|queue|rabbit|消息)/.test(n)) return 'queue';
  return 'system';
}

export const __test = { stripComment, splitKeyValue, yamlScalar, guessKind };
