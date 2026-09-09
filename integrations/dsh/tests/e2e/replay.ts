// Synthetic model streams: only the model is scripted; tools/providers execute normally.
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function prepareReplay(directory: string) {
  const tool = (name: string, args: object, id: string) => {
    const argumentsJson = JSON.stringify(args);
    return { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] };
  };
  const text = 'REMOTE_ACCEPTANCE_DONE\n\n![Remote preview](/workspace/preview.svg)';
  const entries = [
    tool('read', { file_path: '../workspace/world.txt' }, 'remote_read'),
    tool('bash', { description: 'Verify remote working directory and write a fixture marker', command: 'pwd; cat world.txt; printf browser-proof > browser-proof.txt' }, 'remote_bash'),
    tool('write', { file_path: '../workspace/coding-0.txt', content: 'before\n' }, 'remote_write'),
    tool('read', { file_path: '../workspace/coding-0.txt' }, 'remote_read_edit'),
    tool('edit', { file_path: '../workspace/coding-0.txt', old_string: 'before', new_string: 'after' }, 'remote_edit'),
    tool('grep', { pattern: 'after', path: '/workspace/coding-0.txt' }, 'remote_grep'),
    tool('glob', { pattern: 'coding-0.txt', path: '/workspace' }, 'remote_glob'),
    tool('read', { file_path: '/workspace/nested/file.txt' }, 'remote_nested'),
    tool('skill', { name: 'remote-proof' }, 'remote_skill'),
    tool('bash', { description: 'Execute the deployed skill script in the bound workspace', command: 'sh "$HOME/.agents/skills/remote-proof/scripts/proof.sh"' }, 'remote_skill_exec'),
    tool('bash', { description: 'Start a cancellable remote background task', run_in_background: true, command: 'echo $$ > background.pid; touch background.started; sleep 120; touch background.finished' }, 'remote_background'),
    tool('job_list', {}, 'remote_jobs'),
    tool('web_search', { queries: ['portable workspace boundary'] }, 'local_search'),
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ];
  const override = `${directory}/replay.json`;
  const requests: { url: string | undefined; key: string | string[] | undefined; body: unknown }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, key: request.headers['x-api-key'], body: JSON.parse(body) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ content: [{ type: 'text', text: 'Local connector reached', citations: [
        { type: 'web_search_result_location', url: 'https://example.test/boundary', cited_text: 'host connector' },
      ] }, { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.test/boundary', title: 'Boundary' }] }] }));
    });
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const port = (server.address() as AddressInfo).port;
  entries[1] = tool('bash', { description: 'Verify remote execution and local connector isolation',
    command: `set -eu
pwd
cat world.txt
if env | grep -F local-connector-fixture; then exit 90; fi
if timeout 2 bash -c 'echo probe >/dev/tcp/127.0.0.1/${port}' 2>/dev/null; then exit 91; fi
printf browser-proof > browser-proof.txt` }, 'remote_bash');
  entries.splice(entries.length - 1, 0,
    tool('subagent', { description: 'Check inherited remote skills', prompt: 'Read the bound workspace and execute the deployed remote-proof skill.', run_in_background: false }, 'remote_delegate'),
  );
  const childFile = `${directory}/child.jsonl`;
  const childEntries = [
    tool('read', { file_path: '/workspace/world.txt' }, 'remote_child_read'),
    tool('skill', { name: 'remote-proof' }, 'remote_child_skill'),
    tool('bash', { description: 'Verify child workspace', command: 'sh "$HOME/.agents/skills/remote-proof/scripts/proof.sh"; printf child-proof > child-proof.txt' }, 'remote_child_bash'),
    JSON.parse(JSON.stringify(entries[entries.length - 1]).replaceAll('REMOTE_ACCEPTANCE_DONE', 'REMOTE_CHILD_DONE')),
  ];
  await writeFile(childFile, [
    { type: 'session', version: 2, id: 'remote-child-fixture', createdAt: 1, cwd: '/workspace', isSeeded: false, origin: 'subagent', parentSession: 'remote-parent-fixture', delegationDepth: 1 },
    { type: 'turn/start', data: { turn: 1 } },
    ...childEntries.flatMap((entry, index) => {
      const step = index + 1;
      const content = entry.chunks.filter((chunk: { type: string }) => chunk.type === 'block-end').map((chunk: { block: unknown }) => chunk.block);
      const calls = content.filter((block: { type: string }) => block.type === 'tool-call');
      return [
        { type: 'step/start', data: { turn: 1, step } },
        { type: 'assistant/message', surfaceOp: 'append', data: {
          turn: 1, step, usage: { inputTokens: 10, outputTokens: 5 },
          message: { role: 'assistant', id: `child-message-${index}`, source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' }, content },
          stream: entry.chunks.map((chunk: unknown) => ({ type: 'chunk', time: 1, chunk })),
        } },
        ...calls.flatMap((call: { id: string; name: string; arguments: string }) => [
          { type: 'tool/call', data: { turn: 1, step, callId: call.id, name: call.name, arguments: call.arguments } },
          { type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step, message: {
            role: 'user', id: `child-result-${index}`, source: { kind: 'tool', callId: call.id },
            content: [{ type: 'tool-result', toolCallId: call.id, content: [{ type: 'text', text: 'fixture' }], isError: false }],
          } } },
        ]),
        { type: 'step/end', data: { turn: 1, step } },
      ];
    }),
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  let childFixtures = [childFile];
  await writeFile(override, JSON.stringify(entries));
  let generation = 0;
  return { override, requests, get childFixtures() { return childFixtures; },
    roundScript: () => { generation++; return writeFile(override, JSON.stringify(entries).replace(/remote_[a-z_]+|local_search/g, id => `${id}-${generation}`).replace(/coding-0/g, `coding-${generation}`)); },
    baseURL: `http://127.0.0.1:${port}`,
    cancelScript: () => { childFixtures = []; return writeFile(override, JSON.stringify([tool('bash', {
      description: 'Exercise remote process cancellation',
      command: 'echo $$ > cancel.pid; touch cancel.started; sleep 120; touch cancel.finished',
      timeoutMs: 180000,
    }, 'remote_cancel')])); },
    close: () => new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())) };
}
