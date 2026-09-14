import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['integrations/dsh/packages/workspace/portable-workspace/src/client/session-marker.ts'],
  bundle: true, write: false, platform: 'node', format: 'esm' });
const { sessionMarker } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('an idle session shows no marker, matching the official hidden idle row', () => {
  assert.equal(sessionMarker({ running: false }, undefined), undefined);
  assert.equal(sessionMarker({ running: false, completed: false }, undefined), undefined);
});

test('a running session shows the ongoing marker and a finished-unopened one the reminder', () => {
  assert.equal(sessionMarker({ running: true }, undefined), 'ongoing');
  assert.equal(sessionMarker({ running: false, completed: true }, undefined), 'done');
});

test('activity outranks the completion reminder', () => {
  assert.equal(sessionMarker({ running: true, completed: true }, undefined), 'ongoing');
});

test('every published pending interaction outranks activity as a warning', () => {
  assert.equal(sessionMarker({ running: true, completed: true }, 'approval'), 'warning');
  assert.equal(sessionMarker({ running: false }, 'plan-review'), 'warning');
  assert.equal(sessionMarker({ running: true }, 'question'), 'warning');
});

test('an unknown pending kind falls back to the activity marker', () => {
  assert.equal(sessionMarker({ running: true }, 'future-interaction'), 'ongoing');
  assert.equal(sessionMarker({ running: false, completed: true }, 'future-interaction'), 'done');
});
