import * as fs from 'node:fs';
import type { Confidence, Evidence, GraphEdge, GraphNode } from '../model/schema.js';
import type { FileGraph } from './file-graph.js';

/** 外部系统（来自 systems.yaml 或自动推测） */
export interface ExternalSys {
  id: string;
  name: string;
  /** 网关 / 认证 / 数据库 / 消息 / 第三方 / 系统 */
  kind: 'auth' | 'gateway' | 'datastore' | 'queue' | 'third-party' | 'system';
  protocol: string;
  /** 触发推测的证据 */
  evidence: Evidence[];
  confidence: Confidence;
  direction: 'call-out' | 'call-in' | 'both';
  /** 线上文字，默认用 name */
  label?: string;
  notes?: string[];
}

export interface SystemsBuildInput {
  fg: FileGraph;
  project: { name: string; root: string };
  currentId: string;
  currentName: string;
  currentFiles: string[];
  currentSymbols: Map<string, number>;
  fileIdOf: Map<string, string>;
  /** 人工确认过的外部系统：优先，少猜测 */
  confirmed: ExternalSys[];
  moduleOf: Map<string, string>;
  /** codegraph 原始节点（取 import 伪节点名当第三方包证据） */
  upNodes?: Iterable<{ kind: string; name: string; filePath: string }>;
}

export interface SystemsBuildOutput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
  /** 本次实际使用的外部系统（带证据），用于写 systems.yaml 建议稿 */
  external: ExternalSys[];
}

interface Detector {
  id: string;
  name: string;
  kind: ExternalSys['kind'];
  protocol: string;
  /** 文件内容正则；命中即算证据 */
  pattern: RegExp;
  /** 只在这些文件名/扩展名里找 */
  inFiles?: RegExp;
  /** 线标签 */
  label?: string;
  direction?: ExternalSys['direction'];
}

/**
 * 从依赖声明 / 配置 / HTTP 出入口 / DB 连接串 推测外部系统。
 * 这里的每一条都只是「猜测」，confidence 一律 inferred，最终以 systems.yaml 为准。
 */
const DETECTORS: Detector[] = [
  {
    id: 'mysql',
    name: 'MySQL',
    kind: 'datastore',
    protocol: 'db',
    label: 'MySQL',
    pattern: /\b(mysql|mysql2|mariadb)\b|jdbc:mysql:|mysql:\/\//i,
    direction: 'call-out',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    kind: 'datastore',
    protocol: 'db',
    label: 'PostgreSQL',
    pattern: /\b(pg|postgres|postgresql)\b|jdbc:postgresql:|postgres(ql)?:\/\//i,
    direction: 'call-out',
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    kind: 'datastore',
    protocol: 'db',
    label: 'MongoDB',
    pattern: /\bmongodb\b|mongodb(\+srv)?:\/\//i,
    direction: 'call-out',
  },
  {
    id: 'redis',
    name: 'Redis',
    kind: 'datastore',
    protocol: 'cache',
    label: 'Redis',
    pattern: /\b(redis|ioredis)\b|redis:\/\//i,
    direction: 'call-out',
  },
  {
    id: 'elasticsearch',
    name: 'Elasticsearch',
    kind: 'datastore',
    protocol: 'db',
    pattern: /\b(elasticsearch|opensearch|@elastic\/elasticsearch)\b/i,
    direction: 'call-out',
  },
  {
    id: 'kafka',
    name: 'Kafka',
    kind: 'queue',
    protocol: 'mq',
    pattern: /\b(kafkajs|kafka-node|spring-kafka|confluent-kafka)\b/i,
    direction: 'call-out',
  },
  {
    id: 'rabbitmq',
    name: 'RabbitMQ',
    kind: 'queue',
    protocol: 'mq',
    pattern: /\b(amqplib|amqp-connection-manager|rabbitmq|pika|celery)\b/i,
    direction: 'call-out',
  },
  {
    id: 'auth',
    name: '统一认证（推测）',
    kind: 'auth',
    protocol: 'http',
    label: '身份认证',
    pattern: /\b(passport|keycloak|auth0|oauth2?|openid|jwt|sso|cas|ldap)\b/i,
    direction: 'both',
  },
  {
    id: 'sts',
    name: '阿里云 STS / OSS（推测）',
    kind: 'third-party',
    protocol: 'http',
    pattern: /\b(ali-oss|@alicloud\/|aliyun|oss-cn|sts\.aliyuncs)\b/i,
    direction: 'call-out',
  },
  {
    id: 's3',
    name: 'S3 / 对象存储（推测）',
    kind: 'third-party',
    protocol: 'http',
    pattern: /\b(@aws-sdk\/client-s3|aws-sdk|minio|boto3)\b/i,
    direction: 'call-out',
  },
  {
    id: 'sms-mail',
    name: '短信 / 邮件服务（推测）',
    kind: 'third-party',
    protocol: 'http',
    pattern: /\b(nodemailer|twilio|sms|dysmsapi|sendgrid|mailgun)\b/i,
    direction: 'call-out',
  },
  {
    id: 'payment',
    name: '支付网关（推测）',
    kind: 'third-party',
    protocol: 'http',
    pattern: /\b(stripe|alipay|wechatpay|wechat-pay|paypal|unionpay)\b/i,
    direction: 'both',
  },
];

const CONFIG_FILE = /\.(json|ya?ml|toml|ini|env|properties|conf|cfg|xml)$|^\.env|(^|\/)Dockerfile|docker-compose/i;

export function buildSystemsLayer(input: SystemsBuildInput): SystemsBuildOutput {
  const warnings: string[] = [];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const extra: ExternalSys[] = [];

  const totalFiles = input.fg.files.size;
  let totalSymbols = 0;
  for (const v of input.currentSymbols.values()) totalSymbols += v;
  const languages = languageCounts(input.fg);

  // ——— 当前系统节点 ———
  nodes.push({
    id: input.currentId,
    level: 0,
    kind: 'system',
    label: input.currentName,
    parent: null,
    path: '',
    hasChildren: true,
    childCount: totalFiles,
    childNodes: 0,
    metrics: { files: totalFiles, symbols: totalSymbols, crossEdges: 0, languages },
    external: false,
    isCurrent: true,
  });

  // ——— 外部系统：已确认优先，其余从代码里推测 ———
  const detected = new Map<string, ExternalSys>();
  if (input.confirmed.length > 0) {
    for (const c of input.confirmed) detected.set(c.id, c);
  } else {
    for (const sys of detectExternalSystems(input)) {
      detected.set(sys.id, sys);
    }
    if (detected.size === 0) {
      warnings.push('未从依赖/配置里识别到任何外部系统；可在 .codemap/systems.yaml 里手工补');
    } else {
      warnings.push(`第 1 层外部系统为自动推测（${detected.size} 个），请核对 .codemap/systems.yaml`);
    }
  }

  for (const sys of detected.values()) {
    nodes.push({
      id: `sys:${sys.id}`,
      level: 0,
      kind: sys.kind === 'datastore' ? 'datastore' : sys.kind === 'gateway' ? 'gateway' : 'external-system',
      label: sys.name,
      parent: null,
      path: null,
      hasChildren: false,
      childCount: 0,
      childNodes: 0,
      metrics: { files: 0, symbols: 0, crossEdges: 0, languages: [] },
      external: true,
      notes: sys.notes,
    });
    extra.push(sys);
    if (sys.direction === 'call-out' || sys.direction === 'both') {
      edges.push(sysEdge(input.currentId, `sys:${sys.id}`, sys.protocol, sys.label ?? sys.name, sys.confidence, sys.evidence, 'call-out'));
    }
    if (sys.direction === 'call-in' || sys.direction === 'both') {
      edges.push(sysEdge(`sys:${sys.id}`, input.currentId, sys.protocol, sys.label ?? sys.name, sys.confidence, sys.evidence, 'call-in'));
    }
  }

  return { nodes, edges, warnings, external: [...detected.values()] };
}

function sysEdge(
  source: string,
  target: string,
  protocol: string,
  label: string,
  confidence: Confidence,
  evidence: Evidence[],
  dir: 'call-in' | 'call-out',
): GraphEdge {
  return {
    id: `system:${source}->${target}:${dir}`,
    source,
    target,
    scope: 'system',
    kind: 'wire',
    protocol,
    label,
    weight: Math.max(1, evidence.length),
    kinds: { [protocol]: Math.max(1, evidence.length) },
    confidence,
    evidence: evidence.slice(0, 4),
  };
}

/** 扫依赖清单 + 配置 + import 说明符，返回推测的外部系统 */
export function detectExternalSystems(input: SystemsBuildInput): ExternalSys[] {
  const hits = new Map<string, { sys: ExternalSys; seen: Set<string> }>();

  const scanText = (file: string, text: string, isConfig: boolean) => {
    for (const d of DETECTORS) {
      if (d.inFiles && !d.inFiles.test(file)) continue;
      const m = d.pattern.exec(text);
      if (!m) continue;
      const line = lineOf(text, m.index);
      const prev = hits.get(d.id);
      // 配置文件里的连接串证据更硬，放到最前
      const ev: Evidence = { file, line, note: m[0].slice(0, 40) };
      if (!prev) {
        hits.set(d.id, {
          sys: {
            id: d.id,
            name: d.name,
            kind: d.kind,
            protocol: d.protocol,
            evidence: [ev],
            confidence: 'inferred',
            direction: d.direction ?? 'call-out',
            label: d.label,
            notes: isConfig ? ['来自配置文件'] : ['来自依赖声明'],
          },
          seen: new Set([file]),
        });
      } else if (!prev.seen.has(file)) {
        prev.seen.add(file);
        prev.sys.evidence.push(ev);
        if (isConfig) prev.sys.notes = ['来自配置文件'];
      }
    }
  };

  // 1) 依赖清单 / 配置：只扫仓库根与包根附近的文件，避免读成百上千个 json
  const MANIFEST = /(^|\/)(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|Cargo\.toml|\.env(\.[\w-]+)?|docker-compose[\w.-]*\.ya?ml|application[\w.-]*\.(ya?ml|properties)|config\.(ya?ml|json))$/i;
  for (const file of input.fg.files.keys()) {
    if (!MANIFEST.test(file)) continue;
    const text = resolveRead(input.project.root, file);
    if (text == null) continue;
    scanText(file, text, true);
  }

  // 2) 源码里的 import 说明符（codegraph 已索引，不用读盘）：命中的第三方包名也算证据
  const modNames = new Map<string, string[]>();
  for (const n of input.upNodes ?? []) {
    if (n.kind !== 'import') continue;
    const pkgName = packageRootOf(n.name);
    if (!pkgName) continue;
    const arr = modNames.get(pkgName) ?? [];
    arr.push(n.filePath);
    modNames.set(pkgName, arr);
  }
  for (const [name, files] of modNames) {
    for (const d of DETECTORS) {
      if (!d.pattern.test(name)) continue;
      const prev = hits.get(d.id);
      if (!prev) {
        hits.set(d.id, {
          sys: {
            id: d.id,
            name: d.name,
            kind: d.kind,
            protocol: d.protocol,
            evidence: [{ file: files[0] ?? '', line: 0, note: `import ${name}` }],
            confidence: 'inferred',
            direction: d.direction ?? 'call-out',
            label: d.label,
            notes: ['来自源码 import'],
          },
          seen: new Set([`mod:${name}`]),
        });
      } else {
        const tag = `mod:${name}`;
        if (!prev.seen.has(tag)) {
          prev.seen.add(tag);
          if (prev.sys.evidence.length < 5) {
            prev.sys.evidence.push({ file: files[0] ?? '', line: 0, note: `import ${name}` });
          }
        }
      }
    }
  }

  const out: ExternalSys[] = [];
  for (const { sys } of hits.values()) {
    sys.evidence = sys.evidence.slice(0, 5);
    out.push(sys);
  }
  return out;
}

function isShallowConfig(file: string): boolean {
  return file.split('/').length <= 3;
}

/** `@scope/pkg/sub` → `@scope/pkg`；`lodash/fp` → `lodash`；相对路径/内置模块 → null */
export function packageRootOf(spec: string): string | null {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.startsWith('#')) return null;
  if (/^[a-z]:/i.test(spec)) return null;
  const clean = spec.replace(/\\/g, '/');
  const parts = clean.split('/');
  if (clean.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  const first = parts[0] as string;
  // 路径式说明符（app/utils 之类内部别名）不含点号时也当成包名，靠检测器正则兜底
  return first.includes('.') || /^[a-z][\w-]*$/.test(first) ? first : null;
}

function languageCounts(fg: FileGraph): string[] {
  const m = new Map<string, number>();
  for (const f of fg.files.values()) m.set(f.language, (m.get(f.language) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * 读配置文件内容：配置/清单通常 < 2MB；读不到返回 null（调用方跳过）。
 */
export function resolveRead(root: string, rel: string): string | null {
  try {
    const p = `${root.replace(/\\/g, '/')}/${rel}`;
    const st = fs.statSync(p);
    if (st.size > 2 * 1024 * 1024) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export const __test = { DETECTORS, lineOf, isShallowConfig, packageRootOf };
