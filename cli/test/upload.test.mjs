import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upload } from '../lib/operations.mjs';

const chunkSize = 64 * 1024;

function channel(window = 8) {
  const pending = [];
  const hash = createHash('sha256');
  let size = 0, loaded = 0, ended = false, maximum = 0;
  return {
    get maximum() { return maximum; },
    get ended() { return ended; },
    digest: () => hash.digest('hex'),
    send(message) {
      if (Buffer.isBuffer(message)) {
        assert.ok(message.length <= chunkSize);
        pending.push(message);
        maximum = Math.max(maximum, pending.length);
        assert.ok(pending.length <= window);
      } else if (message.type === 'sftp_upload_start') size = message.size;
      else if (message.type === 'sftp_upload_end') {
        assert.equal(loaded, size);
        assert.equal(pending.length, 0);
        ended = true;
      } else assert.fail(`Unexpected message ${message.type}`);
    },
    async until(type) {
      if (type === 'sftp_upload_ready') return window === 1 ? {} : { maxInFlightChunks: window };
      if (type === 'sftp_upload_progress') {
        const bytes = pending.shift();
        assert.ok(bytes);
        // 消费 ACK 时才读取缓冲，能发现 ws.send 后复用缓冲造成的数据污染。
        hash.update(bytes);
        loaded += bytes.length;
        return { loaded };
      }
      assert.equal(type, 'sftp_upload_complete');
      assert.ok(ended);
      return { size: loaded };
    },
  };
}

async function fixture(t, size) {
  const directory = await mkdtemp(join(tmpdir(), 'edgessh-upload-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.bin');
  const file = await open(path, 'w');
  await file.truncate(size);
  for (let offset = 0; offset < Math.min(size, 16 * chunkSize); offset += chunkSize) {
    await file.write(Buffer.alloc(Math.min(chunkSize, size - offset), offset / chunkSize + 1), 0, Math.min(chunkSize, size - offset), offset);
  }
  await file.close();
  return path;
}

test('uploads over 64 MiB stream through an eight-chunk window without buffer corruption', async t => {
  const size = 65 * 1024 * 1024 + 113;
  const path = await fixture(t, size);
  const expected = createHash('sha256');
  for await (const bytes of createReadStream(path)) expected.update(bytes);
  const transport = channel();
  assert.equal((await upload(transport, path, '/fixture.bin', false)).size, size);
  assert.equal(transport.maximum, 8);
  assert.equal(transport.digest(), expected.digest('hex'));
});

test('old upload-ready messages retain a one-chunk window and empty files still commit', async t => {
  for (const size of [0, 3 * chunkSize + 1]) {
    const path = await fixture(t, size);
    const transport = channel(1);
    assert.equal((await upload(transport, path, '/fixture.bin', false)).size, size);
    assert.equal(transport.maximum, size ? 1 : 0);
  }
});

test('invalid acknowledgements and disconnected uploads never report completion', async t => {
  const path = await fixture(t, 12 * chunkSize);
  for (const failure of ['mismatch', 'disconnect']) {
    const transport = channel();
    const original = transport.until;
    transport.until = async type => {
      if (type !== 'sftp_upload_progress') return original(type);
      if (failure === 'disconnect') throw new Error('Connection closed before completion');
      return { loaded: chunkSize + 1 };
    };
    await assert.rejects(upload(transport, path, '/fixture.bin', false), /mismatch|Connection closed/);
    assert.equal(transport.ended, false);
  }
});

test('files above 2 GiB fail before sending an upload request', async t => {
  const path = await fixture(t, 1);
  const file = await open(path, 'r');
  const prototype = Object.getPrototypeOf(file);
  await file.close();
  t.mock.method(prototype, 'stat', async () => ({ size: 2 * 1024 * 1024 * 1024 + 1 }));
  await assert.rejects(upload({ send() { assert.fail('must not send'); } }, path, '/fixture.bin', false), /2 GiB/);
});
