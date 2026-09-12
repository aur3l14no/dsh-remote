import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceScope } from '../../client/src/index.ts';

test('owner close cancels admitted work and waits for cleanup without affecting another borrower', async () => {
  const a = new ResourceScope(), b = new ResourceScope();
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let cleaned = false, closed = false;
  a.own(async () => { cleaned = true; });
  const request = a.run(undefined, async signal => {
    entered.resolve();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    await finish.promise;
    signal.throwIfAborted();
  });
  const rejected = assert.rejects(request, { code: 'OWNER_CLOSED' });
  await entered.promise;
  const closing = a.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false); assert.equal(cleaned, false);
  await assert.rejects(a.run(undefined, async () => 1), { code: 'OWNER_CLOSED' });
  assert.throws(() => a.own(async () => {}), { code: 'OWNER_CLOSED' });
  assert.equal(await b.run(undefined, async () => 7), 7);
  finish.resolve(); await rejected; await closing;
  assert.equal(cleaned, true);
  await b.close();
});

test('owner cleanup attempts all resources and keeps failure visible on repeated close', async () => {
  const owner = new ResourceScope();
  const failure = new Error('unconfirmed release');
  let releases = 0;
  owner.own(async () => { releases++; throw failure; });
  owner.own(async () => { releases++; });
  const closed = owner.close();
  assert.equal(owner.close(), closed);
  await assert.rejects(closed, (error: AggregateError) => error.errors.includes(failure));
  assert.equal(releases, 2);
});

test('a failed early resource release is still reported when its owner closes', async () => {
  const owner = new ResourceScope();
  const failure = new Error('early release unconfirmed');
  const release = owner.own(async () => { throw failure; });
  await assert.rejects(release(), failure);
  await assert.rejects(owner.close(), (error: AggregateError) => error.errors.includes(failure));
});
