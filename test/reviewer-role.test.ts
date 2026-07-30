import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createReviewerRoleRuntime, AGENT_TOOL_NAME, REVIEWER_OUTPUT_TOOL_NAME, type ReviewerAuditInput } from "../src/reviewer-role.ts";
import type { AcceptedReviewerDispatch, ReviewerProposalV1 } from "../src/reviewer-dispatch.ts";

const task = new TextEncoder().encode("review exact bytes\n");
const digest = createHash("sha256").update(task).digest("hex");
const operations = ["preflight.git.pin-target","preflight.git.resolve-base","preflight.git.derive-range","preflight.git.list-ordered-commits","preflight.git.read-material","runner.git.materialize-mirror","runner.git.materialize-workspace","runner.git.verify-snapshot"] as const;
const capabilities = new TextEncoder().encode(JSON.stringify({ version: 1, taskSha256: digest, tools: ["read"], bashCommands: [], prerequisiteOperations: operations }));
const skill = "## Standards baseline\nbaseline\n## Standards review burden\nstandards\n## Spec review burden\nspec";
const pin = { repositoryRoot: "/repo", targetHead: "target", refs: { "refs/heads/main": "target" } };
const request = { tools: ["read"] as const, bashCommands: [] as const, prerequisiteOperations: operations };
function proposal(established = false): ReviewerProposalV1 { return { version: 1, base: { revision: "main~1" }, standardsMaterials: [{ id: "rules", repositoryPath: "RULES.md" }], spec: established ? { state: "established", materials: [{ id: "spec", repositoryPath: "SPEC.md" }] } : { state: "not-established", evidence: [{ id: "absence", repositoryPath: "README.md" }] }, required: established ? { standards: request, spec: request } : { standards: request } }; }
function harness() {
  const tools = new Map<string, any>(); const flags: Record<string,string> = { "ak-review-task":"/task", "ak-review-capabilities":"/caps" }; const handlers = new Map<string,any>();
  const pi = { registerFlag() {}, getFlag(n:string){return flags[n];}, registerTool(t:any){tools.set(t.name,t);}, getAllTools(){return [...tools.keys()].map(name=>({name}));}, setActiveTools() {}, on(n:string,f:any){handlers.set(n,f);} } as unknown as ExtensionAPI;
  return { pi, tools, flags, handlers };
}
function outputContext(id:string): ExtensionContext { const sessionManager=SessionManager.inMemory(); sessionManager.appendMessage({role:"assistant",content:[{type:"toolCall",id,name:REVIEWER_OUTPUT_TOOL_NAME,arguments:{}}],api:"x",provider:"x",model:"x",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"toolUse",timestamp:Date.now()}); return {sessionManager,abort(){},mode:"tui"} as unknown as ExtensionContext; }
function setup(overrides: Partial<Parameters<typeof createReviewerRoleRuntime>[1]> = {}) {
  const h=harness(); let starts=0; const audits:ReviewerAuditInput[]=[];
  const runtime=createReviewerRoleRuntime(h.pi,{ loadSoul:async()=>"law", loadTask:async()=>task, loadCapabilities:async()=>capabilities, loadCanonicalSkillBinding:async()=>({name:"code-review",snapshot:{raw:skill,path:"/skill",baseDir:"/",body:skill},invocation:x=>x,captureExpansion:()=>undefined}), createPinnedGitReader:async()=>({pin,resolve:async()=>"base",range:async()=>({base:"base",target:"target",diffCommand:"git diff base target",commits:["target"]}),material:async(path)=>new TextEncoder().encode(path)}), hostTools:()=>["read"], runDispatch:async(dispatch:AcceptedReviewerDispatch)=>{starts++; const legs:any={}; for(const leg of dispatch.legs) legs[leg.axis]={report:`${leg.axis} report`,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},target:pin,prompt:{bytes:leg.prompt,utf8Length:leg.utf8Length,sha256:leg.sha256},workspaceDisposition:"deleted"}; return {identity:dispatch.identity,target:pin,legs};}, auditCompliance:async input=>{audits.push(input);return {status:"pass"};}, ...overrides },{failInfrastructure(error){throw error;}});
  return {...h,runtime,audits,get starts(){return starts;}};
}

test("activation fails closed for absent, malformed, and task-mismatched capabilities", async()=>{
  const missing=setup(); delete missing.flags["ak-review-capabilities"]; await assert.rejects(missing.runtime.activate(),/requires --ak-review-capabilities/);
  await assert.rejects(setup({loadCapabilities:async()=>new TextEncoder().encode("{}")}).runtime.activate(),/capabilities/);
  const wrong=new TextEncoder().encode(JSON.stringify({version:1,taskSha256:"0".repeat(64),tools:[],bashCommands:[],prerequisiteOperations:[]}));
  await assert.rejects(setup({loadCapabilities:async()=>wrong}).runtime.activate(),/digest mismatch/);
});

test("preflight rejection can be corrected, starts no rejected runner, and accepts only one dispatch", async()=>{
  const h=setup(); await h.runtime.activate(); const tool=h.tools.get(AGENT_TOOL_NAME); const ctx={} as ExtensionContext;
  const bad:any={...proposal(),standardsMaterials:[]}; const rejected=await tool.execute("bad",bad,undefined,undefined,ctx); assert.equal(rejected.details.status,"rejected"); assert.equal(h.starts,0);
  const accepted=await tool.execute("ok",proposal(),undefined,undefined,ctx); assert.equal(accepted.details.status,"accepted"); assert.equal(accepted.details.dispatch.legs.length,1); assert.equal(h.starts,1);
  const closed=await tool.execute("later",proposal(true),undefined,undefined,ctx); assert.equal(closed.details.status,"closed"); assert.equal(h.starts,1);
});

test("established Spec runs exactly two legs with actual prompts equal to compiled prompts", async()=>{
  const h=setup(); await h.runtime.activate(); const result=await h.tools.get(AGENT_TOOL_NAME).execute("ok",proposal(true),undefined,undefined,{} as ExtensionContext);
  assert.equal(result.details.dispatch.legs.length,2); assert.deepEqual(result.details.dispatch.legs.map((x:any)=>x.axis),["standards","spec"]); assert.equal(h.starts,1);
});

test("completion audits projected facts and revise can be resubmitted without rerunning", async()=>{
  let calls=0; const h=setup({auditCompliance:async(input)=>{h.audits.push(input);calls++;return calls===1?{status:"revise",violations:["aggregate"]}:{status:"pass"};}}); await h.runtime.activate();
  await h.tools.get(AGENT_TOOL_NAME).execute("run",proposal(),undefined,undefined,{} as ExtensionContext);
  const out=h.tools.get(REVIEWER_OUTPUT_TOOL_NAME); await assert.rejects(out.execute("one",{status:"completed",report:"report"},undefined,undefined,outputContext("one")),/aggregate/);
  const done=await out.execute("two",{status:"completed",report:"report"},undefined,undefined,outputContext("two")); assert.equal(done.terminate,true); assert.equal(h.starts,1); assert.equal(calls,2); assert.equal(h.audits[1]?.record.results.standards?.prompt.bytes,h.audits[1]?.record.accepted?.legs[0]?.prompt);
});

test("runner infrastructure failure blocks refusal and completion before audit", async()=>{
  let audits=0; const h=setup({runDispatch:async()=>{throw new Error("provider unavailable");},auditCompliance:async()=>{audits++;return {status:"pass"};}}); await h.runtime.activate();
  await assert.rejects(h.tools.get(AGENT_TOOL_NAME).execute("run",proposal(),undefined,undefined,{abort(){},mode:"tui"} as ExtensionContext),/provider unavailable/);
  await assert.rejects(h.tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute("out",{status:"refused",report:"infra"},undefined,undefined,outputContext("out")),/infrastructure previously failed/); assert.equal(audits,0);
});
