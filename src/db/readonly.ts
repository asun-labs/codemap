import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface ReadonlyUpstream {
  db: DatabaseSync;
  /** 是否走了 copy-aside 兜底 */
  copiedAside: boolean;
  /** 关闭连接并清理临时副本 */
  dispose(): void;
}

/**
 * 只读打开上游 codegraph 库（v2 §5 护栏：绝不经过上游自己的 open()——它打开即跑 migration 写库）。
 *
 * WAL 边界：上游常态 journal_mode=WAL，读不阻塞写（已核对）。极端态——daemon 已死且
 * 只读连接无法建立 -shm——按 copy-aside 兜底：db+wal+shm 拷贝到临时目录读副本，
 * 副本按读写打开让 sqlite 自行恢复 WAL，上游仍然零写入。
 */
export function openUpstreamReadonly(dbFile: string): ReadonlyUpstream {
  if (!fs.existsSync(dbFile)) {
    throw new Error(`上游库不存在: ${dbFile}`);
  }
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    return {
      db,
      copiedAside: false,
      dispose: () => {
        try {
          db.close();
        } catch {
          /* 已关闭则忽略 */
        }
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codemap-aside-${crypto.randomBytes(3).toString('hex')}-`));
    for (const suffix of ['', '-wal', '-shm']) {
      const src = dbFile + suffix;
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpDir, path.basename(dbFile) + suffix));
    }
    const copyPath = path.join(tmpDir, path.basename(dbFile));
    try {
      const db = new DatabaseSync(copyPath);
      db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
      return {
        db,
        copiedAside: true,
        dispose: () => {
          try {
            db.close();
          } catch {
            /* 已关闭则忽略 */
          }
          fs.rmSync(tmpDir, { recursive: true, force: true });
        },
      };
    } catch (copyErr) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw new Error(`上游库只读打开失败（${reason}），copy-aside 兜底也失败: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`);
    }
  }
}
