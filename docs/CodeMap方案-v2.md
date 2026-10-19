# CodeMap 代码地图 — 方案 v2

> 看清一个工程的结构 —— 每个功能的脉络，画成图。

| 项 | 值 |
| --- | --- |
| 英文名 | CodeMap |
| 中文名 | 代码地图 |
| 形态 | MCP server + CLI 二合一（stdio） |
| npm 包 | `@<scope>/codemap`（bin `codemap`）—— scope 待定，见 §13 |
| MCP id | `codemap` |
| 核心工件 | `.codemap/codemap.db`（镜像图 + 派生数据，绝不写上游） |
| 硬依赖 | codegraph `>=1.2.0 <2`（关键事实已按本机 1.2.0 源码核对，见 §14） |
| 软依赖 | rea（rea-agents）`>=6.7 <7`，按需 |
| 版本 | v2，基线 v1（2026-10-19）+ 评审修订 |

---

## 0. v1 → v2 修订记录

| # | 修订 | 理由 |
| --- | --- | --- |
| 1 | 切片规则定稿：废除「出度>N 进 shared」，改为「跨 feature fan-in ≥ K」；补争议节点归属、合并度量（containment）、巨入口降级、tests 入口默认关 | v1 的出度规则会把编排层错划进 shared；争议归属/度量/巨入口全都没定义 |
| 2 | **coverage 公式定稿**（四态阈值写死） | v1 全文没定义 coverage，但 doctor（P0）的「覆盖评级」就要用它 |
| 3 | 「不做解析」口径修正：**不做全量 AST/符号解析；adapter 允许轻量模式匹配，产物一律 `inferred/partial`**，且必须与 codegraph 符号按 file:line 缝合 | v1 §3 与 §6.2 自相矛盾（识别 `app.get()` 就是解析），不拍板实现必摇摆 |
| 4 | **镜像工件升为核心**：ETL 一次性把 L0–L2 导入 `.codemap.db`，此后全部工具只读自家库；schema 失配从「降级到 CLI（实质残废）」改为「stale 镜像继续用 + doctor 如实报告」 | 上游 CLI 没有任何图遍历命令（已核对），失配时走 CLI 等于核心功能清零 |
| 5 | 异步边界收窄：`ensure_index` → `check_index`（只检查不代跑）；`pierce` 同步+超时+缓存；**CodeMap 不拉起长驻进程** | 首次索引小时级、rea 分钟级，同步阻塞 MCP 不可用；v1「绝不 kill daemon」与 ensure_index 会启动 daemon 冲突 |
| 6 | 新增 `codemap_get(handle)`（第 13 个工具），handle 落 `.codemap.db` 带 TTL | v1 承诺「摘要 + handle 再取细节」，但没有任何工具能完成取件 |
| 7 | 探测修正：扫 `npm prefix -g`（v1 写的 `npm root -g` 是错的，shim 在 prefix 根目录，本机已实测）；**禁用 `npx -y`** 做存在性检查（会静默下载执行，违反铁律 1） | 本机实测 `C:\nvm\nodejs\codegraph.ps1`；npx -y 违反自己的铁律 |
| 8 | setup 自身条目：默认 `--print-config` 输出粘贴片段；`--write` 用注释保留式行级插入，**禁止 JSON.parse→stringify 往返**（会删掉用户 JSONC 注释） | v1 一边说「写配置最容易写坏」一边自己写配置；学 codegraph 已有的 `install --print-config` 模式（已核对） |
| 9 | 工具数 11→**13**；`trace` 排期补入 P3；★ 净增量标注修正（map/features/describe_feature 也是净增量） | v1 标题与列表不符；trace 无排期；★ 与 §2.2 矛盾 |
| 10 | map 默认值定稿（`level=system, maxNodes=60`）；`scope`/`focus` 枚举定义；system 级折叠算法定义（目录/包边界自适应） | v1 的 map 签名里 `scope` 全文没定义；P1 验收依赖的折叠算法没写 |
| 11 | 技术栈：better-sqlite3 → **node:sqlite**（与上游同驱动、零原生编译）；删 simple-git（staleness 以 `status --json` 为准）；删 worker_threads（暂无已证实的重计算） | 上游用 node:sqlite + WAL（已核对）；better-sqlite3 prebuild 是纯运维风险；git 状态与索引状态会分叉 |
| 12 | 风险表增补：跨平台（仅 Windows 实测）、镜像盘占用 | v1 风险表缺口 |
| 13 | staleness source of truth = `codegraph status --json`（pendingChanges + reindexRecommended），不自己用 git 猜 | 消除 v1 simple-git 方案的分叉问题 |
| 14 | 默认**只注册 codemap 一个 MCP**，`--with-upstream-mcp` 叠加 | codegraph 自带 8 个 MCP 工具（已核对），双注册会与薄封装重复、摊薄 agent 上下文；v1 §4.3 与 §7 本来就互相矛盾 |

---

## 1. 要解决的问题

给定一个代码工程，回答三个问题，并且**画成图**：

1. 这个工程由哪些部分组成，怎么连起来的？（拓扑）
2. 每个功能的脉络是什么？入口在哪，经过哪些层，落到哪张表？（功能切片）
3. 哪些地方我**没看清**？（诚实的覆盖度）

第 3 点是设计核心。任何代码分析都有盲区——反射、DI 容器、动态 import、字符串拼接的路由、预编译二进制依赖。不标注盲区的图是在误导使用者（尤其是 agent，它会基于不完整的图下错结论）。

---

## 2. 为什么不自己写解析器

### 2.1 实测：codegraph 已经把符号层做完了

在一个真实的 Electron 桌面工程（约 5,900 个源文件）上实测其 `.codegraph/codegraph.db`：

```
nodes    109,456
edges    423,920
unresolved_refs  595,593

edge kind:  calls 189,781 | contains 116,222 | imports 54,303
            references 52,768 | instantiates 10,382
            extends 380 | implements 60 | decorates 24

node kind:  import 30,543 | function 27,000 | constant 20,697
            method 10,149 | file 5,913 | type_alias 3,635
            variable 3,572 | interface 3,249 | property 2,365
            class 1,763 | component 565 | struct 5

files:      typescript 4,369 | python 665 | vue 565
            javascript 292 | yaml 41 | tsx 12 | xml 9 | rust 1
```

结论：**模块图（L1）与符号图（L2）是已解决问题**。再写一遍 tree-sitter / SCIP 解析器是纯粹的重复劳动。

### 2.2 codegraph 没做的三件事

| 缺口 | 说明 |
| --- | --- |
| **画不出图** | 有 `explore` / `node` / `callers` / `impact`，但输出是源码与文本列表，没有任何图形产物 |
| **没有功能层** | 只有符号，没有「功能 = 入口 + 可达子图」这一层语义 |
| **边界会断** | 遇到 `.node` / `.dll` / `.wasm` / `.asar` / 预编译 jar 就停止，图在这里悄悄断裂且不告知 |

另（已核对）：codegraph 的提取器**不产出 route 节点**（node kind 里有 `route`，实测工程 0 个）——HTTP/IPC 运行时拓扑是 CodeMap 的活。

### 2.3 `unresolved_refs` 是金矿

59.5 万条未解析引用，分布：

```
calls 472,388 | imports 47,747 | references 46,200
instantiates 19,143 | function_ref 9,379
extends 508 | decorates 214 | implements 14
```

这张表本质上是 codegraph 自己记录的「我没解析出来的东西」。**直接按文件/模块/功能聚合，就是现成的 coverage 与 limitations 数据源**，不需要自己估算。目前没有任何工具把它暴露给使用者。

（已核对 schema：`unresolved_refs` 携带 `from_node_id / reference_name / reference_kind / line / col / candidates / file_path / language`——按文件聚合与 feature limitations 派生的数据基础完全成立，见 §14。）

### 2.4 rea 的定位：越界工具

REA (Reverse Engineer Anything) v6.7.0，MIT。它面向**没有源码的成品**：native 二进制（Hopper/Ghidra/IDA/rizin/objdump）、Electron/ASAR、.NET、APK、固件、wasm、EVM、运行时（Frida/CDP/GDB/pcap），100+ CLI 命令，全部支持 `--json`。

它不是「另一个代码分析器」，而是 **codegraph 撞墙时的越界工具**。

---

## 3. 架构

```
                     ┌────────────────────────────────────┐
   agent ───MCP────► │              CodeMap               │
                     │  L3 功能切片 / L4 运行时拓扑          │
                     │  聚合折叠 / 渲染 / 边界缝合            │
                     │  coverage 与 limitations              │
                     └───┬───────────────────────┬────────┘
                         │ ETL 镜像（唯一触上游）    │ 子进程 --json
                    ┌────▼────────┐          ┌────▼─────┐
                    │ .codemap/   │          │   rea    │
                    │ codemap.db  │          │ 无源码侧  │
                    │（全部工具只读）│          └──────────┘
                    └────▲────────┘
                         │ 只读打开（仅 ETL 时）
                    ┌────┴──────┐
                    │ codegraph │
                    │  有源码侧  │
                    └───────────┘
```

CodeMap 自身**不做全量解析**，是编排 + 镜像 + 投影 + 渲染层。

### 3.1 五层模型

| 层 | 内容 | 来源 |
| --- | --- | --- |
| **L0 物理** | 目录、文件、语言、体积、内容哈希 | codegraph `files` 表 |
| **L1 模块** | 文件/包，imports / exports | codegraph `nodes(kind=file,module)` + `edges(imports)` |
| **L2 符号** | 函数/类/方法，calls / implements / references / instantiates | codegraph `nodes` + `edges` |
| **L3 功能** | feature = 入口点 + 可达子图（**用户要的「脉络」**） | CodeMap 新增：切片算法（§6.1 定稿规则） |
| **L4 运行时** | HTTP 路由 / IPC 通道 / DB 表 / 外部服务 / 进程边界 | CodeMap 新增：框架适配器（§6.2 口径） |

每个节点统一携带：`id`、`kind`、`label`、`evidence[]`（file:line）、`confidence`（exact / inferred / partial）、`limitations[]`。

### 3.2 边界缝合 —— CodeMap 存在的理由

codegraph 的图在这些地方会断，而断点恰恰是工程里最关键的位置：

| 断点 | codegraph 看到的 | CodeMap 调 rea 补的 |
| --- | --- | --- |
| `require('./build/x.node')` 原生插件 | 一个指向虚空的 import 节点 | `rea inspect-analysis-view` / `inspect-binary-layout` → 导出函数表，接回 L2 |
| vendored `.dll` / `.so` / `.dylib` | 完全不可见 | `rea inspect-artifact` → 导出符号 + 依赖链 |
| 打包的 `app.asar` / 第三方 Electron 包 | 二进制，跳过 | `rea analyze-javascript-application` → 模块、IPC、preload 边界 |
| 预编译 `.jar` / .NET `.dll` | 只有 import 字面量 | `rea inspect-managed-artifact` / `inspect-android-package` |
| `.wasm` | 黑盒 | `rea inspect-wasm-artifact` → 导入导出接口 |
| 纯二进制交付物 / 无源码对标产品 | 整个项目无法索引 | rea 全家桶；CodeMap 退化为纯 rea 的拓扑渲染前端 |

**一句话定位**：codegraph 给源码内的脉络，rea 跨过源码的边界，CodeMap 把两边缝成一张图并画出来。

单用 codegraph 画不出完整拓扑（边界断），单用 rea 看不懂源码意图（本就不为源码设计）。两者的交集才是净增量。

缝合匹配规则：rea 导出函数表与 L2 的断点按**符号名**匹配，命中标 `confidence: partial`（名称匹配是弱证据），未命中进该边界的 `limitations[]`。

### 3.3 镜像工件 `.codemap/codemap.db`（v2 核心工件）

- **ETL**：`codegraph status --json` 校验版本白名单 → 只读打开上游库 → 全量导出 L0–L2（nodes / edges / unresolved_refs / files）进自家库，打上 `extraction_version` 与 `mirrored_at` 戳。
- 此后 **13 个工具的日常读取全部只碰自家库**；上游 SQLite 只在 ETL 时打开。
- 表结构草案：镜像表（`nodes / edges / unresolved_refs / files`，保留上游 id + 内容哈希）+ 派生表（`slices / projections / handles / pierce_cache / meta`）。
- **失配策略**：上游 `extraction_version` 不在白名单 → **不重建**，旧镜像继续可用、标 `stale`，doctor 如实报告「上游已变更，建议 `codegraph index` 重建后 `codemap` 重新镜像」。v1 的「降级到 CLI」降级为核对通道——CLI 没有图遍历命令（已核对），承担不了切片/渲染。
- **增量策略**：上游节点 id 由 `(file_path, kind, name, line)` 派生（已核对 `generateNodeId`），代码挪行 id 即变——**不做 id 级增量，ETL 全量重建**（10 万节点量级预算 < 60s）；content-hash 对齐的增量优化留待 profile 证明需要。
- 磁盘预算：10 万节点级 < 300MB/工程；`codemap clean` 清理。`.codemap/` 已 gitignore。
- 并发：自家库 WAL + `busy_timeout=5000`；多 agent 进程并发访问同一库安全。
- handle 与投影存 `projections / handles` 表（TTL 1h），server 重启后 handle 仍有效。

---

## 4. 依赖自举

### 4.1 探测顺序（v2 修订）

```
1. CodeMap 配置里的显式路径（最高优先）
2. PATH 查找：where.exe <name>（Windows）/ command -v（POSIX）
3. npm prefix -g 下扫 shim：<name>.cmd / <name>.ps1 / 无后缀
   ⚠️ v1 写的「npm root -g」是错的——shim 在 prefix 根目录，
   本机实测：C:\nvm\nodejs\codegraph.ps1（npm root -g 指向 node_modules，那里没有 shim）
4. npm ls -g --depth=0 确认包在册（只读查询）
```

**四步全部只是「找」**，找不到就报告缺失 + 给手工指令。

**铁律补充：存在性检查禁止 `npx -y <pkg>`**——它会静默下载并执行包，违反铁律 1。v1 的「最后兜底 npx」废除。

### 4.2 分级安装策略

| 依赖 | 必需性 | 缺失时行为 |
| --- | --- | --- |
| **codegraph** | **硬依赖** | 没有它 CodeMap 无法工作。`setup` 明示后，**经用户确认**执行 `npm i -g @colbymchenry/codegraph` |
| **rea** | **软依赖（按需）** | 不阻塞。仅当扫描到二进制边界时提示「发现 N 个原生插件无法穿透，装 rea 可补全」，**用户同意才装** |
| rea 的 native provider（Hopper / Ghidra / IDA） | 可选 | **绝不自动装**（GB 级）。只做能力声明与缺失说明 |

三条铁律（不变）：

- **绝不静默 `npm i -g`**。必须明示包名、版本、registry 来源、磁盘占用，等待用户确认。
- **提供 `--offline` / `--no-install`**。内网与离线环境只报告，并给出手工安装指令。
- **版本兼容矩阵硬校验**：校验入口是 `codegraph status --json` 的 `index.builtWithExtractionVersion / index.currentExtractionVersion`（已核对，稳定 CLI 通道），不在白名单内则不重建镜像，旧镜像标 stale。

### 4.3 MCP 注册（v2 修订）

```
codemap setup
 ├─ 检测缺失 → 征求同意 → npm i -g
 ├─ 委托 codegraph install --agent <x>（装二进制，不等于注册它的 MCP，见下）
 ├─ 委托 npx rea-agents setup（若用户选装 rea）
 └─ 写入自身 MCP 条目（默认 --print-config；--write 时先备份）
```

- **默认只注册 codemap 一个 MCP**。codegraph 自带 MCP server 与 8 个 `codegraph_*` 工具（已核对：search / callers / callees / impact / node / explore / status / files），双注册会和薄封装重复、摊薄 agent 上下文。想叠加原生工具用 `--with-upstream-mcp`。
- **自身条目写入**：默认 `--print-config <agent>` 输出应粘贴的片段（零文件写入）；`--write` 模式用**注释保留式**行级插入——**禁止 `JSON.parse` → `JSON.stringify` 整文件往返**（会静默删掉用户 JSONC 注释）。写前备份 `<config>.codemap-bak-<ts>`。此模式学自 codegraph 已有的 `install --print-config <id>`。
- **daemon 责任**：CodeMap 不拉起任何长驻进程。`check_index` 永不代跑 `init / index / sync`（小时级任务不进 MCP），只返回指引——因此不会产生「我们启动的 daemon」这一责任问题。刷新索引是用户在终端跑 `codegraph sync` 的事。

### 4.4 `codemap doctor` 输出示例

```
codegraph   ✓ 1.2.0      (C:\nvm\nodejs\codegraph.ps1)
            ✓ 本项目已索引  extraction v24 · 109,456 nodes · 2h ago · 无待同步变更
            ✓ 镜像新鲜      mirrored 5min ago (extraction v24)
rea         ✗ 未安装
            → 需要用于：原生插件 3 个 / wasm 1 个 / asar 0 个
            → 安装：npm i -g rea-agents
node        ✓ 22.x（node:sqlite 可用）
git         ✓ 2.47

未解析引用  595,593 条（calls 472k / imports 48k / refs 46k）
覆盖评级    partial（coverage 公式见 §6.1）—— 运行 `codemap unknowns .` 查看分布
```

上游版本变更时 doctor 显式输出「⚠ 上游 extraction v25 > 镜像 v24，镜像已标 stale，核心功能基于旧镜像可用」——**如实报告，绝不静默**。

---

## 5. 数据访问（v2 重写：镜像优先）

| 通道 | 用途 | 风险与护栏 |
| --- | --- | --- |
| **镜像 ETL（唯一写路径）** | 校验白名单 → 一次性导出 L0–L2 | 上游**只读打开**。WAL 并发安全（上游自设 `journal_mode=WAL` + `busy_timeout=5000`，注释明确「reads never block on a writer」，已核对）；daemon 死亡且 WAL 未 checkpoint 的极端态 → copy-aside（db+wal+shm 拷临时目录读副本） |
| **自家库只读** | 全部 13 个工具的日常读取 | 与上游完全解耦；stale 镜像可用；WAL + busy_timeout |
| **CLI `--json`** | doctor 元数据与白名单校验（`status --json` 字段已核对） | 稳定接口；**没有图遍历命令**（已核对），不承担切片/渲染降级 |

硬性护栏（v2）：

- **只读打开上游，且不经过 codegraph 自己的 `open()`**——它打开即跑 migration（写），已核对。CodeMap 用自己的只读连接。
- **绝不写上游库**。派生数据一律进 `.codemap/`。
- **staleness 的 source of truth = `codegraph status --json`**（`pendingChanges` + `reindexRecommended`），不自己用 git 猜——git 状态与索引状态会分叉。
- **不干预上游进程生命周期，不拉起长驻进程**。需要刷新就指引 `codegraph sync`。

---

## 6. 核心算法

### 6.1 功能切片（L3）— v2 定稿

```
切片子图（参与边）：calls、contains、instantiates、extends、implements
不参与：imports（只用于 L1 聚合折叠）、references（噪声，只进 evidence/unknowns）
depth 语义：contains 是「归属边」不计跳数，其余边计 1 跳；默认 depth=5
（足以覆盖 route→service→repo→model 的典型纵深）

入口点：
- L4 节点（HTTP 路由 / IPC channel / CLI 命令 / 导出 API）
- package.json bin/exports、main()
- 测试 describe 块：默认关闭，--include-tests 显式开启
  （避免测试套件刷屏功能列表；agent 要测试↔实现追溯时再开）

巨入口降级：单入口可达节点 > 全图 40%（如 main() 引导链吞掉一切）
→ 降级为种子，不建卡

归属与 shared：
1. 被 ≥K 个 feature 可达（K 默认 3）→ shared（公共设施）
   【v1 的「出度>N」废除：出度高的是编排层，恰恰最该留在 feature 里；
     工具函数的信号是跨 feature 的 fan-in】
2. L4 入口绑定节点（route handler / IPC handler）豁免 shared
3. 其余争议节点：按（最短跳数，路径数）字典序归属唯一 feature

合并（默认「业务域 feature」语义）：
- containment = |A∩B| / min(|A|,|B|) > 0.7 → 合并，合并后重算
- 合并结果 > maxFeatureNodes（默认 500）→ 不合并（防链式并成整库）
- --granularity endpoint：跳过合并，每端点一卡

命名：优先路由路径 / IPC 名 / 目录名；语义概括交给调用方 agent
（铁律 3 不变：MCP 内不硬编码 LLM 调用）

产出 feature 卡：
{ name, entrypoints[], layers: {route, service, repo, model},
  touches: {tables[], externalCalls[], configKeys[]},
  files[], coverage, limitations[] }
```

**coverage 公式（P0 即用，doctor 与 feature 卡共用）**：

```
coverage(范围) = resolved / (resolved + unresolved)
  resolved   = 范围内文件集的已解析边数
  unresolved = 范围内文件集的 unresolved_refs 数
              （schema 已核对：含 file_path，可直接聚合）

unavailable   无有效索引或依赖缺失
unknown       coverage < 15%（图稀薄到无法据此推理。阈值依据：实测工程 41.6% 解析率应评 partial——「看清了一部分、盲区很大」，而非全盲）
partial       15% ≤ coverage < 95%
complete      coverage ≥ 95%

feature 卡 limitations[] =
  卡内文件集 unresolved_refs 按 reference_kind 聚合 top-5 + 总数
```

### 6.2 运行时拓扑适配器（L4）— v2 口径修正

「不做解析」修订为：**不做全量 AST 解析与符号解析；允许 adapter 做轻量模式匹配（行级正则），产物一律 `confidence: inferred/partial`**，且必须与 codegraph 已有符号**按 file:line 缝合**，不重做符号解析。识别不了的进 `limitations[]`。

可插拔目录 `adapters/<name>/{detect.ts, extract.ts}`，`detect` 读 package.json / pom.xml / 配置文件决定是否启用：

```
express / koa / fastify   → app.get/post(path, handler)   → HTTP 路由节点
nestjs / spring           → @Controller / @RequestMapping  → 同上
electron                  → ipcMain.handle / contextBridge → IPC 通道节点
vue / react               → 组件树 + router 配置           → 页面节点
prisma / typeorm / mybatis→ schema / entity               → 数据表节点
openapi / proto           → 契约文件                       → 外部接口节点
docker-compose / k8s      → 服务编排                       → 部署拓扑节点
```

已核对：codegraph 1.2.0 提取器不产出 `route`（实测工程 route=0 一致）——HTTP/IPC/DB 适配器都是 CodeMap 的活；`component`（实测 565 个）优先复用。adapter 能力清单由 doctor 报告。

### 6.3 渲染 — v2 定稿默认值

不自己发明布局，三种格式：

| 格式 | 用途 | 说明 |
| --- | --- | --- |
| **Mermaid** | 默认。给 agent / Markdown / 网页 | 文本即图；`graph LR` + `subgraph` 分层 |
| **Graphviz DOT** | 大图、导出 SVG/PDF | `rankdir` / `cluster` 更稳 |
| **JSON** | 交互式 viewer | **codemap-graph v1** schema（cytoscape elements 兼容，带 `$schema` 版本字段） |

默认值与旋钮：

- `codemap map .` → `level=system, format=mermaid, maxNodes=60`
- `level`：`system`（目录/包折叠）/ `module` / `symbol`
- `scope` 枚举：`project | module:<id> | feature:<id> | boundary:<id>`
- `focus`：先按 id 精确匹配，再按 label 全局唯一匹配；多义返回候选列表
- `depth`：以 focus 为中心展开 N 跳
- `maxNodes`：超出则**自适应折叠**——从浅目录深度开始逐级折叠直到 ≤ maxNodes，折叠处标 `[+N more]`；system 级折叠按目录/包边界（Electron 工程自然得到 `main ↔ renderer ↔ services`）

**聚合与折叠是一等公民，第一版就要做**（不变）。10 万节点级别的图直接渲染必然失败。

---

## 7. 工具面（13 个 MCP 工具）

```
--- 环境 ---
codemap_doctor(path)
    依赖体检 + 索引新鲜度 + 镜像状态 + 边界缺口统计 + 覆盖评级
codemap_check_index(path)                                  【v2 更名收窄】
    只检查：已索引？新鲜度（pendingChanges）？版本白名单？镜像 stale？
    绝不代跑 init/index/sync，返回指引

--- 发现 ---
codemap_features(path, {filter?, includeTests?})           ★
    L3 功能卡片列表（只给 name / entrypoint / 规模，不给成员节点）
codemap_describe_feature(path, featureId, {depth?})        ★
    单功能脉络 + 触达的表/接口/配置 + 证据位置
codemap_edges(path)                                        ★
    外部边界清单：HTTP 出口 / DB / 文件 / env /
    原生插件 / wasm / 预编译包，并标注「rea 可否穿透」

--- 图 ---
codemap_map(path, {scope?, level?, focus?, depth?,
                   format?, maxNodes?})                    ★
codemap_trace(path, from, to)                              ★
    跨边界调用链（含 rea 补的那一跳）
codemap_impact(path, target)
    委托 codegraph impact + L4 放大
    （「改这个函数会影响 2 条 HTTP 路由 + 1 个 IPC 通道」）

--- 通用 ---
codemap_get(path, handle, {offset?})                       【v2 新增】
    取回摘要对应的完整投影，分页；handle 过期提示重新请求

--- 跨界 ---
codemap_pierce(path, boundaryId)                           ★
    对单个边界调 rea（同步，硬超时 120s，结果缓存 pierce_cache）
codemap_unknowns(path, {scope?})                           ★
    从 unresolved_refs 聚合，诚实列出「这块没看清」

--- 薄封装 ---
codemap_search(path, query) / codemap_outline(path, name)
```

★ 净增量（v2 修正标注）：`map / features / describe_feature / edges / trace（缝合跳）/ pierce / unknowns` 是净增量；`doctor / check_index / impact / search / outline` 是封装或增强。v1 只标三个，与 §2.2 矛盾。

响应预算（铁律）：每个工具默认返回摘要 + handle，`codemap_get` 分页取全量。handle 落 `.codemap.db`，TTL 1h，server 重启有效，过期返回「请重新请求」。所有 `path` 缺省 = server 启动 CWD。**MCP 内没有任何工具会触发安装或长时任务**（铁律 1 + 异步边界）。

---

## 8. CLI

```bash
codemap doctor                    # 依赖体检 + 镜像状态
codemap setup                     # 装缺失依赖 + 注册 MCP（--print-config 默认）
codemap setup --write             # 征得同意后写入配置（注释保留式）
codemap setup --offline           # 只报告，给手工指令
codemap clean                     # 清 .codemap/

codemap map .                     # 整个工程的地图（system 级，mermaid）
codemap map . --level module      # 聚合到模块级
codemap map . --focus AgentCenter --depth 2
codemap map . --format dot -o arch.dot

codemap features .                # 这个工程有哪些功能
codemap features . --granularity endpoint   # 每端点一卡
codemap feature 用户登录           # 单功能脉络：路由→服务→仓储→表

codemap edges .                   # 外部边界清单
codemap pierce <边界id>            # 调 rea 穿透
codemap unknowns .                # 覆盖度盲区

codemap trace <from> <to>
codemap impact <symbol>
```

---

## 9. 技术栈（v2 精简）

```
TypeScript + @modelcontextprotocol/sdk   stdio MCP
zod                                      契约与校验
node:sqlite                              只读上游 + 自家库
                                         （Node ≥ 22.5 内置；与上游同驱动，
                                          零原生编译，WAL/FTS5 全支持）
cross-spawn                              调用 codegraph / rea CLI
```

v1 移除项：

- **better-sqlite3**：原生模块 prebuild 是纯运维风险；上游自己已用 node:sqlite（已核对「Backend: node:sqlite — built-in, full WAL + FTS5」），同驱动最稳。
- **simple-git**：staleness 以 `status --json` 为准，git 状态与索引状态会分叉。
- **worker_threads**：暂无已证实的重计算（40 万边 BFS 在 JS 内亚秒级）；profile 说话，需要再加。

不需要 tree-sitter / SCIP / babel —— 解析全部委托上游（不变）。

---

## 10. 路线图（v2：工具 × 阶段矩阵）

| 阶段 | 工具/能力 | 验收 |
| --- | --- | --- |
| **P0** | doctor / check_index / 镜像 ETL / codemap_get / coverage 公式 | 未装 rea 的机器上 `doctor` 正确区分硬/软依赖，不误判、不静默安装；10 万节点工程 ETL < 60s；doctor 覆盖评级与 §6.1 公式一致 |
| **P1** | `codemap_map`（三级 level + 自适应折叠 + mermaid/dot/json） | 对 10 万节点级工程输出一张可读的 `main ↔ renderer ↔ services` 模块图，不崩 |
| **P2** | `codemap_unknowns` + `codemap_edges`：unresolved_refs 聚合 + 边界扫描 | 列出目标工程全部原生插件 / 外部出口，标注可否穿透 |
| **P3** | `codemap_pierce`（先只做 `inspect-artifact` + `analyze-javascript-application`）+ `codemap_trace` | Electron 原生插件的导出函数能接进图；跨缝调用链可查 |
| **P4** | L4 适配器：Electron IPC / HTTP 路由 / DB schema | Electron 工程的 IPC 通道拓扑可完整渲染 |
| **P5** | L3 功能切片 + `codemap_describe_feature` + `codemap_impact` 完整版 | 「这个工程有 N 个功能，每个的脉络是 X→Y→Z」；影响面含路由/IPC |

（v1 的 trace 无排期、impact 隐含依赖 P4 的问题在此矩阵中显式化。）

**P1 结束即有可交付价值**（codegraph 现在画不出图）。由于解析层整体复用，比自研解析的路径大幅缩短。

---

## 11. 风险

| # | 风险 | 缓解 |
| --- | --- | --- |
| 1 | **双上游版本耦合**。同时绑定 codegraph 内部 schema 与 rea CLI 输出格式 | 白名单校验走 `status --json` 稳定通道（字段已核对）；镜像失配时 stale 镜像可用，不是清零；对 rea 只用 `--json` 且只接少数几个命令 |
| 2 | **全局安装的供应链信任**。`npm i -g` 第三方包有风险，内网场景更敏感 | 必须支持私有 registry 与离线 tarball；`doctor` 显示包来源与完整性校验结果 |
| 3 | **图太大没人看** | 聚合与折叠作为 P1 的一等公民（默认值已定稿） |
| 4 | **动态性分析不到**。DI 容器、反射、字符串拼接 import、事件总线 | 显式输出 `limitations[]`；四态 coverage 公式已定稿（§6.1） |
| 5 | **上游 daemon 生命周期** | CodeMap 不拉起长驻进程、不代跑索引（问题从根上缩小）；刷新指引用户跑 `codegraph sync`；ETL 只读打开 |
| 6 | 【v2 新增】**跨平台**：shim/路径仅 Windows 实测 | 探测四步全平台等价实现（`command -v` / `npm prefix -g`）；macOS/Linux 首版标实验性 |
| 7 | 【v2 新增】**镜像盘占用**（< 300MB/工程） | `codemap clean`；只镜像已校验工程；gitignore 已覆盖 |

---

## 12. 从 REA 工程借鉴的实践

| REA 的做法 | 位置 | CodeMap 如何采用 |
| --- | --- | --- |
| 证据承载图模型：节点/边带 `evidence`、`coverage`、`limitations` | `src/domain/artifactGraph.ts` 等 | 全盘采用；coverage 四态公式已在 §6.1 定稿 |
| domain 层纯函数、零 I/O | `src/domain/` | L3/L4 切片与投影保持纯函数，便于测试与缓存 |
| 内容寻址 ID + RFC 8785 canonical JSON | `src/domain/canonicalDigest.ts` | 用于 pierce_cache 键与投影去重（上游 id 不稳定，已核对） |
| 投影视图层（30+ view）解决响应预算 | `src/domain/analysisView/` | **最关键的借鉴**。图不回灌上下文，一律先投影；handle 落 `projections` 表 |
| 契约优先的工具注册统一壳 | `src/contracts/` + `src/server/register*.ts` | 13 个工具统一走 contract → handler |
| 响应预算 / schema 档位 | `src/config/mcpResponseBudget.ts` | 同步采用 |
| 解析跑在隔离 worker、带堆上限 | `JavaScriptAnalysisWorker.ts` | 暂不引入（v2 移除 worker_threads）；profile 证明需要再加 |

---

## 13. 待定

1. **包名与 scope**（唯一阻塞项）：`@<scope>/codemap` 的 scope 名待定，或 `codemap-agents`。占用情况沿用 v1 实测（`codemap-mcp` / `mcp-codemap` / `codemap-cli` / `codemaps` 已被占用；`codemap-agents` / `codemap-tools` / `codemap-graph` / `codemapper-mcp` 可用）。
2. **是否支持无 codegraph 的纯 rea 模式**（分析无源码产物时）。倾向支持，但排在 P3 之后。
3. **多语言优先级**：按实测工程 TS 4369 / Python 665 / Vue 565 / JS 292 排序开发 L4 适配器。

（v1 的「70% 合并语义 / tests 入口 / coverage 定义」已在 v2 定稿，不再待定。）

---

## 14. 已核对事实（v2 新增）

来自本机安装的 codegraph 1.2.0 源码（`@colbymchenry/codegraph-win32-x64/lib/dist/`），替代 v1 中的推测：

| # | 事实 | 结论 | 来源 |
| --- | --- | --- | --- |
| 1 | `unresolved_refs` 含 `from_node_id / reference_name / reference_kind / line / col / candidates / file_path / language` | 按文件/功能聚合与 feature limitations 派生**成立** | `db/schema.sql` |
| 2 | 节点 id = `generateNodeId(file_path, kind, name, line)` | id 随挪行变化 → 镜像**不做 id 级增量**，全量重建 | `extraction/tree-sitter-helpers.js` |
| 3 | `status --json` 输出 `builtWithExtractionVersion / currentExtractionVersion / reindexRecommended / pendingChanges / journalMode` 等 | 白名单校验与 staleness 走**稳定 CLI 通道**，不必摸内部元数据表 | `bin/codegraph.js` |
| 4 | 上游自设 `journal_mode=WAL` + `busy_timeout=5000`，注释明确「reads never block on a writer」 | ETL 读取安全；daemon 死亡 + WAL 未 checkpoint 极端态用 copy-aside 兜底 | `db/index.js` |
| 5 | CLI 命令面无任何图遍历（`query` = 搜索；`callers/callees/impact` 是单点查询） | 直读/镜像**是刚需**，CLI 只当元数据核对 | `bin/codegraph.js` |
| 6 | 提取器不产出 `route` 节点 | HTTP/IPC/DB 适配器是 CodeMap 的活 | `extraction/*` |
| 7 | 上游自带 MCP server（8 个 `codegraph_*` 工具）与 `install --print-config` 模式 | codemap 默认独占注册；自身 setup 学其 print-config 模式 | `mcp/tools.js`、`bin/codegraph.js` |
| 8 | 上游 `DatabaseConnection.open()` 打开即跑 migration（写） | CodeMap 必须自研只读连接，不经上游 open | `db/index.js` |
