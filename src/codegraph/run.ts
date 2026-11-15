import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * codegraph 没装时给出可直接复制的指令，绝不静默 `npm i -g`。
 * （铁律：任何全局安装都必须明示包名与版本，由用户决定。）
 */
export const CODEGRAPH_PACKAGE = '@colbymchenry/codegraph';

export function codegraphDbPath(root: string): string {
  return path.join(root, '.codegraph', 'codegraph.db');
}

export function hasIndex(root: string): boolean {
  return fs.existsSync(codegraphDbPath(root));
}

export interface RunOptions {
  timeoutMs?: number;
  /** 实时日志（进度条之类），默认丢弃 */
  onOutput?: (chunk: string) => void;
  cwd?: string;
}

/** 引号拼接：Windows shim（.cmd）与 POSIX sh 都按空格切词，路径带空格必须自己加引号 */
function quoteArg(a: string): string {
  return /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/**
 * 执行 codegraph 命令。
 *
 * 关键细节：走 shell 才能找到 Windows 的 codegraph.cmd shim。Node 在 ShellOptions 里传 args
 * 会报警（DEP0190，参数不转义），所以这里自己拼一条带引号的命令串，args 固定为 []。
 */
export function runCodegraph(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const line = ['codegraph', ...args].map(quoteArg).join(' ');
    const child = spawn(line, {
      cwd: opts.cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI ?? '1' },
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill();
        resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n[codemap] 超时（>${opts.timeoutMs ?? 0}ms）` });
      }
    }, opts.timeoutMs ?? 30 * 60_000);
    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      opts.onOutput?.(s);
    });
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      opts.onOutput?.(s);
    });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

export interface CodegraphStatus {
  installed: boolean;
  version: string | null;
  initialized: boolean;
  error?: string;
}

export async function codegraphStatus(root: string): Promise<CodegraphStatus> {
  const r = await runCodegraph(['status', '--json', root], { timeoutMs: 60_000 });
  if (!r.ok) {
    const probe = await runCodegraph(['--version'], { timeoutMs: 20_000 });
    if (!probe.ok) {
      return {
        installed: false,
        version: null,
        initialized: false,
        error: `codegraph 不可用：${lastLines(r.stderr) || 'command not found'}`,
      };
    }
    return { installed: true, version: probe.stdout.trim(), initialized: false, error: lastLines(r.stderr) };
  }
  try {
    const start = r.stdout.indexOf('{');
    const json = JSON.parse(r.stdout.slice(start)) as Record<string, unknown>;
    return {
      installed: true,
      version: typeof json.version === 'string' ? json.version : null,
      initialized: json.initialized === true,
    };
  } catch {
    return { installed: true, version: null, initialized: false, error: 'status --json 输出无法解析' };
  }
}

/** 建索引：未初始化用 init，已初始化用 index 重建（用户显式要求刷新时） */
export async function ensureIndex(
  root: string,
  opts: { force?: boolean; onOutput?: (s: string) => void; timeoutMs?: number } = {},
): Promise<{ ok: boolean; built: boolean; message: string }> {
  const status = await codegraphStatus(root);
  if (!status.installed) {
    return {
      ok: false,
      built: false,
      message:
        `未找到 codegraph。它是本工具的硬依赖（符号图来源）。\n` +
        `安装：npm i -g ${CODEGRAPH_PACKAGE}\n` +
        `（codemap 不会替你做全局安装）`,
    };
  }
  const cmd = !status.initialized || opts.force ? 'init' : null;
  if (cmd === null && hasIndex(root)) {
    return { ok: true, built: false, message: `已存在索引（codegraph ${status.version ?? '?'}）` };
  }
  const args = cmd === 'init' ? ['init', root] : ['index', root];
  const r = await runCodegraph(args, { onOutput: opts.onOutput, timeoutMs: opts.timeoutMs ?? 60 * 60_000 });
  if (!r.ok) {
    return { ok: false, built: false, message: `codegraph ${args[0]} 失败：${lastLines(r.stderr) || lastLines(r.stdout)}` };
  }
  return { ok: true, built: true, message: `codegraph ${args[0]} 完成` };
}

function lastLines(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return lines.slice(-2).join(' | ');
}
