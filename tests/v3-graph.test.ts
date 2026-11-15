import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RawEdge, RawNode, RawUnresolved, UpstreamGraph } from '../src/codegraph/reader.js';
import { isExcludedPath, isTestFile } from '../src/codegraph/reader.js';
import { buildFileGraph, buildModuleTree, resolveImportSpec } from '../src/analyze/file-graph.js';
import { detectRepo } from '../src/analyze/detect-repo.js';
import { parseSystemsYaml, renderSystemsYaml, toExternalSys, __test } from '../src/analyze/systems-file.js';
import { buildLayeredGraph, moduleNodeId } from '../src/analyze/layered-graph.js';
import type { ProjectInfo } from '../src/model/schema.js';
import type { ExternalSys } from '../src/analyze/systems-layer.js';

// ---------- 合成 UpstreamGraph ----------

function node(p: Partial<RawNode> & { id: string; kind: string }): RawNode {
  return {
    name: p.id,
    qualifiedName: p.id,
    filePath: '',
    language: 'typescript',
    startLine: 1,
    endLine: 10,
    isExported: true,
    ...p,
  };
}

function makeUp(nodes: RawNode[], edges: RawEdge[], unresolved: RawUnresolved[] = []): UpstreamGraph {
  const map = new Map(nodes.map((n) => [n.id, n]));
  return {
    nodes: map,
    edges,
    unresolved,
    meta: {},
    copiedAside: false,
    fileCount: [...map.values()].filter((n) => n.kind === 'file').length,
    dispose() {},
  };
}

/** 4 文件小仓库：src/a.ts、src/b.ts、src/util/deep/c.ts、main.ts + 1 测试 + 1 node_modules */
function demoUp(): UpstreamGraph {
  const nodes: RawNode[] = [
    node({ id: 'file:src/a.ts', kind: 'file', filePath: 'src/a.ts', endLine: 20 }),
    node({ id: 'file:src/b.ts', kind: 'file', filePath: 'src/b.ts' }),
    node({ id: 'file:src/util/deep/c.ts', kind: 'file', filePath: 'src/util/deep/c.ts' }),
    node({ id: 'file:main.ts', kind: 'file', filePath: 'main.ts' }),
    node({ id: 'file:src/a.test.ts', kind: 'file', filePath: 'src/a.test.ts' }),
    node({ id: 'file:node_modules/x/index.js', kind: 'file', filePath: 'node_modules/x/index.js' }),
    node({ id: 'n:fooA', kind: 'function', name: 'fooA', filePath: 'src/a.ts' }),
    node({ id: 'n:fooB', kind: 'function', name: 'fooB', filePath: 'src/b.ts' }),
    node({ id: 'import:abc', kind: 'import', name: './b.js', filePath: 'src/a.ts' }),
  ];
  const edges: RawEdge[] = [
    { source: 'file:src/a.ts', target: 'import:abc', kind: 'imports', line: 1, metadata: null },
    { source: 'n:fooA', target: 'n:fooB', kind: 'calls', line: 5, metadata: null },
    { source: 'file:src/a.ts', target: 'file:src/a.test.ts', kind: 'imports', line: 9, metadata: null },
  ];
  const unresolved: RawUnresolved[] = [
    { fromNodeId: 'n:fooA', referenceName: 'nope', referenceKind: 'call', filePath: 'src/a.ts', line: 7 },
  ];
  return makeUp(nodes, edges, unresolved);
}

function projectOf(root: string, name = 'demo'): ProjectInfo {
  return {
    name,
    root,
    source: root,
    sourceKind: 'local',
    languages: [{ language: 'typescript', files: 4 }],
    analyzedAt: new Date().toISOString(),
    stats: { files: 4, symbols: 2, edges: 2, unresolvedRefs: 1, testsFiltered: 1, coverage: 0.9 },
  };
}

// ---------- 文件级图 ----------

describe('buildFileGraph（过滤 + import 解析 + 文件级聚合）', () => {
  it('测试文件与 node_modules 被过滤，imports 解析成文件边并与 calls 合并', () => {
    const fg = buildFileGraph(demoUp());
    assert.equal(fg.stats.totalFiles, 6);
    assert.equal(fg.stats.keptFiles, 4);
    assert.equal(fg.stats.testsFiltered, 1);
    assert.equal(fg.stats.excludedFiltered, 1);
    assert.equal(fg.stats.symbols, 2);
    assert.equal(fg.stats.unresolvedRefs, 1);
    // import 边 + calls 边 → 同一对文件合并成一条 weight=2
    assert.equal(fg.edges.length, 1);
    const e = fg.edges[0] as (typeof fg.edges)[number];
    assert.equal(e.source, 'src/a.ts');
    assert.equal(e.target, 'src/b.ts');
    assert.equal(e.weight, 2);
    assert.deepEqual(e.kinds, { imports: 1, calls: 1 });
    assert.equal(e.line, 1);
    assert.ok(fg.files.get('src/a.ts')?.outFiles.has('src/b.ts'));
  });

  it('includeTests: true 时测试文件进图', () => {
    const fg = buildFileGraph(demoUp(), { includeTests: true });
    assert.equal(fg.stats.keptFiles, 5);
    assert.equal(fg.stats.testsFiltered, 0);
  });

  it('resolveImportSpec：TS 的 ./x.js 改写 ./x.ts、index.*、dotted、解析不到返回 null', () => {
    const files = new Map([
      ['src/b.ts', {}],
      ['src/util/deep/index.ts', {}],
      ['pkg/mod.py', {}],
    ]);
    assert.equal(resolveImportSpec('src/a.ts', './b.js', files), 'src/b.ts');
    assert.equal(resolveImportSpec('src/a.ts', './util/deep', files), 'src/util/deep/index.ts');
    assert.equal(resolveImportSpec('src/a.ts', '../pkg/mod', files), 'pkg/mod.py');
    assert.equal(resolveImportSpec('src/a.ts', 'node:fs', files), null);
    assert.equal(resolveImportSpec('src/a.ts', 'express', files), null);
    assert.equal(resolveImportSpec('src/a.ts', './nope', files), null);
  });

  it('isTestFile / isExcludedPath 边界', () => {
    assert.ok(isTestFile('src/a.test.ts'));
    assert.ok(isTestFile('tests/e2e/login.spec.ts'));
    assert.ok(isTestFile('python/conftest.py'));
    assert.ok(!isTestFile('src/contest.ts'), 'test 作为子串不应误判');
    assert.ok(isExcludedPath('node_modules/x/index.js'));
    assert.ok(isExcludedPath('dist/bundle.js'));
    assert.ok(!isExcludedPath('src/dist-helper.ts'));
  });
});

// ---------- 模块树 ----------

describe('buildModuleTree（压链 + 散文件桶）', () => {
  it('单子目录链压成一个节点，≤3 散文件合成桶', () => {
    const fg = buildFileGraph(demoUp());
    const tree = buildModuleTree(fg);
    // 根：main.ts 成散文件桶 + src
    assert.equal(tree.path, '');
    assert.equal(tree.totalFiles, 4);
    const looseRoot = tree.children.find((c) => c.isLoose);
    assert.ok(looseRoot, '根下 1 个散文件应成桶');
    assert.deepEqual(looseRoot?.files, ['main.ts']);
    const src = tree.children.find((c) => c.path === 'src');
    assert.ok(src, 'src 有多个成员不成桶不压链');
    // src/util/deep 压链后只剩一个节点
    const deep = src?.children.find((c) => c.path === 'src/util/deep');
    assert.ok(deep, 'util→deep 单链应压缩');
    assert.deepEqual(deep?.files, ['src/util/deep/c.ts']);
    assert.ok(!src?.children.some((c) => c.path === 'src/util'), '压缩后不应残留中间层');
  });
});

// ---------- monorepo 探测 ----------

describe('detectRepo（workspaces / 服务目录）', () => {
  it('package.json workspaces 识别 monorepo 与包类型', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-detect-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'mono', workspaces: ['packages/*', 'services/*'] }),
      );
      for (const [rel, name] of [
        ['packages/core', '@mono/core'],
        ['packages/web', '@mono/web'],
        ['services/auth-svc', 'auth-svc'],
      ] as const) {
        fs.mkdirSync(path.join(dir, rel), { recursive: true });
        fs.writeFileSync(path.join(dir, rel, 'package.json'), JSON.stringify({ name }));
      }
      const d = detectRepo(dir);
      assert.equal(d.monorepo, true);
      assert.equal(d.packages.length, 3);
      const core = d.packages.find((p) => p.dir === 'packages/core');
      assert.equal(core?.name, '@mono/core');
      assert.equal(core?.kind, 'package');
      const web = d.packages.find((p) => p.dir === 'packages/web');
      assert.equal(web?.kind, 'app', 'web 目录名 → app');
      const svc = d.packages.find((p) => p.dir === 'services/auth-svc');
      assert.equal(svc?.kind, 'service');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('单包仓库 monorepo=false', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-single-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'solo' }));
      const d = detectRepo(dir);
      assert.equal(d.monorepo, false);
      assert.equal(d.packages.length, 0);
      assert.equal(d.rootName, 'solo', 'rootName 取 package.json 的 name');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- systems.yaml ----------

describe('systems.yaml 解析与回写', () => {
  const YAML = [
    '# 注释行',
    'draft: false',
    '',
    'current:',
    '  id: current',
    '  name: 业务系统',
    '  description: 核心业务',
    '',
    'systems:',
    '  - id: sso',
    '    name: 用户登录系统',
    '    kind: external',
    '    description: 统一认证，签发 JWT',
    '    tags: auth, sso',
    '',
    'edges:',
    '  - source: current',
    '    target: sso',
    '    protocol: http',
    '    label: 跳转登录',
    '    direction: two-way',
    '',
  ].join('\n');

  it('parseSystemsYaml：三节齐全，标量去引号，tags 切分', () => {
    const p = parseSystemsYaml(YAML);
    assert.equal(p.current?.name, '业务系统');
    assert.equal(p.systems.length, 1);
    assert.equal(p.systems[0]?.id, 'sso');
    assert.deepEqual(p.systems[0]?.tags, ['auth', 'sso']);
    assert.equal(p.edges.length, 1);
    assert.equal(p.edges[0]?.protocol, 'http');
    assert.equal(p.edges[0]?.direction, 'two-way');
  });

  it('renderSystemsYaml → parse 往返一致，建议稿带 draft: true', () => {
    const detected: ExternalSys[] = [
      {
        id: 'mysql-main',
        name: 'MySQL 主库',
        kind: 'datastore',
        protocol: 'db',
        evidence: [{ file: 'src/db.ts', line: 3 }],
        confidence: 'inferred',
        direction: 'call-out',
      },
    ];
    const text = renderSystemsYaml({ projectName: '订单系统', projectRoot: '/tmp/x', detected });
    assert.match(text, /draft: true/);
    const p = parseSystemsYaml(text);
    assert.equal(p.current?.name, '订单系统');
    assert.equal(p.systems[0]?.id, 'mysql-main');
    assert.equal(p.edges[0]?.source, 'current');
    assert.equal(p.edges[0]?.target, 'mysql-main');
    assert.equal(p.edges[0]?.protocol, 'db');
  });

  it('toExternalSys：yaml 人工确认 → confidence=config，guessKind 认出 auth', () => {
    const p = parseSystemsYaml(YAML);
    const ext = toExternalSys(p);
    assert.equal(ext.length, 1);
    assert.equal(ext[0]?.confidence, 'config');
    assert.equal(ext[0]?.protocol, 'http');
    assert.equal(ext[0]?.direction, 'both');
    assert.equal(__test.guessKind({ name: '用户登录系统', id: 'sso', kind: 'external' }), 'auth');
  });
});

// ---------- 分层图 ----------

describe('buildLayeredGraph（L0–L3 + 系统骨架）', () => {
  it('单包仓库：L0=1 系统节点，L2/L3 父链正确，文件边聚合', () => {
    const up = demoUp();
    const out = buildLayeredGraph({
      up,
      detection: { manifests: ['package.json'], monorepo: false, packages: [], rootName: 'demo', deployHints: [] },
      project: projectOf('/tmp/demo'),
    });
    const { nodes, edges, fileGraph } = out;

    const l0 = nodes.filter((n) => n.level === 0);
    assert.equal(l0.length, 1);
    assert.equal(l0[0]?.id, 'sys:__current__');
    assert.equal(l0[0]?.isCurrent, true);
    assert.equal(l0[0]?.metrics.files, fileGraph.files.size);
    assert.equal(l0[0]?.external, false);

    // 文件层：4 个文件节点；src 的直接文件 ≤3 → 挂在散文件桶下
    const files = nodes.filter((n) => n.kind === 'file');
    assert.equal(files.length, 4);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const parentOf = (fid: string) => byId.get(fid)?.parent;
    assert.equal(parentOf('file:src/a.ts'), moduleNodeId(null, 'src/\u0000loose'));
    assert.equal(parentOf('file:src/b.ts'), moduleNodeId(null, 'src/\u0000loose'));
    assert.equal(parentOf('file:src/util/deep/c.ts'), moduleNodeId(null, 'src/util/deep'));
    assert.ok(parentOf('file:main.ts')?.startsWith('mod/'), '根散文件的父应是模块节点');

    // 文件边进了图，且端点都在节点集里
    const ab = edges.find((e) => e.source === 'file:src/a.ts' && e.target === 'file:src/b.ts');
    assert.ok(ab, 'a.ts→b.ts 文件边应存在');
    assert.equal(ab?.weight, 2);
    assert.ok(edges.every((e) => byId.has(e.source) && byId.has(e.target)), '边端点必须都在节点集');

    // 模块指标：src 子树 3 个文件
    const modSrc = byId.get(moduleNodeId(null, 'src'));
    assert.equal(modSrc?.metrics.files, 3);
  });

  it('人工确认的外部系统：L0 出现外部节点 + 带协议的 wire 边', () => {
    const confirmed: ExternalSys[] = [
      {
        id: 'sso',
        name: '用户登录系统',
        kind: 'auth',
        protocol: 'http',
        evidence: [{ file: 'README.md', line: 1 }],
        confidence: 'exact',
        direction: 'call-out',
      },
    ];
    const out = buildLayeredGraph({
      up: demoUp(),
      detection: { manifests: ['package.json'], monorepo: false, packages: [], rootName: 'demo', deployHints: [] },
      project: projectOf('/tmp/demo'),
      externalSystems: confirmed,
    });
    const ext = out.nodes.find((n) => n.id === 'sys:sso');
    assert.ok(ext, '外部系统节点 sys:sso 应存在');
    assert.equal(ext?.level, 0);
    assert.equal(ext?.external, true);
    const wire = out.edges.find((e) => e.scope === 'system');
    assert.ok(wire, '应有系统级 wire 边');
    assert.equal(wire?.kind, 'wire');
    assert.equal(wire?.protocol, 'http');
    assert.equal(wire?.source, 'sys:__current__');
    assert.equal(wire?.target, 'sys:sso');
    assert.equal(wire?.confidence, 'exact');
  });
});
