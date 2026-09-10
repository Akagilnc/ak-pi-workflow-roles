import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
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
import { DIARIST_OUTPUT_TOOL_NAME } from "../../src/diarist-contracts.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import {
  lookupHeadlessHostDescription,
  lookupHostDescription,
} from "../../src/host-descriptions.ts";
import { createSessionIdentityAuthority } from "../../src/session-identity.ts";
import { summonPublicRole } from "../../src/public-role-summons.ts";
import {
  createMinimalHost,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  TRUE_UNBOUND_DIARIST_DETAILS,
} from "../helpers/role-turn-host-fixture.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { runAkRole, type NamedRoleTurnHostAdapter } from "../../src/public-cli/cli.ts";
import { buildDiaristTurnRequest } from "../../src/public-cli/diarist-run.ts";
import {
  prepareSummonsResumeMaterials,
  resumeTurnRequestProjectionOptions,
  runPostAdmissionSeatResume,
} from "../../src/public-cli/post-admission.ts";
import {
  loadResumableDiaristRun,
  loadResumableJudgeRun,
  readRoleRunState,
  RESUME_TRANSPORT_ENVELOPE,
} from "../../src/public-cli/run-lifecycle.ts";
import { isLawfulTypedTerminalOutcome } from "../../src/public-cli/terminal.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

async function withTempHome<T>(fn:(home:string)=>Promise<T>):Promise<T>{
  return withTempRoot("ak-416-", fn);
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

test("S5: terminal with accepted receipt stays loadable; bare sealed resume reaches host (#416/#833)", async()=>{
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
    // #416: load stays open (no terminal/resumable gate). #833: sealed bare resume
    // is pass-through — host is reached; no re-seal so prior acceptance still settles.
    const loaded=await loadResumableJudgeRun(home, runId, piDurablePrincipalAuthority);
    assert.equal(loaded.run.runId,runId);
    let calls=0;
    const {io:io2}=captureIo();
    const resumed=await runAkRole(["resume",runId],{packageRoot,home,cwd:project,credentials:{"openai-codex":true,xai:true},io:io2,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async(args)=>{calls+=1;return{code:0,stderr:"",timedOut:false,args:[...args]};},
      })});
    assert.equal(calls,1,"sealed bare resume must reach the host");
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

test("A2: non-judge public seat enters the shared auto-resume loop", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "416-auto-diarist-001";
    let calls = 0;
    const { io } = captureIo();
    const result = await runAkRole(["diarist", "--project", project, "auto-retry-test"], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      createRunId: () => runId,
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
          calls += 1;
          const sd = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sd, { recursive: true });
          const sf = args[args.indexOf("--session") + 1]!;
          await writeFile(
            sf,
            JSON.stringify({
              type: "message",
              message: { role: "user", content: [{ type: "text", text: "go" }] },
            }) + "\n",
            "utf8",
          );
          return { code: 1, stderr: `fail ${calls}\n`, timedOut: false, args: [...args] };
        },
      }),
    });
    assert.equal(calls, 3, "non-judge seat retries non-lawful run up to shared budget");
    assert.equal(result.exitCode, 1);
    assert.equal(result.terminal?.autoResumeCount, 2);
  });
});

test("A2: station-child same-ticket resume enters the shared auto-resume loop", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    let calls = 0;
    const host = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        calls += 1;
        if (calls === 1) {
          return scriptedTerminatingToolSession({
            role: "diarist",
            toolName: DIARIST_OUTPUT_TOOL_NAME,
            details: { status: "completed", ticketNumber: 582, entries: [] },
          })(args, options);
        }
        const sd = args[args.indexOf("--session-dir") + 1]!;
        await mkdir(sd, { recursive: true });
        const sf = args[args.indexOf("--session") + 1]!;
        await writeFile(
          sf,
          JSON.stringify({
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "go" }] },
          }) + "\n",
          "utf8",
        );
        return { code: 1, stderr: `fail ${calls}\n`, timedOut: false, args: [...args] };
      },
    });
    const first = await summonPublicRole({
      role: "diarist",
      argv: ["--project", project, "整理 #582"],
      cwd: project,
      home,
      packageRoot,
      boundTicketNumber: 582,
      roleTurnHost: host,
      createRunId: () => "416-station-child-001",
      credentials: { "openai-codex": true, xai: true },
    });
    assert.equal(first.exitCode, 0, "first station-child mint must bind the ticket");
    const resumed = await summonPublicRole({
      role: "diarist",
      argv: ["--project", project, "refresh #582"],
      cwd: project,
      home,
      packageRoot,
      boundTicketNumber: 582,
      roleTurnHost: host,
      credentials: { "openai-codex": true, xai: true },
    });
    assert.equal(calls, 4, "same-ticket station-child resume retries up to shared budget");
    assert.equal(resumed.exitCode, 1);
    assert.equal(resumed.terminal?.autoResumeCount, 2);

    const again = await summonPublicRole({
      role: "diarist",
      argv: ["--project", project, "refresh again #582"],
      cwd: project,
      home,
      packageRoot,
      boundTicketNumber: 582,
      roleTurnHost: host,
      credentials: { "openai-codex": true, xai: true },
    });
    assert.equal(
      calls,
      7,
      "prior autoResumeCount observation must not shrink the next call-local budget",
    );
    assert.equal(again.exitCode, 1);
    assert.equal(again.terminal?.autoResumeCount, 2);
  });
});

test("A2: station-child after-lease build failure releases the lock and retries the initial turn", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const first = await summonPublicRole({
      role: "diarist",
      argv: ["--project", project, "整理 #582"],
      cwd: project,
      home,
      packageRoot,
      boundTicketNumber: 582,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: scriptedTerminatingToolSession({
          role: "diarist",
          toolName: DIARIST_OUTPUT_TOOL_NAME,
          details: { status: "completed", ticketNumber: 582, entries: [] },
        }),
      }),
      createRunId: () => "416-station-child-lease-001",
      credentials: { "openai-codex": true, xai: true },
    });
    assert.equal(first.exitCode, 0);
    let turns = 0;
    const env = {
      home,
      agentDir: join(home, ".pi"),
      packageRoot,
      cwd: project,
      principalAuthority: piDurablePrincipalAuthority,
      sessionAppender: appendPiSessionCustomEntry,
      stationChild: true as const,
      roleTurnHost: createMinimalHost(async (request: RoleTurnRequest) => {
        turns += 1;
        const { sessionDirectory, sessionFile } = piDurablePrincipalAuthority.decode(
          request.principal,
        );
        await mkdir(sessionDirectory, { recursive: true });
        await writeFile(
          sessionFile,
          JSON.stringify({
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "go" }] },
          }) + "\n",
          "utf8",
        );
        return { code: 1, stderr: `fail ${turns}\n`, timedOut: false };
      }),
    };
    let builds = 0;
    let preTurnFails = 0;
    const { io } = captureIo();
    const result = await runPostAdmissionSeatResume({
      request: {
        runId: "416-station-child-lease-001",
        summons: { instruction: "refresh after lease #582" },
      },
      env,
      io,
      load: (effective) =>
        loadResumableDiaristRun(home, effective.runId, piDurablePrincipalAuthority),
      buildTurnRequest: async (admitted, effective) => {
        builds += 1;
        if (builds === 1) throw new Error("after-lease boom");
        const summonsPrepared = await prepareSummonsResumeMaterials(
          admitted.runDirectory,
          effective.summons,
        );
        return buildDiaristTurnRequest(
          admitted,
          resumeTurnRequestProjectionOptions(admitted, effective, env, summonsPrepared),
        );
      },
      adapters: {
        trySettle: async () => undefined,
        shouldPresentSettled: () => true,
        beforeDispatch: async () => {
          preTurnFails += 1;
          if (preTurnFails === 1) throw new Error("pre-turn boom");
        },
      },
    });
    assert.equal(builds, 3, "after-lease throw must release the lock; pre-turn fail must retry the initial builder");
    assert.equal(turns, 1);
    assert.notEqual(result.exitCode, 2);
    assert.equal(result.terminal?.autoResumeCount, 2);
  });
});

test("#840 r8 判词 class 2: station-child same-call retry projects the plain resume trigger, not the manual-resume engine handbook", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    // Unbound (no boundTicketNumber; sealed details keep ticketNumber null):
    // this run never carries a ticketNumber, so post-admission's per-turn
    // case-dossier projection (ADR 0081) stays undefined and never appends
    // anything to continuation.prompt — the retry's prompt is then exactly
    // what this seam's own build() returns, no unrelated presentation text
    // to separate out first.
    const first = await summonPublicRole({
      role: "diarist",
      argv: ["--project", project, "record this session"],
      cwd: project,
      home,
      packageRoot,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: scriptedTerminatingToolSession({
          role: "diarist",
          toolName: DIARIST_OUTPUT_TOOL_NAME,
          details: TRUE_UNBOUND_DIARIST_DETAILS,
        }),
      }),
      createRunId: () => "840-station-prompt-preserve-001",
      credentials: { "openai-codex": true, xai: true },
    });
    assert.equal(first.exitCode, 0);

    const seenPrompts: string[] = [];
    let turns = 0;
    const env = {
      home,
      agentDir: join(home, ".pi"),
      packageRoot,
      cwd: project,
      principalAuthority: piDurablePrincipalAuthority,
      sessionAppender: appendPiSessionCustomEntry,
      stationChild: true as const,
      // Engine axis configured: a same-call retry that wrongly falls back to
      // the manual-resume handbook then structurally differs (an extra
      // engine-material section), which the equality assertion below can
      // observe; without an engine configured that fallback would coincide
      // with the trigger constant and hide the regression.
      engine: "cursor",
      roleTurnHost: createMinimalHost(async (request: RoleTurnRequest) => {
        turns += 1;
        seenPrompts.push(request.continuation.prompt);
        const { sessionDirectory, sessionFile } = piDurablePrincipalAuthority.decode(
          request.principal,
        );
        await mkdir(sessionDirectory, { recursive: true });
        await writeFile(
          sessionFile,
          JSON.stringify({
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "go" }] },
          }) + "\n",
          "utf8",
        );
        // Every attempt fails non-lawfully so the shared loop's call-local
        // retry actually redispatches (#416) — the retry payload under test.
        return { code: 1, stderr: `fail ${turns}\n`, timedOut: false };
      }),
    };
    const { io } = captureIo();
    const result = await runPostAdmissionSeatResume({
      request: {
        runId: "840-station-prompt-preserve-001",
        summons: { instruction: "re-check the current findings" },
      },
      env,
      io,
      load: (effective) =>
        loadResumableDiaristRun(home, effective.runId, piDurablePrincipalAuthority),
      buildTurnRequest: async (admitted, effective) => {
        const summonsPrepared = await prepareSummonsResumeMaterials(
          admitted.runDirectory,
          effective.summons,
        );
        return buildDiaristTurnRequest(
          admitted,
          resumeTurnRequestProjectionOptions(admitted, effective, env, summonsPrepared),
        );
      },
      adapters: {
        trySettle: async () => undefined,
        shouldPresentSettled: () => true,
      },
    });
    assert.ok(turns >= 2, "the loop must have redispatched at least once");
    // Structural, not textual: attempt 1 carries this court's real (non-trigger)
    // continuation; every call-local retry must be identical to the named,
    // package-owned trigger constant — no wording/template inspection, just
    // equality/inequality against a typed production export.
    assert.notEqual(
      seenPrompts[0],
      RESUME_TRANSPORT_ENVELOPE,
      "attempt 1 must carry this court's own continuation, not the bare trigger",
    );
    for (const prompt of seenPrompts.slice(1)) {
      assert.equal(
        prompt,
        RESUME_TRANSPORT_ENVELOPE,
        "same-call retry must project only the minimal host resume trigger",
      );
    }
    assert.equal(result.terminal?.autoResumeCount, seenPrompts.length - 1);
  });
});

test("A2: pi/acp/headless stand-ins share the same auto-resume middle layer", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    for (const hostName of ["pi", "grok-build", "claude"] as const) {
      const calls = { n: 0 };
      // Each stand-in host persists its OWN real resumable-session binding
      // shape (#840 r8 判词 class 3) — never a shared fake. pi's binding is
      // the transcript session.jsonl (DurablePrincipalAuthority#isAvailable);
      // ACP/headless hosts persist a native session id under their own
      // session-identity binding file (host-descriptions.ts) instead and
      // never touch session.jsonl. Writing the same file for every host would
      // mask exactly the native-binding gap this suite guards against.
      const failingHost = createMinimalHost(async (request: RoleTurnRequest) => {
        calls.n += 1;
        if (hostName === "pi") {
          const { sessionDirectory, sessionFile } = piDurablePrincipalAuthority.decode(
            request.principal,
          );
          await mkdir(sessionDirectory, { recursive: true });
          await writeFile(
            sessionFile,
            JSON.stringify({
              type: "message",
              message: { role: "user", content: [{ type: "text", text: "go" }] },
            }) + "\n",
            "utf8",
          );
        } else {
          const description =
            lookupHostDescription(hostName) ?? lookupHeadlessHostDescription(hostName);
          assert.ok(description, `host description registered for ${hostName}`);
          await createSessionIdentityAuthority(
            piDurablePrincipalAuthority,
            description!.sessionBindingFile,
          ).bind(request.principal, `native-session-${hostName}-${calls.n}`);
        }
        return { code: 1, stderr: `fail ${calls.n}\n`, timedOut: false };
      });
      const hostAdapters: NamedRoleTurnHostAdapter[] = (
        ["pi", "grok-build", "claude"] as const
      ).map((name) => ({
        name,
        create: () => ({ ok: true as const, host: failingHost }),
      }));
      const { io } = captureIo();
      const result = await runAkRole(
        ["diarist", "--host", hostName, "--project", project, "auto-retry-test"],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => `416-auto-host-${hostName}`,
          io,
          hostAdapters,
        },
      );
      assert.equal(calls.n, 3, `${hostName} must retry through the shared auto-resume loop`);
      assert.equal(result.exitCode, 1, hostName);
      assert.equal(result.terminal?.autoResumeCount, 2, hostName);
    }
  });
});
