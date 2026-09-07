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
  const text = 'REMOTE_ACCEPTANCE_DONE';
  const entries = [
    tool('read', { file_path: '../workspace/world.txt' }, 'remote_read'),
    tool('bash', { description: 'Verify remote working directory and write a fixture marker', command: 'pwd; cat world.txt; printf browser-proof > browser-proof.txt' }, 'remote_bash'),
    tool('write', { file_path: '../workspace/coding-0.txt', content: 'before\n' }, 'remote_write'),
    tool('read', { file_path: '../workspace/coding-0.txt' }, 'remote_read_edit'),
    tool('edit', { file_path: '../workspace/coding-0.txt', old_string: 'before', new_string: 'after' }, 'remote_edit'),
    tool('grep', { pattern: 'after', path: '/workspace/coding-0.txt' }, 'remote_grep'),
    tool('glob', { pattern: 'coding-0.txt', path: '/workspace' }, 'remote_glob'),
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
  await writeFile(override, JSON.stringify(entries));
  let generation = 0;
  return { override, requests,
    roundScript: () => { generation++; return writeFile(override, JSON.stringify(entries).replace(/remote_[a-z_]+|local_search/g, id => `${id}-${generation}`).replace(/coding-0/g, `coding-${generation}`)); },
    baseURL: `http://127.0.0.1:${port}`,
    cancelScript: () => writeFile(override, JSON.stringify([tool('bash', {
      description: 'Exercise remote process cancellation',
      command: 'echo $$ > cancel.pid; touch cancel.started; sleep 120; touch cancel.finished',
      timeoutMs: 180000,
    }, 'remote_cancel')])),
    close: () => new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())) };
}
