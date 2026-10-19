import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { VERSION } from '../version.js';
import { runDoctor } from '../core/doctor.js';
import { checkIndex } from '../core/check-index.js';
import { resolveProject, ownDbExists } from '../util/paths.js';
import { openOwnDb } from '../db/own.js';
import { getProjection, pagePayload } from '../db/projections.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** stdio 卫生：协议只走 stdout，一切诊断进 stderr */
function diag(msg: string): void {
  console.error(`[codemap] ${msg}`);
}

function textResult(v: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
  };
}

async function wrap(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return textResult(await fn());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diag(`工具执行失败: ${msg}`);
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer(
    { name: 'codemap', version: VERSION },
    {
      instructions:
        'CodeMap 代码地图（P0）：codemap_doctor 依赖体检、codemap_check_index 索引/镜像状态、' +
        'codemap_get 按 handle 取回完整投影。图与功能切片工具（map/features/edges/unknowns…）随 P1+ 提供。' +
        'CodeMap 绝不静默安装、绝不代跑小时级索引、绝不写上游库。',
    },
  );

  server.registerTool(
    'codemap_doctor',
    {
      title: 'CodeMap Doctor',
      description:
        '依赖体检：codegraph（硬依赖）/ rea（软依赖）探测、索引新鲜度、镜像状态、覆盖评级（四态 coverage）',
      inputSchema: { path: z.string().optional().describe('工程路径，缺省为当前工作目录') },
    },
    ({ path }) => wrap(async () => runDoctor(path)),
  );

  server.registerTool(
    'codemap_check_index',
    {
      title: 'CodeMap Check Index',
      description:
        '只检查不代跑：是否已索引、pendingChanges 新鲜度、extraction 版本白名单、镜像 stale 状态，并返回指引',
      inputSchema: { path: z.string().optional().describe('工程路径，缺省为当前工作目录') },
    },
    ({ path }) => wrap(async () => checkIndex(path)),
  );

  server.registerTool(
    'codemap_get',
    {
      title: 'CodeMap Get',
      description: '按 handle 取回此前工具返回摘要对应的完整投影（分页）；handle TTL 1 小时',
      inputSchema: {
        path: z.string().optional().describe('工程路径，缺省为当前工作目录'),
        handle: z.string().describe('此前响应中返回的 handle'),
        offset: z.number().int().min(0).optional().describe('分页偏移（上一次响应的 nextOffset）'),
      },
    },
    ({ path, handle, offset }) =>
      wrap(async () => {
        const projectPath = resolveProject(path);
        if (!ownDbExists(projectPath)) {
          throw new Error('镜像不存在，无法解析 handle —— 先运行 codemap mirror <path>');
        }
        const db = openOwnDb(projectPath);
        try {
          const hit = getProjection(db, handle);
          if (hit === 'missing') throw new Error(`handle 不存在: ${handle}`);
          if (hit === 'expired') throw new Error(`handle 已过期: ${handle} —— 请重新请求原工具`);
          return { handle, ...pagePayload(hit.payload, offset) };
        } finally {
          try {
            db.close();
          } catch {
            /* 已关闭则忽略 */
          }
        }
      }),
  );

  await server.connect(new StdioServerTransport());
  diag(`codemap mcp v${VERSION} ready (stdio)`);
}
