import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observe } from '../../shared/lifetime.ts';

test('cancelled Session stops waiting while another observer retains the shared lookup', async () => {
  const shared = Promise.withResolvers<string>();
  const first = new AbortController();
  const second = new AbortController();
  const cancelled = observe(shared.promise, first.signal);
  const retained = observe(shared.promise, second.signal);
  const reason = new Error('Session cancelled');
  first.abort(reason);
  await assert.rejects(cancelled, error => error === reason);
  shared.resolve('/home/world');
  assert.equal(await retained, '/home/world');
});

test('lifecycle disposal interrupts all remaining observers', async () => {
  const shared = Promise.withResolvers<string>();
  const lifecycle = new AbortController();
  const observed = observe(shared.promise, lifecycle.signal);
  lifecycle.abort(new Error('disposed'));
  await assert.rejects(observed, /disposed/);
  shared.resolve('late');
});
