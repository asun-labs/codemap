/* CodeMap v3 前端 —— 手写 Canvas 2D，零依赖。
 * 数据来自 /api/graph（CodeMapGraph schema codemap-graph/3）。
 * 结构归属（父子）由 parent 链画树；依赖边按当前可见粒度去重后画贝塞尔线。
 */

// ————————————————————————————— 基础 —————————————————————————————

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const COL_W = 340;          // 层级列宽
const GAP = 12;             // 同级节点垂直间距
const ROOT_GAP = 90;        // 多个 L0 根之间的间距

const COLORS = {
  bg: '#0b0f16',
  line: '#243044',
  ink: '#e6edf7',
  ink2: '#93a1b8',
  ink3: '#64748b',
  accent: '#4d9dff',
  accent2: '#38e0c5',
  warn: '#f0b429',
  dep: '#41546f',
  tree: '#2a3750',
};

const KIND_TEXT = {
  system: '系统', service: '服务', package: '包', module: '模块', file: '文件',
  'external-system': '外部系统', datastore: '数据存储', gateway: '网关',
};

// ————————————————————————————— 状态 —————————————————————————————

let graph = null;              // CodeMapGraph
let byId = new Map();          // id → node
let kidsIdx = new Map();       // parent id → [child ids]（图定义顺序）
let parentOf = new Map();      // id → parent id
let expandSet = new Set();     // 其子节点可见的节点 id
let pos = new Map();           // id → {x, y, tx, ty, w, h}
let selection = null;          // 选中的节点 id
let hovered = null;
let searchQ = '';
let matches = new Set();       // 搜索命中的节点 id
let lastMtime = null;
let cam = { x: 0, y: 0, scale: 1 };
let dirty = true;
let archRendered = false;
let needFit = false;

const opt = { labels: true, expandL2: true };

// ————————————————————————————— 工具 —————————————————————————————

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function nodeH(n) {
  if (n.kind === 'file') return 34;
  return n.level === 0 ? 58 : 46;
}
function nodeW(n) {
  if (n.kind === 'file') return 190;
  return n.level === 0 ? 236 : 214;
}

function visibleChildren(id) {
  if (!expandSet.has(id)) return [];
  return kidsIdx.get(id) ?? [];
}

/** id 沿 parent 链向上找到第一个可见祖先（含自身） */
function resolveVisible(id) {
  let cur = id;
  while (cur != null && !pos.has(cur)) {
    cur = parentOf.get(cur) ?? null;
    if (cur == null) break;
  }
  return cur;
}

function isAncestorOrSelf(anc, node) {
  let cur = node;
  while (cur != null) {
    if (cur === anc) return true;
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

function ancestorsOf(id) {
  const out = [];
  let cur = parentOf.get(id);
  while (cur != null) { out.push(cur); cur = parentOf.get(cur); }
  return out;
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function truncate(c, text, maxW) {
  if (c.measureText(text).width <= maxW) return text;
  while (text.length > 1 && c.measureText(text + '…').width > maxW) text = text.slice(0, -1);
  return text + '…';
}

// ————————————————————————————— 布局 —————————————————————————————

/** 度量可见子树高度（世界坐标 px） */
function measure(id) {
  const n = byId.get(id);
  const self = nodeH(n);
  const kids = visibleChildren(id);
  if (kids.length === 0) return self;
  let sum = 0;
  for (const k of kids) sum += measure(k) + GAP;
  return Math.max(self, sum - GAP);
}

/** 递归落位：y 为该子树顶部 */
function assign(id, x, y) {
  const n = byId.get(id);
  const w = nodeW(n);
  const selfH = nodeH(n);
  const subH = measure(id);
  const target = { x, y: y + (subH - selfH) / 2, w, h: selfH };
  const p = pos.get(id);
  if (p) { p.tx = target.x; p.ty = target.y; p.w = w; p.h = selfH; }
  else pos.set(id, { x: target.x, y: target.y, tx: target.x, ty: target.y, w, h: selfH });
  const kids = visibleChildren(id);
  let ky = y;
  for (const k of kids) {
    assign(k, x + COL_W, ky);
    ky += measure(k) + GAP;
  }
}

function relayout() {
  // 移除已不可见节点的位置（保留其最终位置供动画起点）
  const visible = new Set();
  const walk = (id) => { visible.add(id); for (const k of visibleChildren(id)) walk(k); };
  for (const root of roots()) walk(root);

  const rootsList = roots();
  let totalH = 0;
  for (const r of rootsList) totalH += measure(r) + ROOT_GAP;
  totalH -= ROOT_GAP;

  let y = 0;
  for (const r of rootsList) {
    assign(r, 0, y);
    y += measure(r) + ROOT_GAP;
  }

  // 拖拽固定（pin）：拖过的节点在后续 relayout（展开/收起/搜索）后停在原地。
  // pin 存绝对世界坐标；对每个 pin 计算其新布局槽位与固定点的差值，
  // 把差值应用到该节点的整棵可见子树（保持子树相对关系不散）。
  // 按深度先祖先后后代应用：后代自己的 pin 在继承祖先差值后再对齐到自己的固定点。
  if (pinned.size) {
    for (const id of [...pinned.keys()]) if (!byId.has(id)) pinned.delete(id);
    const depthOf = (id) => { let d = 0, c = id; while (parentOf.get(c)) { d++; c = parentOf.get(c); } return d; };
    const ids = [...pinned.keys()].filter((id) => pos.has(id)).sort((a, b) => depthOf(a) - depthOf(b));
    for (const id of ids) {
      const pin = pinned.get(id);
      const self = pos.get(id);
      if (!self) continue;
      const ddx = pin.ax - self.tx, ddy = pin.ay - self.ty;
      if (Math.abs(ddx) < 0.01 && Math.abs(ddy) < 0.01) continue;
      const walk = (nid) => {
        const p = pos.get(nid);
        if (p) { p.tx += ddx; p.ty += ddy; }
        for (const k of visibleChildren(nid)) walk(k);
      };
      walk(id);
    }
  }

  // 新节点从父节点当前位置生长
  for (const [id, p] of pos) {
    if (!visible.has(id)) { pos.delete(id); continue; }
    if (p.x === undefined) {
      const par = parentOf.get(id);
      const pp = par ? pos.get(par) : null;
      p.x = pp ? pp.x : p.tx; p.y = pp ? pp.y : p.ty;
    }
  }
  dirty = true;
}

function roots() {
  const out = [];
  for (const n of graph.nodes) if (n.parent == null) out.push(n.id);
  // 稳定排序：当前系统在前
  out.sort((a, b) => (byId.get(a).isCurrent ? -1 : 1) - (byId.get(b).isCurrent ? -1 : 1));
  return out;
}

function visibleNodes() {
  const out = [];
  const walk = (id) => { out.push(id); for (const k of visibleChildren(id)) walk(k); };
  for (const r of roots()) walk(r);
  return out;
}

// ————————————————————————————— 边解析 —————————————————————————————

/**
 * 把图的边解析为「当前可见粒度」的边：
 * - 端点向上解析到最近可见祖先；同端点合并。
 * - 粒度去重：若更深层（文件级）可见边已表达同一对祖先间的依赖，跳过聚合边。
 * 返回 {sa, ta, edge} 列表。
 */
function resolveEdges(visibleList) {
  const visibleSet = new Set(visibleList);
  const out = [];
  for (const e of graph.edges) {
    if (e.scope === 'system') { out.push({ sa: e.source, ta: e.target, edge: e }); continue; }
    const sa = visibleSet.has(e.source) ? e.source : resolveVisible(e.source);
    const ta = visibleSet.has(e.target) ? e.target : resolveVisible(e.target);
    if (!sa || !ta || sa === ta) continue;
    out.push({ sa, ta, edge: e });
  }

  // 同对端点合并
  const merged = new Map();
  for (const r of out) {
    const key = `${r.sa}->${r.ta}`;
    const prev = merged.get(key);
    if (prev) {
      prev.weight += r.edge.weight;
      if (!prev.edge.label && r.edge.label) prev.edge = r.edge;
    } else merged.set(key, r);
  }

  // 粒度去重：深粒度优先保留
  const list = [...merged.values()];
  for (const r of list) r.gran = Math.min(byId.get(r.sa)?.level ?? 0, byId.get(r.ta)?.level ?? 0);
  list.sort((a, b) => b.gran - a.gran);

  const kept = [];
  for (const r of list) {
    if (r.edge.scope === 'system') { kept.push(r); continue; }
    let covered = false;
    for (const k of kept) {
      if (k.edge.scope === 'system') continue;
      if (k.sa === r.sa && k.ta === r.ta) { covered = true; break; }
      if (k.gran <= r.gran) continue;
      if (r.sa !== k.sa && isAncestorOrSelf(r.sa, k.sa) && r.ta !== k.ta && isAncestorOrSelf(r.ta, k.ta)) {
        covered = true; break;
      }
    }
    if (!covered) kept.push(r);
  }
  return kept;
}

// ————————————————————————————— 绘制 —————————————————————————————

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.x, dpr * cam.y);

  const visibleList = visibleNodes();
  const edges = resolveEdges(visibleList);

  // 选中态的邻接
  const adjacent = new Set();
  if (selection) {
    for (const r of edges) {
      if (r.sa === selection || r.ta === selection) { adjacent.add(r.sa); adjacent.add(r.ta); }
    }
  }

  // —— 依赖边 ——
  const showLabel = opt.labels && cam.scale >= 0.45;
  for (const r of edges) {
    const a = pos.get(r.sa), b = pos.get(r.ta);
    if (!a || !b) continue;
    const wire = r.edge.scope === 'system';
    const isSel = selection && (r.sa === selection || r.ta === selection);
    const dim = (selection && !isSel) ? 0.18 : 1;
    ctx.save();
    ctx.globalAlpha = dim;
    ctx.strokeStyle = wire ? COLORS.accent2 : COLORS.dep;
    ctx.lineWidth = wire ? 2 : Math.min(1 + Math.log2(Math.max(1, r.edge.weight)) * 0.6, 3.5);
    if (r.edge.confidence === 'inferred' || r.edge.confidence === 'config') ctx.setLineDash([5, 4]);
    const sy = a.y + a.h / 2, ty = b.y + b.h / 2;
    const sx = a.x + a.w, tx = b.x;
    const dx = tx - sx;
    const c1x = sx + Math.max(dx * 0.45, 30), c2x = tx - Math.max(dx * 0.45, 30);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(c1x, sy, c2x, ty, tx, ty);
    ctx.stroke();
    ctx.setLineDash([]);

    // 箭头（终点切线：P3-P2 水平，方向由 tx 与 c2x 的相对位置决定）
    drawArrow(tx, ty, Math.atan2(0, tx - c2x), wire ? COLORS.accent2 : COLORS.dep, dim);

    if (showLabel && (wire || isSel || r.edge.weight >= 3)) {
      const mx = (sx + 3 * c1x + 3 * c2x + tx) / 8;
      const my = (sy + 3 * sy + 3 * ty + ty) / 8;
      const label = r.edge.label || r.edge.protocol || '';
      if (label) {
        ctx.font = '10px ui-monospace, Consolas, monospace';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(11,15,22,0.88)';
        ctx.strokeText(label, mx - ctx.measureText(label).width / 2, my - 4);
        ctx.fillStyle = wire ? COLORS.accent2 : (r.edge.confidence === 'exact' ? COLORS.ink3 : COLORS.warn);
        ctx.fillText(label, mx - ctx.measureText(label).width / 2, my - 4);
      }
    }
    ctx.restore();
  }

  // —— 树链（parent → child）——
  ctx.save();
  ctx.strokeStyle = COLORS.tree;
  ctx.lineWidth = 1;
  for (const id of visibleList) {
    const par = parentOf.get(id);
    if (!par || !pos.has(par)) continue;
    const a = pos.get(par), b = pos.get(id);
    const sy = a.y + a.h / 2, ty = b.y + b.h / 2;
    const sx = a.x + a.w, tx = b.x;
    const midx = (sx + tx) / 2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(midx, sy, midx, ty, tx, ty);
    ctx.stroke();
  }
  ctx.restore();

  // —— 节点（层级升序，文件最后画在最上）——
  const ordered = [...visibleList].sort((a, b) => byId.get(a).level - byId.get(b).level);
  for (const id of ordered) drawNode(id, adjacent);
}

function drawArrow(x, y, ang, color, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-7, -3.2);
  ctx.lineTo(-7, 3.2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawNode(id, adjacent) {
  const n = byId.get(id);
  const p = pos.get(id);
  if (!p) return;
  const expanded = expandSet.has(id) && (kidsIdx.get(id)?.length ?? 0) > 0;
  const collapsed = n.hasChildren && !expanded;

  let alpha = 1;
  if (searchQ && !matches.has(id)) alpha = 0.13;
  else if (selection && id !== selection && !adjacent.has(id) && !isAncestorOrSelf(id, selection) && !isAncestorOrSelf(selection, id)) alpha = 0.4;

  const selected = selection === id;
  const hov = hovered === id;

  ctx.save();
  ctx.globalAlpha = alpha;

  // 配色
  let fill = '#121a28', stroke = COLORS.line, lw = 1;
  if (n.level === 0 && n.isCurrent) { fill = '#14233c'; stroke = COLORS.accent; lw = 1.6; }
  else if (n.external) { fill = '#241d10'; stroke = COLORS.warn; }
  else if (n.level === 0) { fill = '#1d2026'; stroke = '#6b7686'; }
  else if (n.level === 1) { fill = '#131c2c'; stroke = '#5b8dd6'; }
  else if (n.kind === 'file') { fill = '#0f1622'; stroke = COLORS.line; }
  if (hov) { stroke = selected ? stroke : '#8fb8e8'; lw = Math.max(lw, 1.4); }
  if (selected) { stroke = COLORS.accent2; lw = 2; }

  roundRect(ctx, p.x, p.y, p.w, p.h, n.kind === 'file' ? 6 : 9);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lw;
  ctx.stroke();

  if (searchQ && matches.has(id)) {
    ctx.save();
    ctx.strokeStyle = COLORS.accent2;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    roundRect(ctx, p.x - 3, p.y - 3, p.w + 6, p.h + 6, 8);
    ctx.stroke();
    ctx.restore();
  }

  // 文本
  const padL = 10;
  if (n.kind === 'file') {
    ctx.fillStyle = selected ? COLORS.ink : COLORS.ink2;
    ctx.font = '11.5px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncate(ctx, n.label, p.w - padL - 40), p.x + padL, p.y + p.h / 2);
    const sym = n.metrics.symbols;
    if (sym > 0) {
      ctx.fillStyle = COLORS.ink3;
      ctx.font = '10px ui-monospace, Consolas, monospace';
      const t = `${sym}◈`;
      ctx.fillText(t, p.x + p.w - 10 - ctx.measureText(t).width, p.y + p.h / 2);
    }
  } else {
    ctx.fillStyle = COLORS.ink;
    ctx.font = n.level === 0 ? '600 13px "Segoe UI", "PingFang SC", sans-serif' : '12px "Segoe UI", "PingFang SC", sans-serif';
    ctx.textBaseline = 'middle';
    const nameX = p.x + padL + (n.isCurrent ? 12 : 0);
    ctx.fillText(truncate(ctx, n.label, p.w - padL * 2 - (n.isCurrent ? 12 : 0)), nameX, p.y + (n.level === 0 ? 19 : 16));
    if (n.isCurrent) {
      ctx.fillStyle = COLORS.accent2;
      ctx.beginPath();
      ctx.arc(p.x + padL + 4, p.y + 19, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = COLORS.ink3;
    ctx.font = '10px ui-monospace, Consolas, monospace';
    let sub;
    if (n.external) sub = KIND_TEXT[n.kind] ?? n.kind;
    else sub = `${n.metrics.files} 文件 · ${n.metrics.symbols} 符号`;
    ctx.fillText(truncate(ctx, sub, p.w - padL * 2), p.x + padL, p.y + p.h - 13);
  }

  // +N 徽章（可展开且收起）
  if (collapsed) {
    const bx = p.x + p.w, by = p.y + p.h / 2;
    ctx.fillStyle = n.kind === 'file' ? '#3b4a63' : COLORS.accent;
    ctx.beginPath();
    ctx.arc(bx, by, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '600 9.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${n.childNodes}`, bx, by + 0.5);
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

// ————————————————————————————— 动画循环 —————————————————————————————

function tick() {
  requestAnimationFrame(tick); // 先续帧：任何异常都不能打死渲染循环
  if (!graph) return; // 数据未到，等 loadGraph
  let settling = false;
  for (const p of pos.values()) {
    const dx = p.tx - p.x, dy = p.ty - p.y;
    if (Math.abs(dx) > 0.4 || Math.abs(dy) > 0.4) {
      p.x += dx * 0.28; p.y += dy * 0.28;
      settling = true;
    } else { p.x = p.tx; p.y = p.ty; }
  }
  if (settling || dirty) { dirty = false; draw(); }
}

function invalidate() { dirty = true; }

// ————————————————————————————— 相机 —————————————————————————————

function screenToWorld(mx, my) {
  return { x: (mx - cam.x) / cam.scale, y: (my - cam.y) / cam.scale };
}

function contentBBox(ids) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of ids) {
    const p = pos.get(id);
    if (!p) continue;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h);
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

function fitTo(ids) {
  const bb = contentBBox(ids);
  if (!bb) return;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const pad = 70;
  const bw = Math.max(bb.maxX - bb.minX, 1), bh = Math.max(bb.maxY - bb.minY, 1);
  const scale = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh, 1.5);
  cam.scale = Math.max(scale, 0.05);
  cam.x = W / 2 - ((bb.minX + bb.maxX) / 2) * cam.scale;
  cam.y = H / 2 - ((bb.minY + bb.maxY) / 2) * cam.scale;
  invalidate();
  updateZoomLabel();
}

function centerOn(id) {
  const p = pos.get(id);
  if (!p) return;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  cam.scale = Math.max(cam.scale, 0.8);
  cam.x = W / 2 - (p.x + p.w / 2) * cam.scale;
  cam.y = H / 2 - (p.y + p.h / 2) * cam.scale;
  invalidate();
  updateZoomLabel();
}

function updateZoomLabel() {
  $('zoom-label').textContent = `${Math.round(cam.scale * 100)}%`;
}

// ————————————————————————————— 交互 —————————————————————————————

let dragState = null;
/** 被用户拖过的节点 → 绝对世界坐标 {ax,ay}；relayout 后仍停在拖后位置（后代跟随） */
const pinned = new Map();

function hitNode(mx, my) {
  const w = screenToWorld(mx, my);
  let hit = null;
  for (const [id, p] of pos) {
    if (w.x >= p.x && w.x <= p.x + p.w && w.y >= p.y && w.y <= p.y + p.h) hit = id;
  }
  return hit;
}

function hitBadge(mx, my) {
  const w = screenToWorld(mx, my);
  for (const [id, p] of pos) {
    const n = byId.get(id);
    const bx = p.x + p.w, by = p.y + p.h / 2;
    if (n.hasChildren && !expandSet.has(id) && (kidsIdx.get(id)?.length ?? 0) === 0 || (n.hasChildren && !expandSet.has(id))) {
      const dx = w.x - bx, dy = w.y - by;
      if (dx * dx + dy * dy <= 144) return id;
    }
  }
  return null;
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  const rect = canvas.getBoundingClientRect();
  const hit = hitNode(e.clientX - rect.left, e.clientY - rect.top);
  if (hit) {
    // 节点拖拽：连带当前可见子树一起移动
    const start = new Map();
    const walk = (id) => {
      const p = pos.get(id);
      if (p) start.set(id, { x: p.x, y: p.y });
      for (const k of visibleChildren(id)) walk(k);
    };
    walk(hit);
    dragState = { mode: 'node', id: hit, start, mx: e.clientX, my: e.clientY, moved: false, dx: 0, dy: 0 };
    canvas.style.cursor = 'grabbing';
  } else {
    dragState = { mode: 'pan', mx: e.clientX, my: e.clientY, moved: false, camX: cam.x, camY: cam.y };
  }
  canvas.classList.add('dragging');
});

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  if (dragState) {
    const dx = e.clientX - dragState.mx, dy = e.clientY - dragState.my;
    if (Math.abs(dx) + Math.abs(dy) > 4) dragState.moved = true;
    if (!dragState.moved) return;
    if (dragState.mode === 'node') {
      dragState.dx = dx / cam.scale; dragState.dy = dy / cam.scale;
      for (const [id, s] of dragState.start) {
        const p = pos.get(id);
        if (!p) continue;
        p.x = s.x + dragState.dx; p.y = s.y + dragState.dy;
        p.tx = p.x; p.ty = p.y;
      }
    } else {
      cam.x = dragState.camX + dx;
      cam.y = dragState.camY + dy;
    }
    invalidate();
  } else {
    const h = hitNode(mx, my);
    if (h !== hovered) { hovered = h; invalidate(); }
    canvas.style.cursor = h ? 'pointer' : 'grab';
  }
});

canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('dragging');
  const st = dragState;
  dragState = null;
  if (!st) return;
  if (st.moved) {
    if (st.mode === 'node') {
      // 绝对位置固定：拖过的节点与其可见后代都停在拖后的位置，后续 relayout 不回弹
      for (const id of st.start.keys()) {
        const p = pos.get(id);
        if (p) pinned.set(id, { ax: p.x, ay: p.y });
      }
    }
    const rect = canvas.getBoundingClientRect();
    const h = hitNode(e.clientX - rect.left, e.clientY - rect.top);
    canvas.style.cursor = h ? 'pointer' : 'grab';
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const badge = hitBadge(mx, my);
  if (badge) { openDetail(badge); return; }
  const hit = hitNode(mx, my);
  if (!hit) { clearSelection(); return; }
  const n = byId.get(hit);
  if (n.kind === 'file') { openDetail(hit); return; }
  if (n.hasChildren) {
    if (expandSet.has(hit)) expandSet.delete(hit);
    else expandSet.add(hit);
    relayout();
  }
  selection = hit;
  renderDetail();
  invalidate();
});

canvas.addEventListener('dblclick', (e) => {
  const rect = canvas.getBoundingClientRect();
  const hit = hitNode(e.clientX - rect.left, e.clientY - rect.top);
  if (hit) openDetail(hit);
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const before = screenToWorld(mx, my);
  const factor = Math.exp(-e.deltaY * 0.0016);
  cam.scale = Math.min(Math.max(cam.scale * factor, 0.04), 4);
  cam.x = mx - before.x * cam.scale;
  cam.y = my - before.y * cam.scale;
  invalidate();
  updateZoomLabel();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) {
    if (e.key === 'Escape') { e.target.value = ''; applySearch(); e.target.blur(); }
    return;
  }
  if (e.key === 'f' || e.key === 'F') fitTo(visibleNodes());
  if (e.key === 'Escape') clearSelection();
});

// ————————————————————————————— 展开/收起 —————————————————————————————

function expandAll() {
  let count = 0;
  const walk = (id) => {
    if (count > 5000) return;
    const n = byId.get(id);
    if (n.external) return;
    const kids = kidsIdx.get(id) ?? [];
    if (kids.length > 0) { expandSet.add(id); count++; for (const k of kids) walk(k); }
  };
  for (const r of roots()) walk(r);
  relayout();
  fitTo(visibleNodes());
}

function collapseAll() {
  expandSet.clear();
  relayout();
  fitTo(visibleNodes());
}

function revealNode(id) {
  for (const a of ancestorsOf(id)) expandSet.add(a);
  selection = id;
  relayout();
  // 等布局落位后再居中
  requestAnimationFrame(() => centerOn(id));
  renderDetail();
  invalidate();
}

function clearSelection() {
  selection = null;
  $('detail').classList.add('hidden');
  invalidate();
}

// ————————————————————————————— 详情面板 —————————————————————————————

function openDetail(id) {
  selection = id;
  renderDetail();
  $('detail').classList.remove('hidden');
  invalidate();
}

function metricRow(dt, dd) {
  const d = el('dt', null, dt), v = el('dd', null, dd);
  return [d, v];
}

function renderDetail() {
  const box = $('detail-body');
  box.innerHTML = '';
  if (!selection) return;
  const n = byId.get(selection);
  if (!n) return;

  box.appendChild(el('h3', null, n.label));
  box.appendChild(el('div', 'path', n.path ?? `${KIND_TEXT[n.kind] ?? n.kind} · ${n.id}`));

  const dl = el('dl');
  dl.append(...metricRow('层级', `L${n.level} ${['系统', '子系统', '模块', '文件'][n.level]}`));
  dl.append(...metricRow('类型', KIND_TEXT[n.kind] ?? n.kind));
  if (!n.external && n.kind !== 'file') {
    dl.append(...metricRow('文件数', String(n.metrics.files)));
    dl.append(...metricRow('符号数', String(n.metrics.symbols)));
    dl.append(...metricRow('跨文件依赖', String(n.metrics.crossEdges)));
  }
  if (n.kind === 'file') {
    dl.append(...metricRow('符号数', String(n.metrics.symbols)));
  }
  if (n.metrics.languages.length) dl.append(...metricRow('语言', n.metrics.languages.join(', ')));
  if (n.notes?.length) dl.append(...metricRow('备注', n.notes.join('；')));
  box.appendChild(dl);

  // 下级
  const kids = kidsIdx.get(n.id) ?? [];
  if (kids.length > 0) {
    box.appendChild(el('h4', null, `下级（${kids.length}）`));
    const ul = el('ul');
    for (const k of kids.slice(0, 60)) {
      const kn = byId.get(k);
      const li = el('li', null, `${kn.label}${kn.childNodes > 0 && !expandSet.has(kn.id) ? ` (+${kn.childNodes})` : ''}`);
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => { expandSet.add(n.id); revealNode(k); });
      ul.appendChild(li);
    }
    if (kids.length > 60) ul.appendChild(el('li', null, `… 共 ${kids.length} 个`));
    box.appendChild(ul);
  }

  // 依赖
  const rel = graph.edges
    .filter((e) => e.source === n.id || e.target === n.id)
    .sort((a, b) => b.weight - a.weight);
  if (rel.length > 0) {
    box.appendChild(el('h4', null, `关系（${rel.length}）`));
    const ul = el('ul');
    for (const e of rel.slice(0, 40)) {
      const out = e.source === n.id;
      const otherId = out ? e.target : e.source;
      const other = byId.get(otherId);
      const kinds = Object.entries(e.kinds).map(([k, v]) => `${k} ×${v}`).join(' · ');
      const conf = e.confidence !== 'exact' ? ` [${e.confidence}]` : '';
      const li = el('li', null, `${out ? '→' : '←'} ${other?.label ?? otherId}${e.label ? ` (${e.label})` : ''}${kinds ? ` · ${kinds}` : ''}${conf}`);
      li.style.cursor = 'pointer';
      li.title = e.evidence?.slice(0, 3).map((ev) => `${ev.file}:${ev.line}`).join('\n') ?? '';
      li.addEventListener('click', () => revealNode(otherId));
      ul.appendChild(li);
    }
    if (rel.length > 40) ul.appendChild(el('li', null, `… 共 ${rel.length} 条`));
    box.appendChild(ul);
  }

  // 草稿提示
  if (n.level === 0 && graph.systems?.draft) {
    box.appendChild(el('h4', null, '外部系统为自动推测'));
    box.appendChild(el('div', 'path', `编辑 ${graph.systems.configPath ?? '.codemap/systems.yaml'} 确认后重新 analyze`));
  }

  // 查看源码
  if (n.kind === 'file' && n.path) {
    const btn = el('button', 'act', '查看源码');
    btn.addEventListener('click', () => showSource(n.path, box, btn));
    box.appendChild(btn);
  }
}

async function showSource(relPath, box, btn) {
  btn.disabled = true;
  btn.textContent = '加载中…';
  try {
    const res = await fetch(`/api/source?path=${encodeURIComponent(relPath)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const lines = text.split('\n');
    const MAX = 200;
    const shown = lines.slice(0, MAX);
    const pre = el('pre');
    pre.style.cssText = 'background:#0d1320;border:1px solid #243044;border-radius:8px;padding:8px;overflow:auto;max-height:420px;font:11px ui-monospace,Consolas,monospace;color:#93a1b8;margin:8px 0 0;';
    pre.textContent = shown.map((l, i) => `${String(i + 1).padStart(4, ' ')}│ ${l}`).join('\n');
    if (lines.length > MAX) pre.textContent += `\n… 共 ${lines.length} 行，仅显示前 ${MAX} 行`;
    btn.replaceWith(pre);
  } catch (err) {
    btn.textContent = `加载失败: ${err.message}`;
    btn.disabled = false;
  }
}

// ————————————————————————————— 搜索 —————————————————————————————

function applySearch() {
  const q = $('search').value.trim().toLowerCase();
  searchQ = q;
  matches = new Set();
  if (q) {
    for (const n of graph.nodes) {
      if (matches.size >= 300) break;
      if ((n.label && n.label.toLowerCase().includes(q)) ||
          (n.path && n.path.toLowerCase().includes(q))) {
        matches.add(n.id);
      }
    }
    // 展开命中节点的祖先
    for (const m of matches) for (const a of ancestorsOf(m)) expandSet.add(a);
    relayout();
    if (matches.size > 0) fitTo(matches);
    $('level-badge').textContent = `匹配 ${matches.size}`;
  } else {
    relayout();
    updateLevelBadge();
  }
  invalidate();
}

function updateLevelBadge() {
  let maxLv = 0;
  for (const id of pos.keys()) maxLv = Math.max(maxLv, byId.get(id)?.level ?? 0);
  $('level-badge').textContent = `L${maxLv} ${['系统', '子系统', '模块', '文件'][maxLv]}`;
}

// ————————————————————————————— 架构页 —————————————————————————————

function renderArch() {
  const wrap = $('arch');
  wrap.innerHTML = '';
  const a = graph.architecture;
  if (!a || !a.layers || a.layers.length === 0) {
    wrap.appendChild(el('div', 'empty', '没有可用的架构数据（architecture 为空）'));
    return;
  }
  const head = el('div', 'arch-head');
  head.appendChild(el('h2', null, '架构分层'));
  head.appendChild(el('div', 'notes', `${a.strategy}${a.notes?.length ? ' · ' + a.notes.join('；') : ''}`));
  wrap.appendChild(head);

  a.layers.forEach((layer, i) => {
    const card = el('div', 'arch-layer');
    const h3 = el('h3');
    h3.appendChild(el('span', null, `${i + 1}. ${layer.name}`));
    h3.appendChild(el('span', 'count', `${layer.members.length} 个成员 · ${layer.members.reduce((s, m) => s + m.files, 0)} 文件`));
    card.appendChild(h3);
    if (layer.paths.length) card.appendChild(el('div', 'paths', layer.paths.join(' · ')));
    const chips = el('div', 'chips');
    for (const m of layer.members) {
      const chip = el('span', 'chip');
      chip.appendChild(el('span', null, m.label));
      chip.appendChild(el('span', 's', `·${m.files}`));
      chip.title = `${m.label} — ${m.files} 文件 / ${m.symbols} 符号`;
      chip.addEventListener('click', () => {
        if (!byId.has(m.id)) return;
        switchTab('system');
        revealNode(m.id);
      });
      chips.appendChild(chip);
    }
    card.appendChild(chips);
    wrap.appendChild(card);

    if (i < a.layers.length - 1 && layer.edgesToBelow > 0) {
      wrap.appendChild(el('div', 'flow', '')).appendChild(el('span', 'arrow', `↓ 上层 → 下层 ${layer.edgesToBelow} 条依赖`));
    }
  });

  if (a.entrypoints?.length) {
    const card = el('div', 'arch-layer');
    card.appendChild(el('h3', null, '入口 / 出口'));
    const chips = el('div', 'chips');
    for (const ep of a.entrypoints) {
      const chip = el('span', 'chip', ep.label + (ep.protocol ? ` [${ep.protocol}]` : ''));
      chip.title = ep.file + (ep.line != null ? `:${ep.line}` : '');
      chips.appendChild(chip);
    }
    card.appendChild(chips);
    wrap.appendChild(card);
  }

  if (a.unassigned?.length) {
    const card = el('div', 'arch-layer');
    card.appendChild(el('h3', null, '未归层'));
    const chips = el('div', 'chips');
    for (const u of a.unassigned) chips.appendChild(el('span', 'chip', `${u.label} ·${u.files}`));
    card.appendChild(chips);
    wrap.appendChild(card);
  }
}

// ————————————————————————————— 页签 —————————————————————————————

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${tab}`));
  if (tab === 'arch' && !archRendered) { renderArch(); archRendered = true; }
  if (tab === 'system') invalidate();
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// ————————————————————————————— HUD —————————————————————————————

$('btn-fit').addEventListener('click', () => fitTo(visibleNodes()));
$('btn-expand-all').addEventListener('click', expandAll);
$('btn-collapse-all').addEventListener('click', collapseAll);
$('search').addEventListener('input', applySearch);
$('detail-close').addEventListener('click', clearSelection);
$('opt-labels').addEventListener('change', (e) => { opt.labels = e.target.checked; invalidate(); });
$('opt-expand').addEventListener('change', (e) => {
  opt.expandL2 = e.target.checked;
  if (opt.expandL2) {
    for (const n of graph.nodes) if (n.level < 2 && !n.external) expandSet.add(n.id);
  } else {
    for (const n of graph.nodes) if (n.level >= 1) expandSet.delete(n.id);
  }
  relayout();
  fitTo(visibleNodes());
});

// 测试文件开关：分析时已过滤，只能重新分析
(() => {
  const t = $('opt-tests');
  t.disabled = true;
  t.title = '测试文件在分析时已过滤（CLI 端可配置）；如需显示请重新分析';
})();

// ————————————————————————————— 数据加载 —————————————————————————————

function applyGraph(g, keepState) {
  const prevExpand = keepState ? new Set(expandSet) : null;
  graph = g;
  byId = new Map(g.nodes.map((n) => [n.id, n]));
  kidsIdx = new Map();
  parentOf = new Map();
  for (const n of g.nodes) {
    if (n.parent != null) {
      parentOf.set(n.id, n.parent);
      const arr = kidsIdx.get(n.parent) ?? [];
      arr.push(n.id);
      kidsIdx.set(n.parent, arr);
    }
  }
  // 兄弟排序：文件按名字，模块按名字（构建端已按路径序，这里稳定即可）
  for (const arr of kidsIdx.values()) arr.sort((a, b) => (byId.get(a).path ?? '').localeCompare(byId.get(b).path ?? ''));

  if (prevExpand) {
    expandSet = new Set([...prevExpand].filter((id) => byId.has(id)));
  } else {
    expandSet = new Set();
    if (opt.expandL2) for (const n of g.nodes) if (n.level < 2 && !n.external) expandSet.add(n.id);
  }

  pos = new Map();
  relayout();

  // 顶栏
  $('project-name').textContent = g.project.name;
  const st = g.project.stats;
  const lang0 = g.project.languages?.[0];
  $('project-meta').textContent =
    `${st.files} 文件 · ${st.symbols} 符号 · ${g.project.sourceKind === 'git' ? 'git' : '本地'}${lang0 ? ` · ${lang0.language}` : ''}`;
  updateLevelBadge();
  updateZoomLabel();

  // 警告
  const warn = $('warn');
  warn.innerHTML = '';
  for (const w of g.warnings ?? []) warn.appendChild(el('div', null, w));

  archRendered = false;
  if (document.querySelector('#pane-arch').classList.contains('active')) { renderArch(); archRendered = true; }

  if (selection && byId.has(selection)) renderDetail();
  else clearSelection();
  invalidate();
}

async function loadGraph(keepState) {
  try {
    const res = await fetch('/api/graph');
    if (res.status === 503) {
      $('warn').innerHTML = '';
      $('warn').appendChild(el('div', null, '还没有分析结果，请先运行: codemap analyze [路径或 git 地址]'));
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const g = await res.json();
    applyGraph(g, keepState);
    if (!keepState || needFit) { fitTo(visibleNodes()); needFit = false; }
  } catch (err) {
    $('warn').innerHTML = '';
    $('warn').appendChild(el('div', null, `加载失败: ${err.message}`));
  }
}

async function pollMeta() {
  try {
    const res = await fetch('/api/meta');
    if (!res.ok) return;
    const m = await res.json();
    if (m.mtime != null && m.mtime !== lastMtime) {
      const first = lastMtime == null;
      lastMtime = m.mtime;
      if (!first) await loadGraph(true); // 图文件变了 → 静默刷新，保留展开状态
    }
  } catch { /* 静默 */ }
}

// ————————————————————————————— 画布尺寸 —————————————————————————————

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    invalidate();
  }
}
new ResizeObserver(resize).observe(canvas);

// ————————————————————————————— 启动 —————————————————————————————

resize();
pollMeta().then(() => loadGraph(false));
setInterval(pollMeta, 5000);
requestAnimationFrame(tick);

// 调试/自动化钩子（Playwright 断言用；只读）
window.__cmdbg = {
  get cam() { return { ...cam }; },
  get pos() { return Object.fromEntries(pos); },
  get graph() { return graph; },
  get expandSet() { return [...expandSet]; },
  visible: visibleNodes,
  roots,
};
