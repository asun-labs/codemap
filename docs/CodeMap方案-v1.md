# CodeMap 代码地图 — 方案 v1

> 看清一个工程的结构 —— 每个功能的脉络，画成图。

| 项 | 值 |
| --- | --- |
| 英文名 | CodeMap |
| 中文名 | 代码地图 |
| 形态 | MCP server + CLI 二合一（stdio） |
| npm 包 | `@<scope>/codemap`（bin `codemap`）；非 scoped 备选 `codemap-agents` |
| MCP id | `codemap` |
| 派生数据 | `.codemap/codemap.db`（独立库，绝不写上游） |
| 硬依赖 | codegraph `>=1.2.0 <2` |
| 软依赖 | rea（rea-agents）`>=6.7 <7`，按需 |
| 日期 | 2026-10-19 |

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

### 2.3 `unresolved_refs` 是金矿

59.5 万条未解析引用，分布：

```
calls 472,388 | imports 47,747 | references 46,200
instantiates 19,143 | function_ref 9,379
extends 508 | decorates 214 | implements 14
```

这张表本质上是 codegraph 自己记录的「我没解析出来的东西」。**直接按文件/模块/功能聚合，就是现成的 coverage 与 limitations 数据源**，不需要自己估算。目前没有任何工具把它暴露给使用者。

### 2.4 rea 的定位：越界工具

REA (Reverse Engineer Anything) v6.7.0，MIT。它面向**没有源码的成品**：native 二进制（Hopper/Ghidra/IDA/rizin/objdump）、Electron/ASAR、.NET、APK、固件、wasm、EVM、运行时（Frida/CDP/GDB/pcap），100+ CLI 命令，全部支持 `--json`。

它不是「另一个代码分析器」，而是 **codegraph 撞墙时的越界工具**。

---

## 3. 架构

```
                     ┌──────────────────────────────┐
   agent ───MCP────► │          CodeMap             │
                     │                              │
                     │  L3 功能切片 / L4 运行时拓扑   │
                     │  聚合折叠 / 渲染 / 边界缝合    │
                     │  coverage 与 limitations      │
                     └──┬─────────────────────┬─────┘
                        │ 只读 SQLite          │ 子进程 --json
                        │ + CLI --json 降级    │
                   ┌────▼──────┐        ┌──────▼─────┐
                   │ codegraph │        │    rea     │
                   │  有源码侧  │        │  无源码侧   │
                   │  L0/L1/L2 │        │  二进制/产物 │
                   └───────────┘        └────────────┘
```

CodeMap 自身**不做解析**，是编排 + 投影 + 渲染层。

### 3.1 五层模型

| 层 | 内容 | 来源 |
| --- | --- | --- |
| **L0 物理** | 目录、文件、语言、体积、内容哈希 | codegraph `files` 表 |
| **L1 模块** | 文件/包，imports / exports | codegraph `nodes(kind=file,module)` + `edges(imports)` |
| **L2 符号** | 函数/类/方法，calls / implements / references / instantiates | codegraph `nodes` + `edges` |
| **L3 功能** | feature = 入口点 + 可达子图（**用户要的「脉络」**） | CodeMap 新增：切片算法 |
| **L4 运行时** | HTTP 路由 / IPC 通道 / DB 表 / 外部服务 / 进程边界 | CodeMap 新增：框架适配器 |

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

---

## 4. 依赖自举

### 4.1 探测顺序（Windows 有坑，已实测）

```
1. CodeMap 配置里的显式路径（最高优先）
2. PATH 查找 codegraph / rea
3. ⚠️ Windows 兜底：bash 下 `which codegraph` 查不到，
   但 C:\nvm\nodejs\codegraph.cmd 实际存在。
   必须额外扫 `npm root -g` 下的 bin shim（.cmd / .ps1 / 无后缀）
4. 最后兜底：npx -y <pkg> --version（慢，仅 doctor 用）
```

第 3 条是实测踩到的真坑：只靠 `which` 会误判为未安装，进而重复全局安装。

### 4.2 分级安装策略

| 依赖 | 必需性 | 缺失时行为 |
| --- | --- | --- |
| **codegraph** | **硬依赖** | 没有它 CodeMap 无法工作。`setup` 明示后，**经用户确认**执行 `npm i -g @colbymchenry/codegraph` |
| **rea** | **软依赖（按需）** | 不阻塞。仅当扫描到二进制边界时提示「发现 N 个原生插件无法穿透，装 rea 可补全」，**用户同意才装** |
| rea 的 native provider（Hopper / Ghidra / IDA） | 可选 | **绝不自动装**（GB 级）。只做能力声明与缺失说明 |

三条铁律：

- **绝不静默 `npm i -g`**。必须明示包名、版本、registry 来源、磁盘占用，等待用户确认。
- **提供 `--offline` / `--no-install`**。内网与离线环境只报告，并给出手工安装指令。
- **版本兼容矩阵硬校验**。校验 codegraph 的 `project_metadata.indexed_with_extraction_version`（当前实测为 24）与 `schema_versions`；不在白名单内则拒绝直读 DB，降级到 CLI 通道并提示 `codegraph index` 重建。

### 4.3 MCP 注册：复用上游，不自己改配置

codegraph 自带 `codegraph install`（支持 Claude Code / Cursor / Codex CLI / opencode / Hermes），rea 自带 `npx rea-agents setup`。**直接委托**，不要自己写 agent 配置文件改写逻辑——那是最容易写坏用户配置的地方。

```
codemap setup
 ├─ 检测缺失 → 征求同意 → npm i -g
 ├─ 委托 codegraph install --agent <x>
 ├─ 委托 npx rea-agents setup（若用户选装 rea）
 └─ 写入自身 MCP 条目（先备份原配置）
```

### 4.4 `codemap doctor` 输出示例

```
codegraph   ✓ 1.2.0      (C:\nvm\nodejs\codegraph.cmd)
            ✓ 本项目已索引  extraction v24 · 109,456 nodes · 2h ago
rea         ✗ 未安装
            → 需要用于：原生插件 3 个 / wasm 1 个 / asar 0 个
            → 安装：npm i -g rea-agents
node        ✓ 22.x
git         ✓ 2.47

未解析引用  595,593 条（calls 472k / imports 48k / refs 46k）
覆盖评级    partial —— 运行 `codemap unknowns .` 查看分布
```

---

## 5. 数据访问

| 通道 | 用途 | 风险与护栏 |
| --- | --- | --- |
| **直读 SQLite（主）** | 批量图遍历、功能切片、渲染。42 万条边必须直读，走 CLI 慢几个量级 | 上游表结构是**内部实现，非公开契约**。启动校验 schema 版本白名单，不匹配立即降级，**绝不猜** |
| **CLI `--json`（备）** | `status` / `impact` / `files` / `query`，以及 schema 校验失败后的降级路径 | 慢，但接口稳定 |

硬性护栏：

- **只读打开**（`mode=ro`），绝不写 codegraph 的库。派生数据一律进 `.codemap/codemap.db`。
- **正确处理 WAL**。codegraph 有常驻 daemon（`.codegraph/daemon.pid`、`codegraph.db-wal`），读取需避开 sync 中间态。
- **不干预上游进程生命周期**。需要刷新就调 `codegraph sync`，**绝不 kill 它的 daemon**。

---

## 6. 核心算法

### 6.1 功能切片（L3）

```
1. 发现入口点：
   - L4 节点（每条 HTTP 路由、每个 IPC channel、每个 CLI 命令、每个导出 API）
   - package.json bin/exports、main()、测试文件的 describe 块
2. 带剪枝的可达 BFS：
   - 跳过 node_modules（除非显式要求）
   - 出度 > N 的热点工具函数单独归入 shared，不并入任一 feature
   - 默认 depth = 5，可调
3. 去重与命名：
   - 两个入口共享 > 70% 节点 → 合并为同一 feature
   - 命名优先用路由路径 / IPC 名 / 目录名；语义概括交给调用方 agent
4. 产出 feature 卡片：
   { name, entrypoints[], layers: {route, service, repo, model},
     touches: {tables[], externalCalls[], configKeys[]},
     files[], coverage, limitations[] }
```

**命名不在 MCP 内硬编码 LLM 调用**。CodeMap 只返回切片与证据，保持纯确定性；命名与概括由调用方 agent 完成。这与 rea 的设计一致（只给事实与证据，解释交给 agent）。

### 6.2 运行时拓扑适配器（L4）

可插拔目录 `adapters/<name>/{detect.ts, extract.ts}`，`detect` 读 package.json / pom.xml / 配置文件决定是否启用。

```
express / koa / fastify   → app.get/post(path, handler)   → HTTP 路由节点
nestjs / spring           → @Controller / @RequestMapping  → 同上
electron                  → ipcMain.handle / contextBridge → IPC 通道节点
vue / react               → 组件树 + router 配置           → 页面节点
prisma / typeorm / mybatis→ schema / entity               → 数据表节点
openapi / proto           → 契约文件                       → 外部接口节点
docker-compose / k8s      → 服务编排                       → 部署拓扑节点
```

注：codegraph 已有 `route` 与 `component` 两种 node kind（上述实测工程中 component 565 个、route 0 个），**优先复用，只补它没覆盖的**。

### 6.3 渲染

不自己发明布局，输出三种格式：

| 格式 | 用途 | 说明 |
| --- | --- | --- |
| **Mermaid** | 默认。给 agent / Markdown / 网页 | 文本即图，可直接贴进文档；`graph LR` + `subgraph` 分层 |
| **Graphviz DOT** | 大图、导出 SVG/PDF | 节点多时 mermaid 排版会崩，dot 的 `rankdir` / `cluster` 更稳 |
| **JSON** | 交互式 viewer | cytoscape / d3 schema，保留全部属性 |

可读性靠三个旋钮，不靠渲染器：

- `level`：`system` / `module` / `symbol`（聚合粒度）
- `focus` + `depth`：以某节点为中心展开 N 跳
- `maxNodes`：超出则按目录/包自动折叠，并在图上标 `[+12 more]`

**聚合与折叠是一等公民，第一版就要做**。10 万节点级别的图直接渲染必然失败。

---

## 7. 工具面（11 个 MCP 工具）

```
--- 环境 ---
codemap_doctor()
    依赖体检 + 索引新鲜度 + 边界缺口统计
codemap_ensure_index(path, {sync?})
    委托 codegraph init/sync，返回统计

--- 发现 ---
codemap_features(path, {filter?})
    L3 功能卡片列表（只给 name / entrypoint / 规模，不给成员节点）
codemap_describe_feature(path, featureId, {depth?})
    单功能脉络 + 触达的表/接口/配置 + 证据位置
codemap_edges(path)                                       ★
    外部边界清单：HTTP 出口 / DB / 文件 / env /
    原生插件 / wasm / 预编译包，并标注「rea 可否穿透」

--- 图 ---
codemap_map(path, {scope, id?, level, focus?, depth?,
                   format: mermaid|dot|json, maxNodes?})
codemap_trace(path, from, to)
    跨边界调用链（含 rea 补的那一跳）
codemap_impact(path, target)
    委托 codegraph impact + L4 放大
    （「改这个函数会影响 2 条 HTTP 路由 + 1 个 IPC 通道」）

--- 跨界 ---
codemap_pierce(path, boundaryId)                          ★
    对单个边界调 rea，结果并入图
codemap_unknowns(path, {scope?})                          ★
    从 unresolved_refs 聚合，诚实列出「这块没看清」

--- 薄封装 ---
codemap_search / codemap_outline
    封装 codegraph query / node
```

★ 三个是 codegraph 与 rea 都没有的净增量。`codemap_unknowns` 尤其关键——59 万条未解析引用若不暴露，agent 会误以为图是完整的。

**铁律：每个工具响应都有 token 预算**，默认返回摘要 + handle，调用方需要细节再取。这是 REA `src/domain/analysisView/`（30+ 个投影 view）的经验，不要重蹈覆辙。

---

## 8. CLI

```bash
codemap doctor                    # 依赖体检
codemap setup                     # 装缺失依赖 + 注册 MCP
codemap setup --offline           # 只报告，给手工指令

codemap map .                     # 整个工程的地图（mermaid）
codemap map . --level system      # 聚合到系统级
codemap map . --focus AgentCenter --depth 2
codemap map . --format dot -o arch.dot

codemap features .                # 这个工程有哪些功能
codemap feature 用户登录           # 单功能脉络：路由→服务→仓储→表

codemap edges .                   # 外部边界清单
codemap pierce <边界id>            # 调 rea 穿透
codemap unknowns .                # 覆盖度盲区

codemap trace <from> <to>
codemap impact <symbol>
```

---

## 9. 技术栈

```
TypeScript + @modelcontextprotocol/sdk   stdio MCP
zod                                      契约与校验
better-sqlite3                           只读上游库 + 自身派生库
cross-spawn                              调用 codegraph / rea CLI
simple-git                               变更检测与归属
worker_threads                           重计算隔离 + 堆上限
```

**不需要** tree-sitter / SCIP / babel —— 解析全部委托上游。

---

## 10. 路线图

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P0** | 依赖自举（doctor / setup，含 Windows shim 探测）+ SQLite 只读通道 + schema 版本护栏 | 在未装 rea 的机器上 `doctor` 正确区分硬/软依赖，不误判、不静默安装 |
| **P1** | `codemap_map`：读 codegraph 图 → 分层聚合折叠 → mermaid / dot | 对 10 万节点级工程输出一张可读的 `main ↔ renderer ↔ services` 模块图，不崩 |
| **P2** | `codemap_unknowns` + `codemap_edges`：unresolved_refs 聚合 + 边界扫描 | 列出目标工程全部原生插件 / 外部出口，标注可否穿透 |
| **P3** | `codemap_pierce`：接 rea（先只做 `inspect-artifact` + `analyze-javascript-application` 两条） | Electron 原生插件的导出函数能接进图 |
| **P4** | L4 适配器：Electron IPC / HTTP 路由 / DB schema | Electron 工程的 IPC 通道拓扑可完整渲染 |
| **P5** | L3 功能切片 + `codemap_describe_feature` | 「这个工程有 N 个功能，每个的脉络是 X→Y→Z」 |

**P1 结束即有可交付价值**（codegraph 现在画不出图）。由于解析层整体复用，比自研解析的路径大幅缩短。

---

## 11. 风险

| # | 风险 | 缓解 |
| --- | --- | --- |
| 1 | **双上游版本耦合**。同时绑定 codegraph 内部 schema 与 rea CLI 输出格式 | schema 版本白名单 + CLI 降级通道；对 rea 只用 `--json` 且只接少数几个命令，不把 100+ 命令全接进来 |
| 2 | **全局安装的供应链信任**。`npm i -g` 第三方包有风险，内网场景更敏感 | 必须支持私有 registry 与离线 tarball；`doctor` 显示包来源与完整性校验结果。（REA 自己的 README 专门警告过「相似仓库名不代表官方」，说明此类事件真实发生过） |
| 3 | **图太大没人看**。10 万行工程的符号图是几十万条边 | 聚合与折叠作为 P1 的一等公民，不作为后期优化 |
| 4 | **动态性分析不到**。DI 容器、反射、字符串拼接 import、事件总线 | 显式输出 `limitations[]`；采用 REA 的 `coverage: complete / partial / unknown / unavailable` 四态 |
| 5 | **上游 daemon 生命周期** | 只读 DB，刷新走 `codegraph sync`，绝不 kill 对方 daemon |

---

## 12. 从 REA 工程借鉴的实践

| REA 的做法 | 位置 | CodeMap 如何采用 |
| --- | --- | --- |
| 证据承载图模型：节点/边带 `evidence`、`coverage`、`limitations` | `src/domain/artifactGraph.ts`、`referenceSourceGraph.ts`、`docs/javascript-application-graph.md` | 全盘采用，含四态 coverage |
| domain 层纯函数、零 I/O | `src/domain/` | L3/L4 切片与投影保持纯函数，便于测试与缓存 |
| 内容寻址 ID + RFC 8785 canonical JSON | `src/domain/canonicalDigest.ts` | 用于增量：内容未变则不重算 |
| 投影视图层（30+ view）解决响应预算 | `src/domain/analysisView/` | **最关键的借鉴**。图不回灌上下文，一律先投影 |
| 契约优先的工具注册统一壳 | `src/contracts/` + `src/server/register*.ts` | 11 个工具统一走 contract → handler |
| 响应预算 / schema 档位 | `src/config/mcpResponseBudget.ts` | 同步采用 |
| 解析跑在隔离 worker、带堆上限 | `src/javascript/analysis/JavaScriptAnalysisWorker.ts` | 重计算走 worker_threads |

---

## 13. 待定

1. **包名最终定夺**：`@<scope>/codemap`（推荐，与 `@colbymchenry/codegraph` 同构）还是 `codemap-agents`（与 `rea-agents` 同构）。
   实测占用：`codemap-mcp` / `mcp-codemap` / `codemap-cli` / `codemaps` **已被占用**；`codemap-agents` / `codemap-tools` / `codemap-graph` / `codemapper-mcp` 可用。
2. **是否支持无 codegraph 的纯 rea 模式**（分析无源码产物时）。倾向支持，但排在 P3 之后。
3. **多语言优先级**：上述实测工程为 TS 4369 / Python 665 / Vue 565 / JS 292。L4 适配器按此排序开发。
