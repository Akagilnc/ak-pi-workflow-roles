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
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import test from "node:test";

import { runWithAutoResumeLoop, DISPATCH_ERROR_RETENTION_ENTRY_TYPE } from "../../src/public-cli/auto-resume.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import { withPrimaryAwareCleanup, withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
import { readRunLogRows } from "../helpers/run-dossier-fixture.ts";
import { recordNonSealedSubmission, sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { GatekeeperDecisionError } from "../../src/submission-errors.ts";

async function withTempHome<T>(fn:(home:string)=>Promise<T>):Promise<T>{
  return withTempRoot("ak-dispatch-throw-", fn);
}

type LoopDispatchResult={exitCode:number;terminal?:TerminalResult};

function alwaysThrowingDispatch(callsRef:{n:number}, messages:readonly string[], leases?:boolean[]){
  // #987: initial retries keep the lease; host resumes receive none.
  return async(
    _extraArgs:readonly string[],
    lease:{release():Promise<void>}|undefined,
  ):Promise<LoopDispatchResult>=>
    withPrimaryAwareCleanup(
      async () => {
        callsRef.n+=1;
        leases?.push(lease !== undefined);
        throw new Error(messages[Math.min(callsRef.n-1,messages.length-1)]!);
      },
      async () => {
        if (lease !== undefined) await lease.release();
      },
    );
}

type PointerEntry={data?:{file?:unknown;attempt?:unknown};};

const sealedParams={status:"converged",report:"sealed-before-throw"};
const bounceParams={status:"converged",report:"bounce-before-throw"};

async function plantRecordedSubmissions(input:{
  readonly home:string;
  readonly project:string;
  readonly runDirectory:string;
  readonly runId:string;
  readonly role:"judge"|"fixer";
}):Promise<void>{
  await sealAcceptedSubmission({
    cwd:input.project,
    runId:input.runId,
    role:input.role,
    details:sealedParams,
    home:input.home,
    runDirectory:input.runDirectory,
    toolCallId:"call-sealed",
  });
  await recordNonSealedSubmission({
    cwd:input.project,
    runId:input.runId,
    role:input.role,
    details:bounceParams,
    home:input.home,
    runDirectory:input.runDirectory,
    toolCallId:"call-bounce",
    executeError:new GatekeeperDecisionError({
      status:"continue",
      officer:"inspector",
      receipt:{status:"continue",findings:["x"]},
    }),
  });
}

test("dispatch exceptions retry to budget with full per-attempt retention and typed failure", async()=>{
  await withTempHome(async(home)=>{
    const project=join(home,"proj");
    const runId="throw-loop-limit2b";
    const runDir=join(home,".ak-roles","books","proj","runs",`${runId}@judge`);
    await mkdir(project,{recursive:true});
    await mkdir(join(runDir,"session"),{recursive:true});
    const sessionFile=join(runDir,"session","session.jsonl");
    await writeFile(sessionFile,"{}\n","utf8");
    await plantRecordedSubmissions({home,project,runDirectory:runDir,runId,role:"judge"});
    const callsRef={n:0};
    const leases:boolean[]=[];
    const causes=["boom-attempt-1","boom-attempt-2","boom-final"];
    const {io}=captureIo();
    const result=await runWithAutoResumeLoop({
    principalAuthority: piDurablePrincipalAuthority,
      sessionAppender: appendPiSessionCustomEntry,
      admitted:{principal:fixturePrincipal(dirname(sessionFile),sessionFile),runDirectory:runDir,role:"judge",runId,projectRoot:project},
      io,
      autoResumeLimit:2,
      buildInitialPayload: ()=>["--initial"],
      buildResumePayload: ()=>["--resume"],
      dispatch:alwaysThrowingDispatch(callsRef,causes,leases),
    });
    const terminal=result.terminal as TerminalResult;

    // (a) budget reached: initial + limit resumes; count observation equals limit.
    assert.equal(callsRef.n,3);
    assert.deepEqual(leases,[true,true,true]);
    assert.equal(result.exitCode,1);
    assert.equal(terminal.roleOutcome.kind,"failure");
    assert.equal(terminal.autoResumeCount,2);

    // (b) one retained error row per attempt in the run's log.jsonl, appended in order — no overwrite.
    const logPath=join(runDir,"log.jsonl");
    const retained=readRunLogRows(runDir,"dispatch-exception")
      .map((row)=>row.payload as {version?:number;attempt?:number;recordedAt?:string;error?:string});
    assert.equal(retained.length,3);
    assert.deepEqual(retained.map((r)=>r.attempt),[0,1,2]);
    assert.ok(retained.every((r)=>r.version===1&&typeof r.recordedAt==="string"));
    for(const [i,cause] of causes.entries()) assert.ok(retained[i]!.error?.includes(cause));

    // (c) dossier pointers (one per attempt) address the log that holds those rows.
    const lines=(await readFile(sessionFile,"utf8")).trim().split("\n").filter(Boolean);
    const pointers=lines.map((l)=>JSON.parse(l) as PointerEntry)
      .filter((e)=>typeof e==="object"&&e!==null&&(e as {customType?:unknown}).customType===DISPATCH_ERROR_RETENTION_ENTRY_TYPE);
    assert.equal(pointers.length,3);
    assert.deepEqual(pointers.map((p)=>p.data?.attempt),[0,1,2]);
    for(const p of pointers){
      assert.equal(p.data?.file,logPath);
      await stat(p.data?.file as string); // pointer target exists
    }

    // (d) loud failure carries the LAST true error + log pointer; no fabricated class (#881).
    if(terminal.roleOutcome.kind!=="failure")throw new Error("unreachable");
    assert.equal(terminal.roleOutcome.cause, undefined);
    // The terminal must carry the actual final injected cause, not a prior attempt
    // or an empty diagnostic; no generated diagnostic template is frozen.
    assert.ok(terminal.roleOutcome.diagnostic.includes(causes.at(-1)!));
    const filesFromFacts=terminal.roleOutcome.decisiveFacts.dispatchErrorFiles as readonly string[];
    assert.deepEqual([...filesFromFacts],[logPath,logPath,logPath]);
    const lastFile=terminal.roleOutcome.decisiveFacts.lastDispatchErrorFile;
    assert.equal(lastFile,logPath);
    const lastRecord=retained.at(-1)!;
    assert.equal(lastRecord.attempt,callsRef.n-1);
    assert.ok(lastRecord.error?.includes(causes.at(-1)!));
    assert.equal(terminal.artifacts.filter((a)=>a.kind==="error").length,3);
    // #953: history stays on submissions; failure.payloads is not the history face.
    assert.equal(
      terminal.roleOutcome.payloads === undefined
        || terminal.roleOutcome.payloads.length === 0,
      true,
    );
    assert.deepEqual(terminal.submissions,[sealedParams,bounceParams]);
  });
});

test("#1091 auto-resume keeps retrying when the local session file is absent", async()=>{
  await withTempHome(async(home)=>{
    const project=join(home,"proj");
    const runId="throw-no-session-probe";
    const runDir=join(home,".ak-roles","books","proj","runs",`${runId}@judge`);
    await mkdir(project,{recursive:true});
    await mkdir(join(runDir,"session"),{recursive:true});
    // No session.jsonl — former availability probe would have stopped further resumes.
    const sessionFile=join(runDir,"session","session.jsonl");
    await plantRecordedSubmissions({home,project,runDirectory:runDir,runId,role:"judge"});
    const callsRef={n:0};
    const {io}=captureIo();
    const result=await runWithAutoResumeLoop({
      principalAuthority: piDurablePrincipalAuthority,
      sessionAppender: async()=>{},
      admitted:{principal:fixturePrincipal(dirname(sessionFile),sessionFile),runDirectory:runDir,role:"judge",runId,projectRoot:project},
      io,
      autoResumeLimit:2,
      buildInitialPayload: ()=>["--initial"],
      buildResumePayload: ()=>["--resume"],
      dispatch:alwaysThrowingDispatch(callsRef,["boom-1","boom-2","boom-3"]),
    });
    assert.equal(callsRef.n,3);
    assert.equal(result.exitCode,1);
    assert.equal((result.terminal as TerminalResult).autoResumeCount,2);
  });
});

test("Pi custom-entry append surfaces Sitian persistence failure after the session write", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    const runDir = join(home, ".ak-roles", "books", "proj", "runs", "custom-entry-sitian-failure@judge");
    const sessionDir = join(runDir, "session");
    const sessionFile = join(sessionDir, "session.jsonl");
    await mkdir(project, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionFile, "{}\n", "utf8");
    // Make the Sitian destination impossible while leaving the Pi session writable:
    // a directory where the run's log.jsonl belongs.
    await mkdir(join(runDir, "log.jsonl"));

    await assert.rejects(
      appendPiSessionCustomEntry(
        piDurablePrincipalAuthority,
        fixturePrincipal(dirname(sessionFile), sessionFile),
        "custom-entry-probe",
        { observed: true },
      ),
    );
    const entries = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(entries.at(-1)?.type, "custom");
    assert.equal(entries.at(-1)?.customType, "custom-entry-probe");
  });
});

test("retention sink failure does not break the retry path (PR #418 isolation precedent)", async()=>{
  await withTempHome(async(home)=>{
    const project=join(home,"proj");
    const runId="throw-sink-fails";
    const runDir=join(home,".ak-roles","books","proj","runs",`${runId}@fixer`);
    await mkdir(project,{recursive:true});
    await mkdir(join(runDir,"session"),{recursive:true});
    const sessionFile=join(runDir,"session","session.jsonl");
    // Malformed dossier JSONL makes the pointer append fail after the error file lands.
    await writeFile(sessionFile,"{not json\n","utf8");
    const callsRef={n:0};
    const {io}=captureIo();
    const result=await runWithAutoResumeLoop({
    principalAuthority: piDurablePrincipalAuthority,
      sessionAppender: appendPiSessionCustomEntry,
      admitted:{principal:fixturePrincipal(dirname(sessionFile),sessionFile),runDirectory:runDir,role:"fixer",runId,projectRoot:project},
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
    assert.equal(result.terminal?.artifacts.filter((artifact)=>artifact.kind==="error").length,3);
  });
});

test("a lawful final turn still returns preceding failed attempts", async () => {
  await withTempHome(async (home) => {
    const runDirectory = join(home, "runs", "failure-then-accepted");
    await mkdir(runDirectory, { recursive: true });
    let attempts = 0;
    const result = await runWithAutoResumeLoop({
      principalAuthority: piDurablePrincipalAuthority,
      sessionAppender: appendPiSessionCustomEntry,
      admitted: {
        principal: fixturePrincipal(join(runDirectory, "session"), join(runDirectory, "session", "session.jsonl")),
        runDirectory, role: "judge", runId: "failure-then-accepted", projectRoot: home,
      },
      io: captureIo().io,
      autoResumeLimit: 2,
      buildInitialPayload: () => "initial",
      buildResumePayload: () => "resume",
      dispatch: async () => {
        attempts++;
        return {
          exitCode: attempts === 1 ? 1 : 0,
          turnDispatched: true as const,
          terminal: {
            roleOutcome: attempts === 1
              ? { kind: "failure" as const, role: "judge" as const,
                diagnostic: "first-failure", decisiveFacts: { errorCode: "first" } }
              : { kind: "accepted" as const, role: "judge" as const },
            navigator: { disposition: "no-advice" as const },
            artifacts: [], runId: "failure-then-accepted",
          },
        };
      },
    });
    assert.equal(attempts, 2);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    const history = (result.terminal?.roleOutcome.decisiveFacts as Record<string, unknown> | undefined)?.failedAttempts as
      Array<{ attempt: number; decisiveFacts: { errorCode: string } }>;
    assert.deepEqual(history.map(({ attempt, decisiveFacts }) => [attempt, decisiveFacts.errorCode]),
      [[0, "first"]]);
  });
});

test("three failed turns retain every cause when the final result stops dispatch", async () => {
  await withTempHome(async (home) => {
    const runDirectory = join(home, "runs", "stop-after-three");
    await mkdir(runDirectory, { recursive: true });
    let attempts = 0;
    const result = await runWithAutoResumeLoop({
      principalAuthority: piDurablePrincipalAuthority,
      sessionAppender: appendPiSessionCustomEntry,
      admitted: {
        principal: fixturePrincipal(join(runDirectory, "session"), join(runDirectory, "session", "session.jsonl")),
        runDirectory, role: "judge", runId: "stop-after-three", projectRoot: home,
      },
      io: captureIo().io,
      autoResumeLimit: 2,
      buildInitialPayload: () => "initial",
      buildResumePayload: () => "resume",
      dispatch: async () => {
        attempts++;
        return {
          exitCode: 1,
          turnDispatched: true as const,
          ...(attempts === 3 ? { skipAutoResume: true as const } : {}),
          terminal: {
            roleOutcome: { kind: "failure" as const, role: "judge" as const,
              diagnostic: `failure-${attempts}`, decisiveFacts: { errorCode: `err-${attempts}` } },
            navigator: { disposition: "no-advice" as const },
            artifacts: [], runId: "stop-after-three",
          },
        };
      },
    });
    assert.equal(attempts, 3);
    assert.equal(result.terminal?.roleOutcome.kind, "failure");
    if (result.terminal?.roleOutcome.kind === "failure") {
      const history = (result.terminal.roleOutcome.decisiveFacts as Record<string, unknown>).failedAttempts as
        Array<{ attempt: number; decisiveFacts: { errorCode: string } }>;
      assert.deepEqual(history.map(({ attempt, decisiveFacts }) => [attempt, decisiveFacts.errorCode]),
        [[0, "err-1"], [1, "err-2"], [2, "err-3"]]);
    }
  });
});
