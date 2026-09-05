import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * Owner 2026-08-23 (immediate order, no separate ticket): a dispatch that exits
 * by throwing must not bypass the auto-resume retry mechanism.
 * Mechanical regression, loop level:
 *  (a) retries up to the configured budget (autoResumeCount reaches the limit),
 *  (b) each attempt retains its own error file, later attempts never overwrite
 *      earlier ones,
 *  (c) the session dossier carries addressable pointers to those files,
 *  (d) the final outcome is a loud typed failure carrying the last true cause.
 * Whole-object retention is proven by reading the transfer code (whole
 * serialized thrown value, no field picking) — never by content comparison.
 */
import assert from "node:assert/strict";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import test from "node:test";

import { runWithAutoResumeLoop, DISPATCH_ERROR_RETENTION_ENTRY_TYPE } from "../../src/public-cli/auto-resume.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";

async function withTempHome<T>(fn:(home:string)=>Promise<T>):Promise<T>{
  const home=await mkdtemp(worktreeTempPrefix("ak-dispatch-throw-"));
  return await fn(home)
}
function captureIo(){const stdout:string[]=[];const stderr:string[]=[];return{stdout,stderr,io:{stdout:(t:string)=>stdout.push(t),stderr:(t:string)=>stderr.push(t)}};}

type LoopDispatchResult={exitCode:number;terminal?:TerminalResult};

function alwaysThrowingDispatch(callsRef:{n:number}, messages:readonly string[]){
  // Mirrors the dispatcher lease contract: release runs even when dispatch throws.
  return async(_extraArgs:readonly string[], lease:{release():Promise<void>}):Promise<LoopDispatchResult>=>{
    try{
      callsRef.n+=1;
      throw new Error(messages[Math.min(callsRef.n-1,messages.length-1)]!);
    }finally{
      await lease.release();
    }
  };
}

type PointerEntry={data?:{file?:unknown};};

test("dispatch exceptions retry to budget with full per-attempt retention and typed failure", async()=>{
  await withTempHome(async(home)=>{
    const runDir=join(home,"runs","throw-loop-limit2b");
    await mkdir(join(runDir,"session"),{recursive:true});
    const sessionFile=join(runDir,"session","session.jsonl");
    await writeFile(sessionFile,"{}\n","utf8");
    const callsRef={n:0};
    const {io}=captureIo();
    const result=await runWithAutoResumeLoop({
    principalAuthority: piDurablePrincipalAuthority,
      sessionAppender: appendPiSessionCustomEntry,
      admitted:{principal:fixturePrincipal(dirname(sessionFile),sessionFile),runDirectory:runDir,role:"judge",runId:"throw-loop-limit2b"},
      io,
      autoResumeLimit:2,
      buildInitialPayload: ()=>["--initial"],
      buildResumePayload: ()=>["--resume"],
      dispatch:alwaysThrowingDispatch(callsRef,[`boom-attempt-${1}`,`boom-attempt-${2}`,`boom-final`]),
    });
    const terminal=result.terminal as TerminalResult;

    // (a) budget reached: initial + limit resumes; count observation equals limit.
    assert.equal(callsRef.n,3);
    assert.equal(result.exitCode,1);
    assert.equal(terminal.roleOutcome.kind,"failure");
    assert.equal(terminal.autoResumeCount,2);

    // (b) one retained error file per attempt; unique names — no overwrite.
    const artifactsDir=join(runDir,"artifacts");
    const files=(await readdir(artifactsDir)).filter((f)=>f.startsWith("dispatch-error-attempt-")).sort();
    assert.equal(files.length,3);
    assert.equal(new Set(files).size,3);
    for(const f of files){
      const s=await stat(join(artifactsDir,f));
      assert.ok(s.isFile());
    }

    // (c) dossier pointers address exactly these files.
    const lines=(await readFile(sessionFile,"utf8")).trim().split("\n").filter(Boolean);
    const pointers=lines.map((l)=>JSON.parse(l) as PointerEntry)
      .filter((e)=>typeof e==="object"&&e!==null&&(e as {customType?:unknown}).customType===DISPATCH_ERROR_RETENTION_ENTRY_TYPE);
    assert.equal(pointers.length,3);
    const pointered=new Set<string>();
    for(const p of pointers){
      const file=p.data?.file as unknown;
      assert.equal(typeof file,"string");
      pointered.add(file as string);
      await stat(file as string); // pointer target exists
    }
    assert.equal(pointered.size,3);

    // (d) typed failure carries the LAST true cause and the artifact pointers.
    if(terminal.roleOutcome.kind!=="failure")throw new Error("unreachable");
    assert.match(terminal.roleOutcome.diagnostic,/boom-final/);
    const filesFromFacts=terminal.roleOutcome.decisiveFacts.dispatchErrorFiles as readonly string[];
    assert.equal(filesFromFacts.length,3);
    assert.deepEqual([...filesFromFacts].sort(),files.map((f)=>join(artifactsDir,f)).sort());
    assert.equal(terminal.artifacts.filter((a)=>a.kind==="error").length,3);
  });
});

test("retention sink failure does not break the retry path (PR #418 isolation precedent)", async()=>{
  await withTempHome(async(home)=>{
    const runDir=join(home,"runs","throw-sink-fails");
    await mkdir(join(runDir,"session"),{recursive:true});
    const sessionFile=join(runDir,"session","session.jsonl");
    // Malformed dossier JSONL makes the pointer append fail after the error file lands.
    await writeFile(sessionFile,"{not json\n","utf8");
    const callsRef={n:0};
    const {io,stderr}=captureIo();
    const result=await runWithAutoResumeLoop({
    principalAuthority: piDurablePrincipalAuthority,
      sessionAppender: appendPiSessionCustomEntry,
      admitted:{principal:fixturePrincipal(dirname(sessionFile),sessionFile),runDirectory:runDir,role:"fixer",runId:"throw-sink-fails"},
      io,
      autoResumeLimit:2,
      buildInitialPayload: ()=>["--initial"],
      buildResumePayload: ()=>["--resume"],
      dispatch:alwaysThrowingDispatch(callsRef,["boom-sink"]),
    });
    // Retries still ran to budget and ended in the loud typed failure terminal.
    assert.equal(callsRef.n,3);
    assert.equal(result.exitCode,1);
    assert.equal(result.terminal?.roleOutcome.kind,"failure");
    assert.equal(result.terminal?.autoResumeCount,2);
    assert.match(stderr.join(""),/dispatch error retention failed/);
  });
});
