import crossSpawn from 'cross-spawn';

export interface SpawnResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut?: boolean;
}

/** 同步执行（依赖探测等快速操作）。cross-spawn 负责 Windows .cmd/.ps1 shim 解析。 */
export function runSync(cmd: string, args: string[], timeoutMs = 15_000): SpawnResult {
  try {
    const r = crossSpawn.sync(cmd, args, { timeout: timeoutMs, windowsHide: true });
    if (r.error) {
      return { ok: false, code: null, stdout: '', stderr: '', error: r.error.message };
    }
    return {
      ok: r.status === 0,
      code: r.status,
      stdout: r.stdout?.toString() ?? '',
      stderr: r.stderr?.toString() ?? '',
    };
  } catch (e) {
    return { ok: false, code: null, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e) };
  }
}

/** 异步执行（codegraph status 等可能秒级的操作），带超时。 */
export function runAsync(cmd: string, args: string[], timeoutMs = 30_000): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let done = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    const child = crossSpawn(cmd, args, { windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, error: err.message });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        timedOut,
        error: timedOut ? `超时（>${timeoutMs}ms）` : undefined,
      });
    });
  });
}

/** 从可能混有噪声的 stdout 中抠出第一个 JSON 对象 */
export function extractJson(text: string): unknown | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
}

export function lastErrorLine(stderr: string): string {
  const lines = stderr.trim().split(/\r?\n/).filter(Boolean);
  return lines.length > 0 ? (lines.at(-1) as string) : '';
}
