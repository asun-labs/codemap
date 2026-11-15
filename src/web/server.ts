import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codemapDir, graphFilePath, loadGraph } from '../analyze/analyze.js';

export interface WebOptions {
  root: string;
  /** 端口，0 = 随机 */
  port?: number;
  host?: string;
  /** 打开浏览器 */
  open?: boolean;
  log?: (line: string) => void;
}

export interface WebServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function webRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // 开发态：src/web/server.ts → src/web/public
  // 构建态：dist/web/server.js → dist/web/public（构建脚本会拷贝）
  return path.join(here, 'public');
}

/**
 * 本地静态服务 + 一个 /api/graph 端点。
 * 刻意只用 node:http：零依赖，也不需要另起前端构建。
 */
export async function startWeb(opts: WebOptions): Promise<WebServer> {
  const log = opts.log ?? (() => {});
  const root = opts.root;
  const pub = webRoot();
  if (!fs.existsSync(pub)) throw new Error(`Web 资源缺失: ${pub}`);

  const graphDir = codemapDir(root);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/api/graph') {
        // 每次请求读盘：analyze 重跑后前端靠 mtime 轮询热刷新，这里不能缓存
        const graph = loadGraph(root);
        if (!graph) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '还没有分析结果，请先运行 codemap analyze' }));
          return;
        }
        sendJson(res, graph);
        return;
      }
      if (url.pathname === '/api/meta') {
        const st = safeStat(graphFilePath(root));
        sendJson(res, {
          root,
          hasGraph: st != null,
          graphFile: `${path.basename(graphDir)}/graph.json`,
          mtime: st?.mtimeMs ?? null,
        });
        return;
      }
      if (url.pathname === '/api/source') {
        // 只读源码片段：路径限定在仓库内，防目录穿越
        const rel = url.searchParams.get('path') ?? '';
        const abs = path.resolve(root, rel);
        if (!abs.startsWith(path.resolve(root))) {
          res.writeHead(403).end('forbidden');
          return;
        }
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          res.writeHead(404).end('not found');
          return;
        }
        const st = fs.statSync(abs);
        if (st.size > 2 * 1024 * 1024) {
          res.writeHead(413).end('file too large');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(fs.readFileSync(abs));
        return;
      }
      serveStatic(pub, url.pathname, res);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String(e instanceof Error ? e.stack ?? e.message : e));
    }
  });

  const port = opts.port ?? 4173;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, opts.host ?? '127.0.0.1', () => resolve());
  });
  const actual = (server.address() as { port: number }).port;
  const urlStr = `http://${opts.host ?? '127.0.0.1'}:${actual}/`;
  log(`CodeMap 已启动: ${urlStr}`);
  if (opts.open !== false) await openBrowser(urlStr);

  return {
    url: urlStr,
    port: actual,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function sendJson(res: http.ServerResponse, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function serveStatic(dir: string, pathname: string, res: http.ServerResponse): void {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const abs = path.resolve(dir, rel);
  if (!abs.startsWith(path.resolve(dir))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 ${pathname}`);
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  res.end(fs.readFileSync(abs));
}

/** 跨平台打开默认浏览器；失败不致命（用户自己点链接） */
export async function openBrowser(url: string): Promise<boolean> {
  const { spawn } = await import('node:child_process');
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
