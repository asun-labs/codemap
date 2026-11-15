import * as fs from 'node:fs';
import * as path from 'node:path';

/** 包/子系统边界：monorepo 的一个工作区 */
export interface WorkspacePkg {
  /** 仓库相对 posix 路径（workspace 根目录） */
  dir: string;
  name: string;
  kind: 'package' | 'app' | 'service';
  /** 该包自己声明的工作区通配（嵌套 monorepo） */
  nested?: string[];
}

export interface RepoDetection {
  /** 根 package.json / 其它清单是否存在 */
  manifests: string[];
  /** 是否 monorepo */
  monorepo: boolean;
  /** 识别到的子系统边界（含根，若根本身也是一层） */
  packages: WorkspacePkg[];
  /** 根的名字（展示用） */
  rootName: string;
  /** 被识别为部署单元的类型 */
  deployHints: string[];
}

const WORKSPACE_GLOBS = ['packages/*', 'apps/*', 'services/*', 'libs/*', 'modules/*', 'plugins/*', 'crates/*'];

function readJson<T>(fp: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** 展开 `packages/*` 这类单层通配（只支持一层，覆盖绝大多数 monorepo） */
function expandGlob(root: string, pattern: string): string[] {
  const clean = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  const starAt = clean.indexOf('*');
  if (starAt < 0) {
    return fs.existsSync(path.join(root, clean)) ? [clean] : [];
  }
  const base = clean.slice(0, starAt).replace(/\/$/, '');
  const rest = clean.slice(starAt + 1).replace(/^\//, '');
  const baseAbs = path.join(root, base);
  if (!fs.existsSync(baseAbs)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const rel = base === '' ? e.name : `${base}/${e.name}`;
    if (rest === '') {
      out.push(rel);
    } else if (fs.existsSync(path.join(root, rel, rest))) {
      out.push(`${rel}/${rest}`);
    }
  }
  return out;
}

function detectPkgKind(dir: string, name: string, pkg: { bin?: unknown; scripts?: Record<string, string> } | null): WorkspacePkg['kind'] {
  const pathy = (dir + '/' + name).toLowerCase();
  if (/\/(apps?|services?)\//.test('/' + pathy + '/')) return 'service';
  if (pkg?.bin) return 'app';
  if (/\b(server|api|backend|service|worker|gateway)\b/.test(pathy)) return 'service';
  if (/\b(web|app|desktop|electron|client|frontend|ui)\b/.test(pathy)) return 'app';
  if (pkg?.scripts && /^(start|serve|dev)$/m.test(Object.keys(pkg.scripts).join('\n'))) return 'app';
  return 'package';
}

/** 顺着目录往下找子 monorepo（只看两层，避免全盘遍历） */
function nestedWorkspaceGlobs(root: string, dir: string): string[] {
  const pkg = readJson<{ workspaces?: unknown }>(path.join(root, dir, 'package.json'));
  const ws = normalizeWorkspaces(pkg?.workspaces);
  return ws;
}

function normalizeWorkspaces(ws: unknown): string[] {
  if (Array.isArray(ws)) return ws.filter((x): x is string => typeof x === 'string');
  if (ws && typeof ws === 'object') {
    const pkgs = (ws as { packages?: unknown }).packages;
    if (Array.isArray(pkgs)) return pkgs.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

function workspacePackageJson(root: string, pattern: string): boolean {
  const dirs = expandGlob(root, pattern);
  return dirs.length > 0;
}

/**
 * 仓库形态识别：monorepo（工作区）还是单包。
 * 只读清单文件，不遍历源码（大仓库也快）。
 */
export function detectRepo(root: string): RepoDetection {
  const manifests: string[] = [];
  const deployHints: string[] = [];
  const rootPkgPath = path.join(root, 'package.json');
  const rootPkg = fs.existsSync(rootPkgPath)
    ? readJson<{ name?: string; workspaces?: unknown; private?: boolean }>(rootPkgPath)
    : null;
  if (rootPkg) manifests.push('package.json');
  for (const f of ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json', 'rush.json']) {
    if (fs.existsSync(path.join(root, f))) {
      manifests.push(f);
      deployHints.push(f);
    }
  }
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'Dockerfile']) {
    if (fs.existsSync(path.join(root, f))) deployHints.push(f);
  }

  let rootName = rootPkg?.name ?? path.basename(root);

  const globs = new Set<string>();
  for (const g of normalizeWorkspaces(rootPkg?.workspaces)) globs.add(g);
  // pnpm-workspace.yaml
  const pnpmWs = path.join(root, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmWs)) {
    const text = fs.readFileSync(pnpmWs, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line);
      if (m && m[1] && !m[1].startsWith('!')) globs.add(m[1].trim());
    }
  }
  // lerna.json packages
  const lerna = fs.existsSync(path.join(root, 'lerna.json'))
    ? readJson<{ packages?: unknown }>(path.join(root, 'lerna.json'))
    : null;
  for (const g of normalizeWorkspaces(lerna?.packages)) globs.add(g);
  // 兜底：声明了 workspace 但读不出 glob 时，用常见目录
  if (globs.size === 0 && (manifests.includes('pnpm-workspace.yaml') || manifests.includes('turbo.json') || manifests.includes('nx.json'))) {
    for (const g of WORKSPACE_GLOBS) if (workspacePackageJson(root, g)) globs.add(g);
  }

  const packages: WorkspacePkg[] = [];
  if (globs.size > 0) {
    const seen = new Set<string>();
    for (const g of globs) {
      for (const dir of expandGlob(root, g)) {
        if (seen.has(dir)) continue;
        seen.add(dir);
        const pkgJson = readJson<{ name?: string; bin?: unknown; scripts?: Record<string, string> }>(
          path.join(root, dir, 'package.json'),
        );
        if (!pkgJson && !fs.existsSync(path.join(root, dir, 'pyproject.toml')) && !fs.existsSync(path.join(root, dir, 'go.mod'))) {
          continue;
        }
        packages.push({
          dir,
          name: pkgJson?.name ?? dir.split('/').pop() ?? dir,
          kind: detectPkgKind(dir, pkgJson?.name ?? dir, pkgJson),
          nested: nestedWorkspaceGlobs(root, dir),
        });
      }
    }
    // 多语言兜底：apps/* / services/* 下没有 package.json 的也收（go.mod / pyproject.toml）
    for (const g of ['apps/*', 'services/*']) {
      for (const dir of expandGlob(root, g)) {
        if (seen.has(dir)) continue;
        if (fs.existsSync(path.join(root, dir, 'go.mod')) || fs.existsSync(path.join(root, dir, 'pyproject.toml'))) {
          seen.add(dir);
          packages.push({ dir, name: dir.split('/').pop() ?? dir, kind: 'service' });
        }
      }
    }
  }

  // 单包工程但也分 app/lib 的常见形态（apps/web + packages/core 未声明 workspace 时）
  if (packages.length === 0) {
    for (const g of ['apps/*', 'packages/*', 'services/*']) {
      const dirs = expandGlob(root, g);
      if (dirs.length >= 2) {
        for (const dir of dirs) {
          const hasManifest =
            fs.existsSync(path.join(root, dir, 'package.json')) ||
            fs.existsSync(path.join(root, dir, 'go.mod')) ||
            fs.existsSync(path.join(root, dir, 'pyproject.toml'));
          if (hasManifest) {
            packages.push({ dir, name: dir.split('/').pop() ?? dir, kind: dir.startsWith('services') || dir.startsWith('apps') ? 'service' : 'package' });
          }
        }
        if (packages.length > 0) break;
      }
    }
  }

  if (rootPkg?.name) rootName = rootPkg.name;

  // 非 JS 生态：maven/gradle 多模块
  if (packages.length === 0 && fs.existsSync(path.join(root, 'pom.xml'))) {
    const pom = fs.readFileSync(path.join(root, 'pom.xml'), 'utf8');
    for (const m of pom.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/g)) {
      const dir = (m[1] as string).replace(/\\/g, '/');
      if (fs.existsSync(path.join(root, dir))) {
        packages.push({ dir, name: dir.split('/').pop() ?? dir, kind: detectPkgKind(dir, dir, null) });
      }
    }
  }
  if (packages.length === 0 && fs.existsSync(path.join(root, 'settings.gradle')) && fs.existsSync(path.join(root, 'settings.gradle'))) {
    /* 交给通用目录分层，不猜测 */
  }

  return {
    manifests,
    monorepo: packages.length > 0,
    packages,
    rootName,
    deployHints,
  };
}

/** 便于测试：暴露 glob 展开 */
export const __test = { expandGlob, normalizeWorkspaces };
