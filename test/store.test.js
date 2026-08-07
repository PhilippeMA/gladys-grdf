import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SyncStore } from '../src/store.js';

async function temporaryDirectory() {
  return mkdtemp(path.join(tmpdir(), 'gazpar-store-'));
}

test('a fresh store starts empty and a missing file is not an error', async () => {
  const store = await new SyncStore({ directory: await temporaryDirectory() }).load();
  assert.equal(store.get('01234567890123'), undefined);
});

test('the cursor survives a save/load round trip', async () => {
  const directory = await temporaryDirectory();
  const store = new SyncStore({ directory });
  store.set('01234567890123', '2026-08-05');
  await store.save();

  const reloaded = await new SyncStore({ directory }).load();
  assert.equal(reloaded.get('01234567890123'), '2026-08-05');
});

test('the cursor only ever moves forward', async () => {
  const store = new SyncStore({ directory: await temporaryDirectory() });
  assert.equal(store.set('pce', '2026-08-05'), true);
  assert.equal(store.set('pce', '2026-08-04'), false);
  assert.equal(store.get('pce'), '2026-08-05');
  assert.equal(store.set('pce', '2026-08-06'), true);
  assert.equal(store.get('pce'), '2026-08-06');
});

test('each metering point keeps its own cursor', async () => {
  const store = new SyncStore({ directory: await temporaryDirectory() });
  store.set('a', '2026-08-05');
  store.set('b', '2026-07-01');
  assert.equal(store.get('a'), '2026-08-05');
  assert.equal(store.get('b'), '2026-07-01');
});

test('reloading does not throw away a cursor that could never be written', async () => {
  // Gladys reconnects call load() again. When /data is unwritable, the file
  // does not exist: re-reading it must not reset what we hold in memory.
  const directory = await temporaryDirectory();
  const store = await new SyncStore({ directory }).load();
  store.set('pce', '2026-08-05');

  await store.load();

  assert.equal(store.get('pce'), '2026-08-05');
});

test('a corrupted file is ignored rather than crashing the integration', async () => {
  const directory = await temporaryDirectory();
  const store = new SyncStore({ directory });
  await writeFile(store.filePath, 'not json at all', 'utf8');

  await store.load();

  assert.deepEqual(store.lastDayByPce, {});
});

test('a file with an unexpected shape is ignored too', async () => {
  const directory = await temporaryDirectory();
  const store = new SyncStore({ directory });
  await writeFile(store.filePath, JSON.stringify({ lastDayByPce: 'nope' }), 'utf8');

  await store.load();

  assert.deepEqual(store.lastDayByPce, {});
});

test('the file is written as readable JSON', async () => {
  const directory = await temporaryDirectory();
  const store = new SyncStore({ directory });
  store.set('01234567890123', '2026-08-05');
  await store.save();

  const content = await readFile(store.filePath, 'utf8');
  assert.deepEqual(JSON.parse(content), { lastDayByPce: { '01234567890123': '2026-08-05' } });
});

test('an unusable location degrades to an in-memory cursor', async () => {
  // Point the store inside a regular FILE: creating the directory fails with
  // ENOTDIR. The reason does not matter — save() must never throw.
  const directory = await temporaryDirectory();
  const blocker = path.join(directory, 'blocker');
  await writeFile(blocker, 'not a directory', 'utf8');

  const store = new SyncStore({ directory: path.join(blocker, 'nested') });
  store.set('pce', '2026-08-05');

  await store.save();

  assert.equal(store.persistent, false);
  assert.equal(store.get('pce'), '2026-08-05');
});
