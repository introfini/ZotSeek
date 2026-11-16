import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { IndexingQueue, IndexingJob } from '../src/core/indexing-queue';

function job(key: string, log: string[], opts: { fail?: boolean; delay?: number } = {}): IndexingJob {
  return {
    key,
    label: key,
    run: async () => {
      log.push(`start:${key}`);
      if (opts.delay) await new Promise(r => setTimeout(r, opts.delay));
      log.push(`end:${key}`);
      if (opts.fail) throw new Error(`boom ${key}`);
    },
  };
}

describe('IndexingQueue', () => {
  test('runs jobs in FIFO order, one at a time', async () => {
    const q = new IndexingQueue();
    const log: string[] = [];
    q.enqueue(job('a', log, { delay: 5 }));
    q.enqueue(job('b', log));
    q.enqueue(job('c', log, { delay: 1 }));
    await q.drain();
    assert.deepEqual(log, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
    assert.equal(q.length, 0);
    assert.equal(q.isRunning, false);
  });

  test('enqueue refuses a second job with the same key', () => {
    const q = new IndexingQueue();
    const log: string[] = [];
    assert.equal(q.enqueue(job('library', log)), true);
    assert.equal(q.enqueue(job('library', log)), false);
    assert.equal(q.length, 1);
    assert.equal(q.has('library'), true);
    assert.equal(q.has('other'), false);
  });

  test('an error in one job does not stop the rest', async () => {
    const errors: string[] = [];
    const q = new IndexingQueue({ logger: { error: m => errors.push(m) } });
    const log: string[] = [];
    q.enqueue(job('a', log, { fail: true }));
    q.enqueue(job('b', log));
    await q.drain();
    assert.deepEqual(log, ['start:a', 'end:a', 'start:b', 'end:b']);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /boom a/);
    assert.equal(q.isRunning, false);
  });

  test('running flag is set synchronously before the first await', async () => {
    const q = new IndexingQueue();
    const log: string[] = [];
    q.enqueue(job('a', log, { delay: 5 }));
    const p = q.drain();
    assert.equal(q.isRunning, true);
    await p;
    assert.equal(q.isRunning, false);
  });

  test('drain is a no-op while already draining', async () => {
    const q = new IndexingQueue();
    const log: string[] = [];
    q.enqueue(job('a', log, { delay: 5 }));
    const first = q.drain();
    q.enqueue(job('b', log));
    await q.drain();
    assert.deepEqual(log, ['start:a'], 'second drain must not start another loop');
    await first;
    assert.deepEqual(log, ['start:a', 'end:a', 'start:b', 'end:b'], 'running loop picks up later jobs');
  });

  test('drain does not start while externally busy, and resumes on a later drain', async () => {
    let busy = true;
    const q = new IndexingQueue({ isExternallyBusy: () => busy });
    const log: string[] = [];
    q.enqueue(job('a', log));
    await q.drain();
    assert.deepEqual(log, []);
    assert.equal(q.isRunning, false);
    assert.equal(q.length, 1);

    busy = false;
    await q.drain();
    assert.deepEqual(log, ['start:a', 'end:a']);
  });

  test('stops between jobs when another run becomes active', async () => {
    let busy = false;
    const q = new IndexingQueue({ isExternallyBusy: () => busy });
    const log: string[] = [];
    q.enqueue({ key: 'a', label: 'a', run: async () => { log.push('a'); busy = true; } });
    q.enqueue(job('b', log));
    await q.drain();
    assert.deepEqual(log, ['a']);
    assert.equal(q.length, 1);
  });

  test('runOrDrain adds the job and runs it when idle', async () => {
    const q = new IndexingQueue();
    const log: string[] = [];
    await q.runOrDrain(job('a', log));
    assert.deepEqual(log, ['start:a', 'end:a']);
  });

  test('clear drops waiting jobs and reports how many', async () => {
    const q = new IndexingQueue({ isExternallyBusy: () => true });
    const log: string[] = [];
    q.enqueue(job('a', log));
    q.enqueue(job('b', log));
    assert.deepEqual(q.labels(), ['a', 'b']);
    assert.equal(q.clear(), 2);
    assert.equal(q.length, 0);
    assert.equal(q.clear(), 0);
  });
});
