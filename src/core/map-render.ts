import type { FoldedMap } from './map-fold.js';

function esc(s: string): string {
  return s.replace(/"/g, "'").replace(/[\r\n]+/g, ' ').replace(/`/g, "'");
}

/** mermaid：graph LR + subgraph 分层（按 parent 分组） */
export function renderMermaid(m: FoldedMap): string {
  const L: string[] = ['graph LR'];
  const byParent = new Map<string, string[]>();
  for (const n of m.nodes) {
    const p = n.parent ?? '';
    const arr = byParent.get(p) ?? [];
    arr.push(n.key);
    byParent.set(p, arr);
  }
  const idOf = new Map<string, string>();
  m.nodes.forEach((n, i) => idOf.set(n.key, `n${i}`));
  for (const [parent, keys] of [...byParent.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (parent === '') continue;
    L.push(`  subgraph S_${sanitizeId(parent)}["${esc(parent)}"]`);
    for (const key of keys) {
      const n = m.nodes.find((x) => x.key === key);
      if (n) L.push(`    ${idOf.get(key)}["${esc(n.label)}"]`);
    }
    L.push('  end');
  }
  for (const n of m.nodes) {
    if (n.parent === '' || n.parent === null) L.push(`  ${idOf.get(n.key)}["${esc(n.label)}"]`);
  }
  for (const e of m.edges) {
    const s = idOf.get(e.source);
    const t = idOf.get(e.target);
    if (!s || !t) continue;
    L.push(e.weight > 1 ? `  ${s} -->|"${e.weight}"| ${t}` : `  ${s} --> ${t}`);
  }
  if (m.truncated) L.push('  %% truncated: 低连接度单元已折叠为 (other)');
  return L.join('\n');
}

/** Graphviz DOT：rankdir=LR，parent 相同的进 cluster */
export function renderDot(m: FoldedMap): string {
  const L: string[] = ['digraph codemap {', '  rankdir=LR;', '  node [shape=box, style=rounded];'];
  const clusters = new Map<string, string[]>();
  for (const n of m.nodes) {
    if (n.parent) {
      const arr = clusters.get(n.parent) ?? [];
      arr.push(n.key);
      clusters.set(n.parent, arr);
    }
  }
  let ci = 0;
  const inCluster = new Set<string>();
  for (const [parent, keys] of [...clusters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    L.push(`  subgraph cluster_${ci++} {`, `    label="${esc(parent)}";`);
    for (const key of keys) {
      const n = m.nodes.find((x) => x.key === key);
      if (n) L.push(`    ${JSON.stringify(key)} [label="${esc(n.label)}"];`);
      inCluster.add(key);
    }
    L.push('  }');
  }
  for (const n of m.nodes) {
    if (!inCluster.has(n.key)) L.push(`  ${JSON.stringify(n.key)} [label="${esc(n.label)}"];`);
  }
  for (const e of m.edges) {
    L.push(
      e.weight > 1
        ? `  ${JSON.stringify(e.source)} -> ${JSON.stringify(e.target)} [label="${e.weight}"];`
        : `  ${JSON.stringify(e.source)} -> ${JSON.stringify(e.target)};`,
    );
  }
  L.push('}');
  return L.join('\n');
}

/** codemap-graph v1 JSON（机器可读契约，P5 impact/features 复用） */
export function renderJson(m: FoldedMap): string {
  return JSON.stringify(
    {
      schema: 'codemap-graph/v1',
      level: m.level,
      truncated: m.truncated,
      notes: m.notes,
      nodes: m.nodes,
      edges: m.edges,
    },
    null,
    2,
  );
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}
