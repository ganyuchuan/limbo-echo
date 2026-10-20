import { open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

export async function acquireFileLock(path) {
  const owner = { pid: process.pid, token: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(owner)); } finally { await handle.close(); }
      return async () => {
        const saved = JSON.parse(await readFile(path, 'utf8'));
        if (saved.token === owner.token) await unlink(path);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let saved;
      try { saved = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error(`锁 ${basename(path)} 正在初始化或已损坏，请确认没有服务运行后人工检查`); }
      if (!Number.isInteger(saved.pid) || saved.pid <= 0) throw new Error('锁文件的进程信息无效');
      try { process.kill(saved.pid, 0); }
      catch (probeError) {
        if (probeError.code === 'ESRCH') {
          const recoveryPath = `${path}.recovery`;
          let recovery;
          try { recovery = await open(recoveryPath, 'wx', 0o600); } catch { throw new Error('另一个进程正在恢复锁，请稍后重试'); }
          try {
            const latest = JSON.parse(await readFile(path, 'utf8'));
            if (!Number.isInteger(latest.pid) || latest.pid <= 0) throw new Error('锁文件的进程信息无效');
            let dead = false;
            try { process.kill(latest.pid, 0); } catch (latestError) { dead = latestError.code === 'ESRCH'; }
            if (!dead) throw new Error('另一个进程已取得锁，请复用该服务');
            await unlink(path);
          } finally { await recovery.close(); await unlink(recoveryPath); }
          continue;
        }
      }
      throw new Error(`另一个进程正在使用 ${basename(path)}，请复用已运行的本地服务`);
    }
  }
  throw new Error('未能取得本地写入锁，请重试');
}