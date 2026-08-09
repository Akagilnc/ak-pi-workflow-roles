import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createComplianceDecisionTool, runComplianceAudit } from "../../src/compliance-transport.ts";

test("independent machine-Pi auditor carries workspace evidence into its later typed decision", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-rpc-role-"));
  const pi = join(cwd, "machine-pi");
  await writeFile(pi, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('0.84.1');process.exit()}let b='';process.stdin.on('data',c=>{b+=c;if(!b.includes('Inspect evidence.txt'))return;console.log(JSON.stringify({type:'tool_execution_end',toolName:'read',result:{content:[{type:'text',text:'court evidence: accepted'}]}}));console.log(JSON.stringify({type:'tool_execution_end',toolName:'ak_test_auditor_decision',result:{details:{status:'pass',violations:[],conflicts:[],decisionGate:null}}}));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[],stopReason:'toolUse',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}}));console.log(JSON.stringify({type:'agent_settled'}))});`);
  await chmod(pi, 0o755);
  const old = { binary: process.env.PI_BINARY, executable: process.env.AK_MACHINE_PI_EXECUTABLE_REALPATH, version: process.env.AK_MACHINE_PI_VERSION };
  process.env.PI_BINARY = pi;
  process.env.AK_MACHINE_PI_EXECUTABLE_REALPATH = pi;
  process.env.AK_MACHINE_PI_VERSION = "0.84.1";
  try {
    const decision = await runComplianceAudit({
      tool: createComplianceDecisionTool("ak_test_auditor_decision", "Submit decision"),
      systemPrompt: "Gather evidence before deciding.", serializedInput: "Inspect evidence.txt", roleLabel: "Test auditor", invalidDecisionLabel: "invalid",
      context: { cwd, model: { provider: "audit-test", id: "model" }, thinkingLevel: "off", modelRegistry: { getProviderAuth: async () => ({ auth: {} }), getApiKeyAndHeaders: async () => ({ ok: true }), getProvider: () => ({ id: "audit-test", name: "Audit test", auth: { apiKey: { name: "test", resolve: async () => ({ auth: {} }) } }, getModels: () => [], stream() { throw new Error("unused"); }, streamSimple() { throw new Error("unused"); } }) }, sessionManager: { getSessionFile: () => join(cwd,"parent.jsonl"), getSessionDir: () => cwd, appendCustomEntry() { return "entry"; } } } as unknown as ExtensionContext,
    });
    assert.equal(decision.status, "pass");
  } finally {
    if (old.binary === undefined) delete process.env.PI_BINARY; else process.env.PI_BINARY = old.binary;
    if (old.executable === undefined) delete process.env.AK_MACHINE_PI_EXECUTABLE_REALPATH; else process.env.AK_MACHINE_PI_EXECUTABLE_REALPATH = old.executable;
    if (old.version === undefined) delete process.env.AK_MACHINE_PI_VERSION; else process.env.AK_MACHINE_PI_VERSION = old.version;
    await rm(cwd,{recursive:true,force:true});
  }
});
