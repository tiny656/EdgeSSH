import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FILE_PATH_STORAGE_PREFIX,
  filePathStorageKey,
  isAbsoluteRemotePath,
  isRememberableHostId,
  readRememberedPath,
  writeRememberedPath,
  type StorageLike,
} from '../frontend/src/file-paths.ts';

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test('按主机写入并读回目录，键名带主机 id', () => {
  const storage = new MemoryStorage();
  const written = writeRememberedPath(storage, 'alpha', '/root/deploy', 1_790_100_000_000);
  assert.deepEqual(written, { directory: '/root/deploy', updatedAt: 1_790_100_000_000 });
  assert.equal(filePathStorageKey('alpha'), `${FILE_PATH_STORAGE_PREFIX}alpha`);
  assert.deepEqual(readRememberedPath(storage, 'alpha'), written);
});

test('主机之间互相隔离：同一 storage 里各存各的', () => {
  const storage = new MemoryStorage();
  writeRememberedPath(storage, 'alpha', '/srv/alpha');
  writeRememberedPath(storage, 'beta', '/srv/beta');

  assert.equal(readRememberedPath(storage, 'alpha')?.directory, '/srv/alpha');
  assert.equal(readRememberedPath(storage, 'beta')?.directory, '/srv/beta');
  assert.equal(readRememberedPath(storage, 'gamma'), null);
  assert.equal(storage.values.size, 2);
});

test('只保存主机 id、路径和时间戳，不碰凭据', () => {
  const storage = new MemoryStorage();
  writeRememberedPath(storage, 'alpha', '/root');
  const key = filePathStorageKey('alpha')!;
  const raw = storage.values.get(key)!;
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['directory', 'updatedAt']);
  assert.ok(!raw.includes('password'));
  assert.ok(!raw.includes('privateKey'));
  assert.ok(key.includes('alpha'));
});

test('非法主机 id 不进 localStorage', () => {
  const storage = new MemoryStorage();
  for (const id of ['', '../alpha', 'alpha/beta', 'a b', 'x'.repeat(65), '日本語']) {
    assert.equal(isRememberableHostId(id), false, id);
    assert.equal(filePathStorageKey(id), null, id);
    assert.equal(writeRememberedPath(storage, id, '/root'), null, id);
  }
  assert.equal(storage.values.size, 0);
});

test('非法路径被拒绝：必须是绝对路径且不含控制字符', () => {
  assert.equal(isAbsoluteRemotePath('/root'), true);
  assert.equal(isAbsoluteRemotePath('relative/path'), false);
  assert.equal(isAbsoluteRemotePath(''), false);
  assert.equal(isAbsoluteRemotePath('/root\u0000evil'), false);
  assert.equal(isAbsoluteRemotePath('/' + 'x'.repeat(4_096)), false);

  const storage = new MemoryStorage();
  assert.equal(writeRememberedPath(storage, 'alpha', 'relative'), null);
  assert.equal(storage.values.size, 0);
});

test('损坏或伪造的存储内容被忽略，不让脏数据影响导航', () => {
  const storage = new MemoryStorage();
  const key = filePathStorageKey('alpha')!;
  storage.setItem(key, '{not json');
  assert.equal(readRememberedPath(storage, 'alpha'), null);

  storage.setItem(key, JSON.stringify(['array']));
  assert.equal(readRememberedPath(storage, 'alpha'), null);

  storage.setItem(key, JSON.stringify({ directory: 'relative', updatedAt: 1 }));
  assert.equal(readRememberedPath(storage, 'alpha'), null);

  storage.setItem(key, JSON.stringify({ directory: '/ok', updatedAt: -5 }));
  assert.deepEqual(readRememberedPath(storage, 'alpha'), { directory: '/ok', updatedAt: 0 });
});

test('早期版本留下的 file 字段被忽略，只恢复目录', () => {
  const storage = new MemoryStorage();
  const key = filePathStorageKey('alpha')!;
  const legacy = { directory: '/srv/app', file: '/srv/app/app.conf', updatedAt: 42 };
  storage.setItem(key, JSON.stringify(legacy));
  assert.deepEqual(readRememberedPath(storage, 'alpha'), { directory: '/srv/app', updatedAt: 42 });

  // 再写一次目录：旧字段不会被带回来。
  const written = writeRememberedPath(storage, 'alpha', '/srv/other', 43);
  assert.deepEqual(written, { directory: '/srv/other', updatedAt: 43 });
  assert.deepEqual(Object.keys(JSON.parse(storage.values.get(key)!)).sort(), ['directory', 'updatedAt']);
});

test('localStorage 抛错时静默降级，不中断文件管理', () => {
  const throwing: StorageLike = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  assert.equal(readRememberedPath(throwing, 'alpha'), null);
  assert.equal(writeRememberedPath(throwing, 'alpha', '/root'), null);
});
