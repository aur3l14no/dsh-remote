import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const [input] = process.argv.slice(2);
if (!input) throw new Error('Usage: check.mjs RESULTS.sarif');
const { runs } = JSON.parse(readFileSync(input, 'utf8'));
assert(runs?.length, 'Missing analysis');
assert(!runs.some(r => r.invocations?.some(i => i.executionSuccessful === false)), 'Analysis failed');
const rules = { native: 'dsh/native-io-use', boundary: 'dsh/workspace-to-native-io' };
const emitted = new Set(runs.flatMap(r => r.tool.driver.rules ?? []).map(r => r.id));
for (const rule of Object.values(rules)) assert(emitted.has(rule), `Missing query: ${rule}`);
const results = runs.flatMap(r => r.results ?? []);
const lines = readFileSync(new URL('./fixtures/cases.ts', import.meta.url), 'utf8').split('\n');
let checked = 0;
for (const [i, line] of lines.entries()) {
  const expected = /\/\/ expect: (.+)/.exec(line)?.[1].split(' ');
  if (!expected) continue;
  for (const [name, rule] of Object.entries(rules)) {
    const found = results.some(r => {
      const p = r.locations[0].physicalLocation;
      return r.ruleId === rule && p.artifactLocation.uri === 'cases.ts' && p.region.startLine === i + 1;
    });
    assert.equal(found, expected.includes(name), `cases.ts:${i + 1}: ${name}`);
  }
  checked++;
}
assert(checked > 0, 'Missing expectations');
console.log(`Passed ${checked} World IO regression cases.`);
