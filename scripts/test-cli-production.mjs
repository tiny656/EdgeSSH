import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessToken, loadConfig, siteOrigin } from '../cli/lib/config.mjs';

// 仅显式运行；所有写操作限制在随机 /tmp 目录，不接触现有配置或服务。
const { values } = parseArgs({ options: {
  origin: { type: 'string' }, host: { type: 'string', multiple: true }, cli: { type: 'string' },
} });
assert.ok(values.origin && values.host?.length, 'Use --origin https://your-site --host NAME [--host NAME] [--cli PATH]');
const origin = siteOrigin(values.origin);
const binary = values.cli ? resolve(values.cli) : fileURLToPath(new URL('../cli/bin.mjs', import.meta.url));
const token = await accessToken(origin);
const run = promisify(execFile);
const local = await mkdtemp(join(tmpdir(), 'edgessh-agent-scenario-'));
const config = join(local, 'config.json');
await writeFile(config, JSON.stringify({ ...await loadConfig(), origin }), { mode: 0o600 });
const env = { ...process.env, EDGESSH_ACCESS_TOKEN: token, EDGESSH_CONFIG: config };
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let passed = 0;

async function cli(args, expected = 0) {
  let result;
  try { result = { ...await run(process.execPath, [binary, ...args], { env, timeout: ['put', 'get'].includes(args[0]) ? 660_000 : 90_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }), code: 0 }; }
  catch (error) { result = error; }
  assert.equal(result.code, expected, `${args[0]} expected ${expected}, got ${result.code}: ${result.stderr}`);
  return result;
}
async function exec(host, command, expected = 0, options = []) {
  const result = await cli(['exec', host, '--json', '--timeout', '45', ...options, '--', command], expected);
  return result.stdout ? JSON.parse(result.stdout) : result;
}
function pass(host, name) { passed++; console.log(`PASS ${host}: ${name}`); }

async function scenario(host, index) {
  const remote = `/tmp/edgessh-agent-scenario-${randomUUID()}`;
  console.log(`FIXTURE ${host} ${remote}`);
  const path = name => `${remote}/${name}`;
  const command = source => `python3 -c ${quote(`exec(${JSON.stringify(source)})`)} ${quote(remote)}`;
  let created = false;
  let failure;
  try {
    const preflight = await exec(host, 'command -v python3 tar sha256sum; test -d /tmp && test -w /tmp');
    assert.equal(preflight.exitCode, 0);
    assert.match(preflight.stdout, /python3/);
    assert.match(preflight.stdout, /\/tar(?:\r?\n|$)/);
    assert.match(preflight.stdout, /\/sha256sum(?:\r?\n|$)/);
    pass(host, 'read-only tool and temporary-directory preflight');

    created = true;
    await cli(['mkdir', host, remote]);
    await cli(['mkdir', host, path('release one')]);
    const payload = randomBytes((index ? 1024 * 1024 : 4 * 1024 * 1024) + 113);
    const source = join(local, `payload-${index}.bin`);
    const configV1 = join(local, `v1-${index}.json`);
    const configV2 = join(local, `v2-${index}.json`);
    const invalid = join(local, `invalid-${index}.json`);
    const script = join(local, `app-${index}.py`);
    await writeFile(source, payload);
    await writeFile(configV1, JSON.stringify({ version: 1, enabled: true, message: 'first release' }));
    await writeFile(configV2, JSON.stringify({ version: 2, enabled: true, message: 'updated release' }));
    await writeFile(invalid, '{invalid-json');
    await writeFile(script, `import sys,json,hashlib,pathlib
r=pathlib.Path(sys.argv[1])
try:
    c=json.loads((r/'配置 file.json').read_text())
    assert c['enabled'] is True
    d=(r/'input data.bin').read_bytes()
    print(json.dumps({'version':c['version'],'sha256':hashlib.sha256(d).hexdigest(),'size':len(d)}))
    print('fixture-validation-ok',file=sys.stderr)
except (ValueError,KeyError,AssertionError):
    print('fixture-invalid-config',file=sys.stderr)
    sys.exit(23)
`);
    const release = path('release one');
    for (const [file, name] of [[source, 'input data.bin'], [configV1, '配置 file.json'], [script, 'app.py']]) {
      console.log(`STEP ${host}: uploading ${name}`);
      await cli(['put', host, file, `${release}/${name}`]);
    }
    const app = () => exec(host, `cd ${quote(remote)} && python3 ${quote(`${release}/app.py`)} ${quote(release)}`);
    const first = await app();
    assert.deepEqual(JSON.parse(first.stdout), { version: 1, sha256: hash(payload), size: payload.length });
    assert.match(first.stderr, /fixture-validation-ok/);
    const downloaded = join(local, `download-${index}.bin`);
    await cli(['get', host, `${release}/input data.bin`, downloaded]);
    assert.equal(hash(await readFile(downloaded)), hash(payload));
    pass(host, `multi-file release, Unicode/space paths, ${payload.length}-byte binary round trip and JSON/stdout/stderr`);

    // 在测试目录内模拟更新与回滚；不重试可能已产生远端副作用的写命令。
    await exec(host, `cp ${quote(`${release}/配置 file.json`)} ${quote(path('config.backup'))}`);
    await cli(['put', host, configV2, `${release}/配置 file.json`], 1);
    assert.equal(JSON.parse((await app()).stdout).version, 1);
    await cli(['put', host, configV2, `${release}/配置 file.json`, '--force']);
    assert.equal(JSON.parse((await app()).stdout).version, 2);
    await cli(['put', host, invalid, `${release}/配置 file.json`, '--force']);
    const failed = await exec(host, `python3 ${quote(`${release}/app.py`)} ${quote(release)}`, 23);
    assert.equal(failed.exitCode, 23); assert.match(failed.stderr, /fixture-invalid-config/);
    await exec(host, `cp ${quote(path('config.backup'))} ${quote(`${release}/配置 file.json`)}`);
    assert.equal(JSON.parse((await app()).stdout).version, 1);
    pass(host, 'overwrite protection, atomic update, failing validation exit 23 and explicit rollback');

    const results = await Promise.all([1, 2, 3].map(i => exec(host, `printf ${quote(`concurrent-${i}`)}`)));
    assert.deepEqual(results.map(result => result.stdout), ['concurrent-1', 'concurrent-2', 'concurrent-3']);
    pass(host, 'three concurrent independent SSH commands');

    const manifest = await exec(host, command(`import pathlib,sys,hashlib,json
r=pathlib.Path(sys.argv[1]); files=sorted(p for p in (r/'release one').iterdir() if p.is_file())
m={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
(r/'manifest.json').write_text(json.dumps(m)); print(json.dumps(m))`));
    const expectedManifest = JSON.parse(manifest.stdout);
    await exec(host, `cd ${quote(remote)} && tar -cf bundle.tar 'release one' manifest.json && sha256sum bundle.tar`);
    const archive = join(local, `bundle-${index}.tar`);
    await cli(['get', host, path('bundle.tar'), archive]);
    const remoteHash = await exec(host, `sha256sum ${quote(path('bundle.tar'))}`);
    assert.equal(hash(await readFile(archive)), remoteHash.stdout.split(/\s/)[0]);
    // 本地 tar 只列出清单，不解压远端归档到用户目录。
    const listing = await run('tar', ['-tf', `bundle-${index}.tar`], { cwd: local, windowsHide: true });
    for (const name of Object.keys(expectedManifest)) assert.ok(listing.stdout.includes(`release one/${name}`));
    await exec(host, `cd ${quote(remote)} && mkdir restored && tar -xf bundle.tar -C restored`);
    const restored = await exec(host, command(`import pathlib,sys,hashlib,json
r=pathlib.Path(sys.argv[1])/'restored'; m=json.loads((r/'manifest.json').read_text())
assert all(hashlib.sha256((r/'release one'/n).read_bytes()).hexdigest()==h for n,h in m.items())
print('restored-content-verified')`));
    assert.match(restored.stdout, /restored-content-verified/);
    pass(host, 'archive download hash, local listing and restored content manifest');

    await cli(['get', host, path('missing.bin'), join(local, `missing-${index}`)], 1);
    await cli(['get', host, `${release}/input data.bin`, downloaded], 1);
    assert.equal(hash(await readFile(downloaded)), hash(payload));
    assert.ok(!(await readdir(local)).some(name => name.endsWith('.part')));
    await cli(['mv', host, `${release}/app.py`, `${release}/配置 file.json`], 1);
    assert.equal(JSON.parse((await app()).stdout).version, 1);
    await cli(['mv', host, path('manifest.json'), path('manifest moved.json')]);
    await cli(['rm', host, path('manifest moved.json')]);
    pass(host, 'missing file failure, local overwrite protection, rename collision preservation and rename/delete');

    const timeout = await cli(['exec', host, '--json', '--timeout', '7', '--', 'sleep 15'], 1);
    assert.match(timeout.stderr, /timed out/);
    const limit = await cli(['exec', host, '--json', '--timeout', '20', '--max-output', '1024', '--', 'python3 -c \'print("x"*2048)\''], 1);
    assert.match(limit.stderr, /output limit/);
    assert.equal((await exec(host, 'printf after-failure-ok')).stdout, 'after-failure-ok');
    pass(host, 'timeout/output-limit errors and successful subsequent connection');
  } catch (error) { failure = error; }
  finally {
    if (created) {
      try {
        await exec(host, command(`import pathlib,sys,shutil
r=pathlib.Path(sys.argv[1]); assert r.parent==pathlib.Path('/tmp') and r.name==${JSON.stringify(remote.split('/').at(-1))} and not r.is_symlink()
if r.exists(): shutil.rmtree(r)
assert not r.exists(); print('fixture-removed')`));
        const absent = await exec(host, `test ! -e ${quote(remote)} && printf fixture-absent`);
        assert.equal(absent.stdout, 'fixture-absent');
        pass(host, `cleanup verified: ${remote}`);
      } catch (error) {
        console.error(`CLEANUP REQUIRED ${host} ${remote}`);
        failure = new AggregateError([failure, error].filter(Boolean), 'Scenario or cleanup failed');
      }
    }
  }
  if (failure) throw failure;
}

try {
  // 使用相对路径，避免 Windows 盘符被 GNU tar 解释成远端主机。
  const probe = '本地 archive probe.bin';
  await writeFile(join(local, probe), 'local-preflight');
  await run('tar', ['-cf', 'probe.tar', probe], { cwd: local, windowsHide: true });
  const listing = await run('tar', ['-tf', 'probe.tar'], { cwd: local, windowsHide: true });
  assert.ok(listing.stdout.includes(probe), 'Local tar must list Unicode paths without escaping');
  console.log('PASS local archive preflight');
  for (const [index, host] of values.host.entries()) await scenario(host, index);
  console.log(`RESULT ${passed} checks passed across ${values.host.length} host(s)`);
} finally { await rm(local, { recursive: true, force: true }); }
