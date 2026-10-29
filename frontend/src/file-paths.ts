/**
 * 按主机记住最后访问的目录（localStorage）。
 *
 * 存储里只有主机 id（编码在键名里）、远端路径和时间戳，绝不保存凭据或文件正文。
 * 这里全部是纯函数，便于 node 单测直接覆盖；localStorage 不可用时静默降级。
 */

export const FILE_PATH_STORAGE_PREFIX = 'edgessh.file-path.v1:';
export const MAX_REMEMBERED_PATH_LENGTH = 4096;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RememberedPath {
  /** 该主机最后一次成功列出的目录。 */
  directory: string;
  /** 写入时间（毫秒时间戳），仅用于排查，不参与恢复逻辑。 */
  updatedAt: number;
}

const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 主机 id 来自服务端；无法安全拼进键名时不记录，避免污染 localStorage。 */
export function isRememberableHostId(value: unknown): value is string {
  return typeof value === 'string' && HOST_ID_PATTERN.test(value);
}

/** 远端路径只接受绝对路径，且与 SFTP 路径校验保持一致。 */
export function isAbsoluteRemotePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_REMEMBERED_PATH_LENGTH
    && value.startsWith('/')
    && !/[\0-\x1f\x7f]/.test(value);
}

/** 每台主机一个键；返回 null 表示这台主机不该被记录。 */
export function filePathStorageKey(hostId: string): string | null {
  return isRememberableHostId(hostId) ? `${FILE_PATH_STORAGE_PREFIX}${hostId}` : null;
}

function parseRecord(raw: unknown): RememberedPath | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!isAbsoluteRemotePath(record.directory)) return null;
  const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) && record.updatedAt >= 0
    ? record.updatedAt
    : 0;
  // 早期版本还存过 `file` 字段；现在只认目录，旧记录里的多余字段直接忽略。
  return { directory: record.directory, updatedAt };
}

export function readRememberedPath(
  storage: Pick<StorageLike, 'getItem'> | null,
  hostId: string,
): RememberedPath | null {
  const key = filePathStorageKey(hostId);
  if (!key || !storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseRecord(parsed);
}

/**
 * 写入该主机最后访问的目录。返回实际写入的记录；校验失败或存储不可用时返回 null。
 */
export function writeRememberedPath(
  storage: Pick<StorageLike, 'setItem'> | null,
  hostId: string,
  directory: string,
  now: number = Date.now(),
): RememberedPath | null {
  const key = filePathStorageKey(hostId);
  if (!key || !storage) return null;
  if (!isAbsoluteRemotePath(directory)) return null;
  const record: RememberedPath = { directory, updatedAt: Math.max(0, Math.trunc(now)) };
  try {
    storage.setItem(key, JSON.stringify(record));
  } catch {
    return null;
  }
  return record;
}
