import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import test from "node:test";

import { resolveMachinePi, runMachinePiRpc } from "../../src/machine-pi-rpc.ts";

async function fixture(body: string) {
  const root = await mkdtemp(join(tmpdir(), "ak-machine-pi-rpc-"));
  const pi = join(root, "pi");
  await writeFile(pi, `#!${process.execPath}\n${body}`);
  await chmod(pi, 0o755);
  return { root, pi };
}

test("machine Pi RPC uses the resolved executable, LF JSONL, durable session, and terminal settlement", async () => {
  const f = await fixture(`
const fs=require('fs'); if(process.argv.includes('--version')) { console.log('0.84.1-test'); process.exit(); }
const input=[]; process.stdin.on('data', b => { input.push(b); const bytes=Buffer.concat(input); fs.writeFileSync(process.argv[process.argv.indexOf('--session-dir')+1]+'/wire.bin',bytes); console.error('retained diagnostic'); console.log(JSON.stringify({type:'tool_execution_end',toolName:'ak_decide',result:{details:{status:'pass'}}})); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[],stopReason:'toolUse',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}})); console.log(JSON.stringify({type:'agent_settled'})); });`);
  const sessionDir = join(f.root, "sessions");
  const result = await runMachinePiRpc({ env: { PATH: f.root }, cwd: f.root, sessionDir, args: [], commands: [{ id: "p", type: "prompt", message: "inspect" }], decisionToolName: "ak_decide" });
  assert.equal(result.runtime.executableRealpath, await realpath(f.pi));
  assert.equal(result.runtime.version, "0.84.1-test");
  assert.deepEqual(result.decision, { status: "pass" });
  assert.match(result.stderr, /retained diagnostic/);
  assert.match(await readFile(join(sessionDir, "child-stderr.log"), "utf8"), /retained diagnostic/);
  assert.equal((await readFile(join(sessionDir, "wire.bin"), "utf8")), '{"id":"p","type":"prompt","message":"inspect"}\n');
  assert.equal(result.settled, true);
  await rm(f.root, { recursive: true, force: true });
});

test("PI_BINARY preserves bare PATH and explicit package-local overrides without caching", async () => {
  const f = await fixture(`if(process.argv.includes('--version')) { console.log(process.env.VERSION); process.exit(); }`);
  const first = await resolveMachinePi({ PATH: f.root, PI_BINARY: "pi", VERSION: "first" });
  const second = await resolveMachinePi({ PATH: f.root, PI_BINARY: f.pi, VERSION: "second" });
  assert.equal(first.version, "first");
  assert.equal(second.version, "second");
  await rm(f.root, { recursive: true, force: true });
});

test("RPC rejects early-exit write failure without an uncaught process error", async () => {
  const f = await fixture(`if(process.argv.includes('--version')) { console.log('dev'); process.exit(); } process.stdin.destroy(); process.exit(0);`);
  await assert.rejects(runMachinePiRpc({ env: { PATH: f.root }, cwd: f.root, sessionDir: join(f.root, "sessions"), args: [], commands: [{ type: "prompt", message: "x".repeat(8 * 1024 * 1024) }] }));
  await rm(f.root, { recursive: true, force: true });
});

test("RPC rejects invalid JSON and keeps the first accepted matching decision", async () => {
  const invalid = await fixture(`if(process.argv.includes('--version')) { console.log('dev'); process.exit(); } process.stdin.on('data',()=>{console.log('not-json'); setTimeout(()=>process.exit(0),20)});`);
  await assert.rejects(runMachinePiRpc({ env: { PATH: invalid.root }, cwd: invalid.root, sessionDir: join(invalid.root, "sessions"), args: [], commands: [{ type: "prompt", message: "x" }], decisionToolName: "ak_decide" }), /invalid JSONL/);
  await rm(invalid.root, { recursive: true, force: true });

  const duplicate = await fixture(`if(process.argv.includes('--version')) { console.log('dev'); process.exit(); } process.stdin.on('data',()=>{console.log(JSON.stringify({type:'tool_execution_end',toolName:'ak_decide',result:{details:{status:'pass'}}}));console.log(JSON.stringify({type:'tool_execution_end',toolName:'ak_decide',result:{details:{status:'revise'}}}));console.log(JSON.stringify({type:'message_end',message:{role:'assistant'}}));console.log(JSON.stringify({type:'agent_settled'}));setTimeout(()=>process.exit(0),20)});`);
  const result = await runMachinePiRpc({ env: { PATH: duplicate.root }, cwd: duplicate.root, sessionDir: join(duplicate.root, "sessions"), args: [], commands: [{ type: "prompt", message: "x" }], decisionToolName: "ak_decide" });
  assert.deepEqual(result.decision, { status: "pass" });
  await rm(duplicate.root, { recursive: true, force: true });
});

test("pre-aborted caller with a nonempty command retains abort identity", async () => {
  const f = await fixture(`if(process.argv.includes('--version')) { console.log('dev'); process.exit(); } process.stdin.resume();`);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runMachinePiRpc({ env: { PATH: f.root }, cwd: f.root, sessionDir: join(f.root, "sessions"), args: [], commands: [{ type: "prompt", message: "x".repeat(1024 * 1024) }], signal: controller.signal }), /abort/i);
  await rm(f.root, { recursive: true, force: true });
});

test("caller abort terminates the machine Pi child with SIGTERM", async () => {
  const marker = join(tmpdir(), `ak-rpc-sigterm-${process.pid}`); const ready = `${marker}-ready`;
  const f = await fixture(`if(process.argv.includes('--version')) { console.log('dev'); process.exit(); } require('fs').writeFileSync('${ready}','yes'); process.on('SIGTERM',()=>{require('fs').writeFileSync('${marker}','yes'); process.exit(0)}); process.stdin.resume();`);
  await rm(marker, { force: true }); await rm(ready, { force: true });
  const controller = new AbortController();
  const pending = runMachinePiRpc({ env: { PATH: f.root }, cwd: f.root, sessionDir: join(f.root,"sessions"), args: [], commands: [], signal: controller.signal });
  for (;;) { try { await access(ready); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }
  controller.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(await readFile(marker, "utf8"), "yes");
  await rm(marker, { force: true }); await rm(ready, { force: true }); await rm(f.root, { recursive: true, force: true });
});
