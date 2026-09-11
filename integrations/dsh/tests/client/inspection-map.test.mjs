import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { machineMapHtml } from '../../packages/inspection/machine-inspection/src/map.ts';

test('inspection map supports hover/focus and safely lays out large fleets on narrow screens', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [375, 1200]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent(machineMapHtml(Array.from({ length: 24 }, (_, i) => ({ id: String(i), worldId: 'fixture',
        name: i === 0 ? '</script><script>window.injected=1</script>' : `node-${i}`, childId: 'fixture',
        status: 'failed', state: 'failed', at: '2026-09-12', error: 'Synthetic failure' }))));
      await page.locator('.node').nth(1).hover();
      assert.equal(await page.locator('#detail h2').innerText(), 'node-1');
      await page.locator('.node').last().focus();
      assert.equal(await page.locator('#detail h2').innerText(), 'node-23');
      assert.equal(await page.evaluate(() => window.injected), undefined);
      const overlap = await page.locator('.node').evaluateAll(nodes => nodes.some((node, i) => nodes.slice(i + 1).some(other => {
        const a = node.getBoundingClientRect(), b = other.getBoundingClientRect();
        return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      })));
      assert.equal(overlap, false);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
