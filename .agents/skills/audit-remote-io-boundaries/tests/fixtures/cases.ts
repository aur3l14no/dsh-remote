// Extracted by CodeQL, never executed. Expectations describe query output.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { defineTool } from '@deepseek-ai/dsh-tools';

declare const ctx: any;

function invoke(fn: typeof readFileSync, path: string) {
  return fn(path); // expect: native boundary
}

function invokeLog(fn: typeof console.log, path: string) {
  return fn(path); // expect: none
}

defineTool({ name: 'fixture', execute(args: any, execution: any) {
  readFileSync(args.path); // expect: native boundary
  const read = readFileSync;
  read(args.path); // expect: native boundary
  invoke(readFileSync, args.path);
  invokeLog(console.log, args.path);
  writeFileSync('/tmp/dsh.log', args.message); // expect: native
  readFileSync('/etc/dsh/config.json'); // expect: native
  ctx.fs.readText(args.path); // expect: none
  spawn('git', ['status'], { cwd: execution.agent.session.header.cwd }); // expect: native boundary
}});
