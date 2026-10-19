#!/usr/bin/env node
import * as fs from 'node:fs';
import { VERSION } from './version.js';
import { runDoctor, renderDoctorText } from './core/doctor.js';
import { checkIndex, renderCheckText } from './core/check-index.js';
import { buildMirror, MirrorError } from './db/mirror.js';
import { buildMap, type MapFormat } from './core/map.js';
import type { MapLevel } from './core/map-fold.js';
import { codemapDir, removeOwnDbFiles, resolveProject } from './util/paths.js';

const HELP = `codemap — 代码地图 v${VERSION}（P1）

  codemap doctor [path] [--json]   依赖体检 + 覆盖评级
  codemap check [path] [--json]    索引与镜像状态（只检查不代跑）
  codemap mirror [path]            构建/重建镜像 .codemap/codemap.db
  codemap map [path]               出图（--level system|module|symbol --focus X --depth N
                                   --format mermaid|dot|json --max-nodes N
                                   --scope project|module:<路径> -o <file>）
  codemap clean [path]             清除镜像
  codemap mcp                      启动 MCP server（stdio）
  codemap help | --version

P2+ 将提供: unknowns / edges / pierce / trace / features / impact
环境变量 CODEMAP_CODEGRAPH_PATH 可显式指定 codegraph 可执行文件。
铁律：不静默安装 · 不代跑小时级索引 · 不写上游库。`;

interface Args {
  positional: string[];
  flags: string[];
  json: boolean;
}

/** flag 后若紧跟非 flag 词元，视为该 flag 的值 */
function parseArgs(rest: string[]): Args {
  const positional: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i] as string;
    if (tok.startsWith('--')) {
      flags.push(tok);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.push(next);
        i++;
      }
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags, json: flags.includes('--json') };
}

function flagValue(flags: string[], name: string): string | undefined {
  const i = flags.indexOf(name);
  if (i < 0 || i + 1 >= flags.length) return undefined;
  const v = flags[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : undefined;
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
    case 'map': {
      const projectPath = resolveProject(args.positional[0]);
      try {
        const r = buildMap(projectPath, {
          level: flagValue(args.flags, '--level') as MapLevel | undefined,
          maxNodes: Number(flagValue(args.flags, '--max-nodes') ?? '') || undefined,
          focus: flagValue(args.flags, '--focus'),
          depth: Number(flagValue(args.flags, '--depth') ?? '') || undefined,
          format: flagValue(args.flags, '--format') as MapFormat | undefined,
          scope: flagValue(args.flags, '--scope'),
        });
        const outFile = flagValue(args.flags, '-o');
        if (outFile) {
          fs.writeFileSync(outFile, r.delivery.inline ? r.delivery.payload : r.delivery.payload);
          console.error(`已写出 ${outFile}（${r.summary}）`);
          if (!r.delivery.inline) console.error(`注意：全文 ${r.delivery.total} 字符超预算，此文件为预览片段`);
        } else {
          console.log(r.delivery.inline ? r.delivery.payload : r.delivery.payload);
          if (!r.delivery.inline) {
            console.error(`[codemap] 全文 ${r.delivery.total} 字符，已存投影 handle=${r.delivery.handle}，用 codemap get 取回`);
          }
          console.error(`[codemap] ${r.summary}`);
        }
      } catch (e) {
        console.error(`map 失败: ${e instanceof Error ? e.message : e}`);
        return 2;
      }
      return 0;
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
