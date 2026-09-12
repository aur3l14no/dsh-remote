import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { launchWebScaffold } from './scaffold.ts';
import { newEnglishPage } from './support.ts';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

it('completes a real-model coding and external-search task in the selected World', async () => {
  const root = process.env.DSH_REMOTE_ROOT!;
  const state = process.env.DSH_REMOTE_STATE!;
  const host = await launchWebScaffold({ extraOverlayPath: `${process.env.DSH_TEST_EXTENSION}/cordis.patch.yml`,
    extraInstallAnchors: [`${process.env.DSH_TEST_EXTENSION}/package.json`], compareReplaySession: false,
    directoryPicking: false, persistentStateRoot: state, harnessHome: `${state}/home`,
    agentPresets: { default: 'remote', roots: [{ path: `${process.env.DSH_TEST_EXTENSION}/presets`, trust: 'system' }] }, toolsMode: 'native' });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await newEnglishPage(browser);
    await page.goto(host.authenticatedUrl);
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
    await page.getByRole('menuitem').filter({ hasText: '/workspace' }).first().click();
    await expect.poll(() => host.ctx.agents.list().length, { timeout: 30000 }).toBe(1);
    const agent = host.ctx.agents.list()[0]!;
    const results: Extract<SessionEvent, { type: 'tool/result' }>[] = [];
    const tools: string[] = [];
    const searchResults: unknown[] = [];
    host.ctx.on('tools/execute', async (execution, next) => {
      tools.push(execution.name);
      const result = await next();
      if (execution.name === 'web_search') searchResults.push(result);
      return result;
    });
    host.ctx.on('session/event', (_session, event) => { if (event.type === 'tool/result') results.push(event); });
    const settled = host.whenTurnSettled(150000);
    const input = page.locator('[data-composer-input][contenteditable=true]').first();
    await input.fill('Complete this small acceptance task in the selected remote workspace, without delegation. Read AGENTS.md and world.txt. Load the remote-proof skill and execute its bundled script. Create sum.sh that prints the sum of two integer arguments, and test-sum.sh that checks 2 + 3 = 5 and -2 + 3 = 1, then prints LIVE_TEST_PASSED; execute the tests. Use the web_search tool to find the official Python unittest documentation. Write LIVE_ACCEPTANCE.md with the World marker from world.txt, the passing test result and an actual URL from the search. Verify that DEEPSEEK_API_KEY is not set in the remote command environment, without printing any credential. Finish with LIVE_ACCEPTANCE_DONE.');
    await input.press('Enter');
    expect(await settled).toBe(agent.session.header.id);
    expect(tools).toContain('web_search');
    expect(searchResults).toEqual(expect.arrayContaining([expect.objectContaining({ isError: false })]));
    expect(JSON.stringify(searchResults)).toContain('docs.python.org');
    expect(tools).toContain('skill');
    expect(tools).toContain('bash');
    const owner = host.ctx.get('executionWorlds').forAgent(agent);
    expect(await owner.fs.readText(await owner.fs.resolve('skill-proof.txt'))).toBe('a\n');
    const report = await owner.fs.readText(await owner.fs.resolve('LIVE_ACCEPTANCE.md'));
    expect(report).toContain('LIVE_TEST_PASSED');
    expect(report).toMatch(/https:\/\/docs\.python\.org\//);
    const verify = owner.subprocess.spawn({ argv: ['bash', '-c', 'test -z "${DEEPSEEK_API_KEY+x}" && sh test-sum.sh'], cwd: '/workspace',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 500, signal: AbortSignal.timeout(15000) });
    expect((await verify.done).exitCode).toBe(0);
    await verify.waitForExit();
    const other = await host.ctx.get('worldPortableWorkspaces').createInWorld('b', '/workspace');
    const otherOwner = await host.ctx.get('executionWorlds').prepareWorkspace(host.ctx.get('worldPortableWorkspaces').definition(other.id));
    expect(await otherOwner.fs.stat(await otherOwner.fs.resolve('LIVE_ACCEPTANCE.md'))).toBeUndefined();
    expect(results.length).toBeGreaterThan(0);
    await writeFile(`${root}/artifacts/dsh/live-details.json`, JSON.stringify({ model: agent.options.model, tools, searchSucceeded: true, codingTestsPassed: true, remoteCredentialAbsent: true, otherWorldUnchanged: true }, null, 2) + '\n');
    await page.screenshot({ path: `${root}/artifacts/dsh/web-live-acceptance.png`, fullPage: true });
  } finally { await browser.close(); await host.close(); }
}, 180000);
