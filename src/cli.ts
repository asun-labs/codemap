#!/usr/bin/env node
import * as fs from 'node:fs';
import { VERSION } from './version.js';
import { runDoctor, renderDoctorText } from './core/doctor.js';
import { checkIndex, renderCheckText } from './core/check-index.js';
import { buildMirror, MirrorError } from './db/mirror.js';
import { codemapDir, removeOwnDbFiles, resolveProject } from './util/paths.js';

const HELP = `codemap — 代码地图 v${VERSION}（P0）

  codemap doctor [path] [--json]   依赖体检 + 覆盖评级
  codemap check [path] [--json]    索引与镜像状态（只检查不代跑）
  codemap mirror [path]            构建/重建镜像 .codemap/codemap.db
  codemap clean [path]             清除镜像
  codemap mcp                      启动 MCP server（stdio）
  codemap help | --version

P1+ 将提供: map / features / edges / unknowns / pierce / trace / impact
环境变量 CODEMAP_CODEGRAPH_PATH 可显式指定 codegraph 可执行文件。
铁律：不静默安装 · 不代跑小时级索引 · 不写上游库。`;

interface Args {
  positional: string[];
  json: boolean;
}

function parseArgs(rest: string[]): Args {
  return {
    positional: rest.filter((a) => !a.startsWith('--')),
    json: rest.includes('--json'),
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (cmd) {
    case 'doctor': {
      const report = await runDoctor(args.positional[0]);
      if (args.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(renderDoctorText(report));
      }
      return report.ok ? 0 : 1;
    }
    case 'check': {
      const report = await checkIndex(args.positional[0]);
      if (args.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(renderCheckText(report));
      }
      return 0;
    }
    case 'mirror': {
      const projectPath = resolveProject(args.positional[0]);
      console.error(`[codemap] 镜像构建中: ${projectPath}`);
      try {
        const r = await buildMirror(projectPath);
        console.log(
          `镜像完成  ${r.counts.nodes.toLocaleString('en-US')} nodes · ` +
            `${r.counts.edges.toLocaleString('en-US')} edges · ` +
            `${r.counts.unresolvedRefs.toLocaleString('en-US')} unresolved · ` +
            `${r.counts.files.toLocaleString('en-US')} files · ` +
            `extraction v${r.extractionVersion} · ${(r.durationMs / 1000).toFixed(1)}s` +
            `${r.copiedAside ? '（copy-aside 读取）' : ''}`,
        );
        console.log(`工件: ${codemapDir(projectPath)}`);
        return 0;
      } catch (e) {
        if (e instanceof MirrorError) {
          console.error(`镜像失败 [${e.code}]: ${e.message}`);
          return 2;
        }
        throw e;
      }
    }
    case 'clean': {
      const projectPath = resolveProject(args.positional[0]);
      const dir = codemapDir(projectPath);
      if (fs.existsSync(dir)) {
        removeOwnDbFiles(projectPath);
        try {
          fs.rmdirSync(dir);
        } catch {
          /* 目录非空则保留 */
        }
        console.log(`已清除 ${dir}`);
      } else {
        console.log('无镜像可清');
      }
      return 0;
    }
    case 'mcp': {
      const { startMcpServer } = await import('./mcp/server.js');
      await startMcpServer();
      return 0; // connect 之后由 stdio 保持进程存活
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    case '--version':
    case '-V':
    case 'version':
      console.log(`codemap ${VERSION}`);
      return 0;
    default:
      console.error(`未知命令: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    console.error('codemap 出错:', e instanceof Error ? (e.stack ?? e.message) : e);
    process.exitCode = 1;
  });
