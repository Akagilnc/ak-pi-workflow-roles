import assert from "node:assert/strict";
import test from "node:test";
import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {createNavigatorRoleRuntime,NAVIGATOR_EVIDENCE_TOOL_NAME,NAVIGATOR_OUTPUT_TOOL_NAME} from "../src/navigator-role.ts";
import {canonicalSnapshotDigestV1} from "../src/navigator-contracts.ts";
import {sha256Hex} from "../src/sha256.ts";

const id="018f22a0-7b4c-7abc-8def-0123456789ab",bytes=new TextEncoder().encode("x");
const base={version:1 as const,capturedAt:"2025-01-01T00:00:00.000Z",runId:id,subject:{repositoryRoot:"/r",github:{owner:"o",name:"r",id:"R"},parent:{number:1,id:"I"}},children:[],parentObservation:{state:"open" as const,labels:[],observedAt:"2025-01-01T00:00:00.000Z",query:{transport:"github_rest" as const,operation:"issue"}},labelPolicy:[],workspaces:[{id:"w",root:"/r",relation:"repository" as const,head:"a".repeat(40),target:"a".repeat(40)}],evidence:[{id:"e",kind:"input" as const,sha256:sha256Hex(bytes),provenance:{kind:"declared",reference:"x"},handle:"h"}],positionCursor:0,latestAttempt:null};
const snapshot={...base,digest:canonicalSnapshotDigestV1(base)};
function harness(failRegistration=0,failVerification=false,collision=false){
 const tools=new Map<string,any>();if(collision)tools.set(NAVIGATOR_OUTPUT_TOOL_NAME,{});
 let registrations=0,active:string[]=[];const state:{soul:unknown;snapshot:unknown;evidence:unknown}={soul:"LAW",snapshot,evidence:new Map([["h",bytes]])};
 const pi={registerFlag(){},getFlag(){return"snapshot"},registerTool(t:any){registrations++;if(registrations===failRegistration)throw new Error("register");tools.set(t.name,t)},getAllTools(){return[...tools.keys()].map(name=>({name}))},setActiveTools(v:string[]){active=v},getActiveTools(){return failVerification?[NAVIGATOR_EVIDENCE_TOOL_NAME]:active},on(){}};
 const runtime=createNavigatorRoleRuntime(pi as unknown as ExtensionAPI,{loadSoul:async()=>state.soul as string,loadSnapshot:async()=>state.snapshot,loadEvidence:async()=>state.evidence as ReadonlyMap<string,Uint8Array>,auditCompliance:async()=>({status:"pass"})},{failInfrastructure(e){throw e}});
 return{runtime,tools,state,active:()=>active,correctVerification(){failVerification=false}};
}
for(const nth of [1,2])test(`registration failure ${nth} leaves a complete inert pair and permits corrected activation`,async()=>{const h=harness(nth);await assert.rejects(h.runtime.activate());assert.deepEqual([...h.tools.keys()].sort(),[NAVIGATOR_EVIDENCE_TOOL_NAME,NAVIGATOR_OUTPUT_TOOL_NAME].sort());assert.deepEqual(h.active(),[]);await assert.rejects(h.tools.get(NAVIGATOR_EVIDENCE_TOOL_NAME).execute("x",{evidenceId:"e"}),/not activated/);await h.runtime.activate();assert.deepEqual(h.active(),[NAVIGATOR_EVIDENCE_TOOL_NAME,NAVIGATOR_OUTPUT_TOOL_NAME])});
test("active-tool verification failure is fail-closed and retryable",async()=>{const h=harness(0,true);await assert.rejects(h.runtime.activate(),/narrowing/);assert.deepEqual(h.active(),[]);h.correctVerification();await h.runtime.activate();assert.deepEqual(h.active(),[NAVIGATOR_EVIDENCE_TOOL_NAME,NAVIGATOR_OUTPUT_TOOL_NAME])});
for(const [name,breakIt,repair,error] of [
 ["soul",(h:any)=>h.state.soul="   ",(h:any)=>h.state.soul="LAW",/soul is empty/],
 ["snapshot",(h:any)=>h.state.snapshot={...snapshot,digest:"0".repeat(64)},(h:any)=>h.state.snapshot=snapshot,/digest/],
 ["evidence",(h:any)=>h.state.evidence=new Map(),(h:any)=>h.state.evidence=new Map([["h",bytes]]),/handle/],
] as const)test(`${name} loading failure clears prior activation and corrected activation commits exactly two tools`,async()=>{const h=harness();await h.runtime.activate();assert.equal(h.active().length,2);breakIt(h);await assert.rejects(h.runtime.activate(),error);assert.deepEqual(h.active(),[]);repair(h);await h.runtime.activate();assert.deepEqual(h.active(),[NAVIGATOR_EVIDENCE_TOOL_NAME,NAVIGATOR_OUTPUT_TOOL_NAME]);assert.equal(new Set(h.active()).size,2)});
test("pre-existing tool collision fails closed without replacing the collision",async()=>{const h=harness(0,false,true),original=h.tools.get(NAVIGATOR_OUTPUT_TOOL_NAME);await assert.rejects(h.runtime.activate(),/collision/);assert.deepEqual(h.active(),[]);assert.equal(h.tools.get(NAVIGATOR_OUTPUT_TOOL_NAME),original);assert.equal(h.tools.has(NAVIGATOR_EVIDENCE_TOOL_NAME),false)});
