import { testTmpdir } from "../helpers/worktree-temp.ts";
/**
 * #416 (scope correction 2026-08-22):撤前两闸 + 单次调用原地自动续跑 ≤2 次
 * Seams: loadResumableRunRecord / runAkRole(judge|resume) / Terminal autoResumeCount
 * F1: lawful 三态 (accepted/audit_escalation/no_receipt) 均不触发
 */
import assert from "node:assert/strict";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { loadResumableJudgeRun, readRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import { isLawfulTypedTerminalOutcome } from "../../src/public-cli/terminal.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";

async function withTempHome<T>(fn:(home:string)=>Promise<T>):Promise<T>{
  const home=await mkdtemp(join(testTmpdir(),"ak-416-"));
  return await fn(home)
}
function captureIo(){const stdout:string[]=[];const stderr:string[]=[];return{stdout,stderr,io:{stdout:(t:string)=>stdout.push(t),stderr:(t:string)=>stderr.push(t)}};}
function seedGitProject(root:string){execFileSync("git",["init","-b","main"],{cwd:root});execFileSync("git",["config","user.email","416@test.local"],{cwd:root});execFileSync("git",["config","user.name","416"],{cwd:root});execFileSync("git",["commit","--allow-empty","-m","seed"],{cwd:root});}
/** Accepted judge details + sealedAcceptance for faux runners (S4 ledger-only settlement). */
function acceptedJudge(details: Record<string, unknown> = { judgeStatus: "converged" }) {
  return {
    write: (sessionFile: string) => writeFile(sessionFile, JSON.stringify({ type: "message", message: { role: "toolResult", toolName: JUDGE_OUTPUT_TOOL_NAME, isError: false, details } }) + "\n", "utf8"),
    sealedAcceptance: { role: "judge" as const, details },
  };
}

test("block1: terminal without accepted is now resumable", async()=>{
  await withTempHome(async(home)=>{
    const project=join(home,"proj");await mkdir(project,{recursive:true});seedGitProject(project);
    const runId="416-terminal-ok-001";
    const {io}=captureIo();
    const first=await runAkRole(["judge","--project",project,"fail"],{packageRoot,home,cwd:project,credentials:{"openai-codex":true,xai:true},createRunId:()=>runId,io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async(args)=>{const sd=args[args.indexOf("--session-dir")+1]!;await mkdir(sd,{recursive:true});
        await writeFile(join(sd,"session.jsonl"),JSON.stringify({type:"message",message:{role:"user",content:[{type:"text",text:"go"}]}})+"\n","utf8");
        return{code:1,stderr:"boom\n",timedOut:false,args:[...args]};},
      })});
    assert.equal(first.exitCode,1);
    const loaded=await loadResumableJudgeRun(home, runId, piDurablePrincipalAuthority);
    assert.equal(loaded.run.runId,runId);
    let dispatched=false;let seenEnvelope=false;let seenSessionFile="";
    const {io:io2}=captureIo();
    const resumed=await runAkRole(["resume",runId],{packageRoot,home,cwd:project,credentials:{"openai-codex":true,xai:true},io:io2,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async(args)=>{dispatched=true; seenSessionFile=args[args.indexOf("--session")+1]!; seenEnvelope=args.includes("[ak-role:resume-continue]"); const acc=acceptedJudge(); await acc.write(seenSessionFile);return{code:0,stderr:"",timedOut:false,args:[...args],sealedAcceptance:acc.sealedAcceptance};},
      })});
    assert.equal(dispatched,true);
    assert.equal(seenEnvelope,true);
    assert.ok(seenSessionFile.endsWith("/session/session.jsonl"));
    assert.equal(resumed.exitCode,0);
    assert.equal(resumed.terminal?.autoResumeCount,0);
  });
});

test("S5: terminal with accepted receipt stays loadable; sealed resume projects without dispatch", async()=>{
  await withTempHome(async(home)=>{
    const project=join(home,"proj");await mkdir(project,{recursive:true});seedGitProject(project);
    const runId="416-accepted-resumable-001";
    const {io}=captureIo();
    const first=await runAkRole(["judge","--project",project,"accepted"],{packageRoot,home,cwd:project,credentials:{"openai-codex":true,xai:true},createRunId:()=>runId,io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async(args)=>{const sd=args[args.indexOf("--session-dir")+1]!;await mkdir(sd,{recursive:true});
        const sf=args[args.indexOf("--session")+1]!;const acc=acceptedJudge({judgeStatus:"converged",note:"FIRST-ok"});await acc.write(sf);return{code:0,stderr:"",timedOut:false,args:[...args],sealedAcceptance:acc.sealedAcceptance};},
      })});
    assert.equal(first.exitCode,0);
    assert.equal(first.terminal?.roleOutcome.kind,"accepted");
    // #416: load stays open (no terminal/resumable gate). #599: sealed ledger is
    // projected idempotently — do not dispatch a doomed turn that post-seal-anomalies.
    const loaded=await loadResumableJudgeRun(home, runId, piDurablePrincipalAuthority);
    assert.equal(loaded.run.runId,runId);
    let calls=0;
    const {io:io2}=captureIo();
    const resumed=await runAkRole(["resume",runId],{packageRoot,home,cwd:project,credentials:{"openai-codex":true,xai:true},io:io2,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async(args)=>{calls+=1;const sf=args[args.indexOf("--session")+1]!;const acc=acceptedJudge({judgeStatus:"converged",note:"resumed ok"});await acc.write(sf);return{code:0,stderr:"",timedOut:false,args:[...args],sealedAcceptance:acc.sealedAcceptance};},
      })});
    assert.equal(calls,0,"sealed resume must not dispatch");
    assert.equal(resumed.exitCode,0);
    assert.equal(resumed.terminal?.roleOutcome.kind,"accepted");
    assert.equal(
      resumed.terminal?.roleOutcome.kind==="accepted"
        ?(resumed.terminal.roleOutcome.decisiveFacts as {note?:string}).note
        :undefined,
      "FIRST-ok",
    );
    assert.equal(resumed.terminal?.autoResumeCount,0);
  });
});

test("S5: resumable (typed 429) state also resumable", async()=>{
  await withTempHome(async(home)=>{
    const project=join(home,"proj");await mkdir(project,{recursive:true});seedGitProject(project);
    const runId="416-resumable-state-001";
    const {io}=captureIo();
    const first=await runAkRole(["judge","--project",project,"429"],{packageRoot,home,cwd:project,credentials:{"openai-codex":true,xai:true},createRunId:()=>runId,io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async(args)=>{const sd=args[args.indexOf("--session-dir")+1]!;await mkdir(sd,{recursive:true});
        await observeTyped429ViaProductionHandler({runDirectory: join(sd,".."), provider:"openai-codex"});
        await writeFile(join(sd,"session.jsonl"),JSON.stringify({type:"message",message:{role:"assistant",stopReason:"error",errorMessage:"upstream declined",provider:"openai-codex",model:"probe",api:"openai-responses"}})+"\n","utf8");
        return{code:1,stderr:"fail\n",timedOut:false,args:[...args],knownFailure:{cause:"provider",identity:{name:"ProviderError",code:429},diagnostic:"HTTP 429"}};},
      })});
    // After per-call auto retries, final terminal will have autoResumeCount 2 but still be loadable
    assert.equal(first.exitCode,1);
    const loaded=await loadResumableJudgeRun(home, runId, piDurablePrincipalAuthority);
    assert.equal(loaded.run.runId,runId);
    let calls=0;
    const {io:io2}=captureIo();
    const resumed=await runAkRole(["resume",runId],{packageRoot,home,cwd:project,credentials:{"openai-codex":true,xai:true},io:io2,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async(args)=>{calls+=1;const sf=args[args.indexOf("--session")+1]!;const acc=acceptedJudge();await acc.write(sf);return{code:0,stderr:"",timedOut:false,args:[...args],sealedAcceptance:acc.sealedAcceptance};},
      })});
    assert.equal(calls,1);
    assert.equal(resumed.exitCode,0);
  });
});

test("block1: unknown runId still rejects", async()=>{
  await withTempHome(async(home)=>{
    const project=join(home,"proj");await mkdir(project,{recursive:true});seedGitProject(project);
    await assert.rejects(()=>loadResumableJudgeRun(home, "missing-416", piDurablePrincipalAuthority),/unknown role run id/);
    const {io}=captureIo();let dispatched=false;
    const res=await runAkRole(["resume","missing-416"],{packageRoot,home,cwd:project,io,roleTurnHost: roleTurnHostFromLegacyPiRunner({
                                                                                          packageRoot,
                                                                                          principalAuthority: piDurablePrincipalAuthority,
                                                                                          piRunner: async(a)=>{dispatched=true;return{code:0,stderr:"",timedOut:false,args:[...a]};},
                                                                                        })});
    assert.equal(res.exitCode,2);assert.equal(dispatched,false);
  });
});

test("block1: session principal unavailable still fails honestly", async()=>{
  await withTempHome(async(home)=>{
    const project=join(home,"proj");await mkdir(project,{recursive:true});seedGitProject(project);
    const runId="416-no-principal-001";
    const {io}=captureIo();
    await runAkRole(["judge","--project",project,"fail"],{packageRoot,home,cwd:project,credentials:{"openai-codex":true,xai:true},createRunId:()=>runId,io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async(args)=>{const sd=args[args.indexOf("--session-dir")+1]!;await mkdir(sd,{recursive:true});return{code:1,stderr:"x\n",timedOut:false,args:[...args]};},
      })});
    const bookKey=resolveBookKeyFromGit(project);
    const runDir=join(home,".ak-roles","books",bookKey,"runs",`${runId}@judge`);
    await rm(join(runDir,"session","session.jsonl"),{force:true});
    await assert.rejects(()=>loadResumableJudgeRun(home, runId, piDurablePrincipalAuthority),/Pi session principal is unavailable/);
    const {io:io2,stderr}=captureIo();let dispatched=false;
    const res=await runAkRole(["resume",runId],{packageRoot,home,cwd:project,io:io2,roleTurnHost: roleTurnHostFromLegacyPiRunner({
                                                                                      packageRoot,
                                                                                      principalAuthority: piDurablePrincipalAuthority,
                                                                                      piRunner: async(a)=>{dispatched=true;return{code:0,stderr:"",timedOut:false,args:[...a]};},
                                                                                    })});
    assert.equal(dispatched,false);assert.ok(stderr.join("").includes("Pi session principal is unavailable"));assert.notEqual(res.exitCode,0);
  });
});

test("block2: auto retry up to 2 per single call, observation on terminal", async()=>{
  await withTempHome(async(home)=>{
    const project=join(home,"proj");await mkdir(project,{recursive:true});seedGitProject(project);
    const runId="416-auto-limit-001";let calls=0;
    const {io}=captureIo();
    const result=await runAkRole(["judge","--project",project,"auto"],{packageRoot,home,cwd:project,credentials:{"openai-codex":true,xai:true},createRunId:()=>runId,io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async(args)=>{calls+=1;const sd=args[args.indexOf("--session-dir")+1]!;await mkdir(sd,{recursive:true});
        const sf=args[args.indexOf("--session")+1]!;await writeFile(sf,JSON.stringify({type:"message",message:{role:"user",content:[{type:"text",text:"go"}]}})+"\n","utf8");
        return{code:1,stderr:`fail ${calls}\n`,timedOut:false,args:[...args]};},
      })});
    assert.equal(calls,3);
    assert.equal(result.exitCode,1);
    assert.equal(result.terminal?.autoResumeCount,2);
    const state=await readRoleRunState(join(home,".ak-roles","books",resolveBookKeyFromGit(project),"runs",`${runId}@judge`), piDurablePrincipalAuthority);
    assert.equal(state?.state,"terminal");
    // Only final terminal presented once
    assert.equal(calls,3);
  });
});

test("block2: second attempt success needs only 1 auto", async()=>{
  await withTempHome(async(home)=>{
    const project=join(home,"proj");await mkdir(project,{recursive:true});seedGitProject(project);
    const runId="416-auto-success-001";let calls=0;
    const {io}=captureIo();
    const result=await runAkRole(["judge","--project",project,"auto"],{packageRoot,home,cwd:project,credentials:{"openai-codex":true,xai:true},createRunId:()=>runId,io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async(args)=>{calls+=1;const sd=args[args.indexOf("--session-dir")+1]!;await mkdir(sd,{recursive:true});
        const sf=args[args.indexOf("--session")+1]!;
        if(calls===2){const acc=acceptedJudge();await acc.write(sf);return{code:0,stderr:"",timedOut:false,args:[...args],sealedAcceptance:acc.sealedAcceptance};}
        await writeFile(sf,JSON.stringify({type:"message",message:{role:"user",content:[{type:"text",text:"go"}]}})+"\n","utf8");return{code:1,stderr:"fail\n",timedOut:false,args:[...args]};},
      })});
    assert.equal(calls,2);assert.equal(result.exitCode,0);assert.equal(result.terminal?.autoResumeCount,1);
  });
});

test("F1: audit_escalation lawful does not trigger auto", async()=>{
  assert.equal(isLawfulTypedTerminalOutcome({kind:"audit_escalation",role:"judge",status:"audit_escalation",decisiveFacts:{}}),true);
  await withTempHome(async(home)=>{
    const { runWithAutoResumeLoop } = await import("../../src/public-cli/auto-resume.ts");
    const runDir=join(home,"runs","416-audit-escal-loop");await mkdir(join(runDir,"session"),{recursive:true});
    const sessionFile=join(runDir,"session","session.jsonl");await writeFile(sessionFile,"{}\n","utf8");
    let calls=0;const {io,stdout}=captureIo();
    const result=await runWithAutoResumeLoop({
    principalAuthority: piDurablePrincipalAuthority,
    sessionAppender: appendPiSessionCustomEntry,
      admitted:{principal:fixturePrincipal(dirname(sessionFile),sessionFile),runDirectory:runDir,role:"judge",runId:runDir},
      io,
      autoResumeLimit:0,
      buildInitialPayload: ()=>["--initial"],
      buildResumePayload: ()=>["--resume"],
      dispatch: async()=>{calls+=1;return{exitCode:0,terminal:{roleOutcome:{kind:"audit_escalation",role:"judge",status:"audit_escalation",decisiveFacts:{}},navigator:{disposition:"no-advice"},artifacts:[],runId:"416-audit-escal-loop"} as unknown as import("../../src/public-cli/terminal.ts").TerminalResult};},
    });
    assert.equal(calls,1);assert.equal(result.terminal?.autoResumeCount,0);assert.equal(stdout.length,1);
  });
});

test("F1: no_receipt lawful does not trigger auto", async()=>{
  assert.equal(isLawfulTypedTerminalOutcome({kind:"no_receipt",role:"judge",status:"no-accepted-receipt",decisiveFacts:{acceptedReceipt:false}} as unknown as Parameters<typeof isLawfulTypedTerminalOutcome>[0]),true);
  await withTempHome(async(home)=>{
    const { runWithAutoResumeLoop } = await import("../../src/public-cli/auto-resume.ts");
    const runDir=join(home,"runs","416-no-receipt-loop");await mkdir(join(runDir,"session"),{recursive:true});
    const sessionFile=join(runDir,"session","session.jsonl");await writeFile(sessionFile,"{}\n","utf8");
    let calls=0;const {io,stdout}=captureIo();
    const noReceiptFacts={acceptedReceipt:false, rejectedReceipts:[], deliveryTurns:0, sessionCompletion:"completed" as const};
    const result=await runWithAutoResumeLoop({
    principalAuthority: piDurablePrincipalAuthority,
    sessionAppender: appendPiSessionCustomEntry,
      admitted:{principal:fixturePrincipal(dirname(sessionFile),sessionFile),runDirectory:runDir,role:"judge",runId:runDir},
      io,
      autoResumeLimit:0,
      buildInitialPayload: ()=>["--initial"],
      buildResumePayload: ()=>["--resume"],
      dispatch: async()=>{calls+=1;return{exitCode:0,terminal:{roleOutcome:{kind:"no_receipt",role:"judge",status:"no-accepted-receipt",decisiveFacts:noReceiptFacts,...noReceiptFacts},navigator:{disposition:"no-advice"},artifacts:[],runId:"416-no-receipt-loop"} as unknown as import("../../src/public-cli/terminal.ts").TerminalResult};},
    });
    assert.equal(calls,1);assert.equal(result.terminal?.autoResumeCount,0);assert.equal(stdout.length,1);
  });
});

test("block2: lawful (accepted) does not trigger auto - single presentation", async()=>{
  await withTempHome(async(home)=>{
    const project=join(home,"proj");await mkdir(project,{recursive:true});seedGitProject(project);
    const runId="416-lawful-no-auto-002";let calls=0;
    const {io,stdout}=captureIo();
    const result=await runAkRole(["judge","--project",project,"lawful"],{packageRoot,home,cwd:project,credentials:{"openai-codex":true,xai:true},createRunId:()=>runId,io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async(args)=>{calls+=1;const sd=args[args.indexOf("--session-dir")+1]!;await mkdir(sd,{recursive:true});
        const sf=args[args.indexOf("--session")+1]!;const acc=acceptedJudge();await acc.write(sf);return{code:0,stderr:"",timedOut:false,args:[...args],sealedAcceptance:acc.sealedAcceptance};},
      })});
    assert.equal(calls,1);assert.equal(result.exitCode,0);assert.equal(stdout.length,1);assert.equal(result.terminal?.autoResumeCount,0);
  });
});

test("block2: count is call-local, manual resume exact once", async()=>{
  await withTempHome(async(home)=>{
    const project=join(home,"proj");await mkdir(project,{recursive:true});seedGitProject(project);
    const runId="416-call-local-manual-001";let calls=0;
    const {io}=captureIo();
    const first=await runAkRole(["judge","--project",project,"fail"],{packageRoot,home,cwd:project,credentials:{"openai-codex":true,xai:true},createRunId:()=>runId,io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async(args)=>{calls+=1;const sd=args[args.indexOf("--session-dir")+1]!;await mkdir(sd,{recursive:true});
        const sf=args[args.indexOf("--session")+1]!;await writeFile(sf,JSON.stringify({type:"message",message:{role:"user",content:[{type:"text",text:"go"}]}})+"\n","utf8");return{code:1,stderr:"fail\n",timedOut:false,args:[...args]};},
      })});
    assert.equal(calls,3);assert.equal(first.terminal?.autoResumeCount,2);
    let manualCalls=0;let resumeArgs:string[]|undefined;
    const {io:io2,stdout:manualStdout}=captureIo();
    const manual=await runAkRole(["resume",runId],{packageRoot,home,cwd:project,credentials:{"openai-codex":true,xai:true},io:io2,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async(args)=>{manualCalls+=1;resumeArgs=[...args];const sf=args[args.indexOf("--session")+1]!;const acc=acceptedJudge();await acc.write(sf);return{code:0,stderr:"",timedOut:false,args:[...args],sealedAcceptance:acc.sealedAcceptance};},
      })});
    assert.equal(manualCalls,1);
    assert.ok(resumeArgs!.includes("[ak-role:resume-continue]"));
    assert.equal(manualStdout.length,1);
    assert.equal(manual.exitCode,0);
    assert.equal(manual.terminal?.autoResumeCount,0);
  });
});
