import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
/**
 * #422: single-call auto-resume ceiling becomes configurable via
 * public-cli.json top-level key `autoResumeLimit` (sibling of `seats`).
 * Value domain: non-negative integer, no package-local upper bound (ADR 0035).
 * 0 = auto-resume disabled (one dispatch per call). Default stays 2.
 * Seams: loadPublicCliConfig/savePublicCliConfig/setAutoResumeLimit /
 * runAkRole(config set-auto-resume-limit) / runWithAutoResumeLoop(injected limit).
 */
import assert from "node:assert/strict";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import test from "node:test";

import { runAkRole, PUBLIC_ROLE_ARGV } from "../../src/public-cli/cli.ts";
import { runPublicInstructionSeat } from "../../src/public-cli/instruction-seat-run.ts";
import {
  loadPublicCliConfig,
  publicCliConfigPath,
  savePublicCliConfig,
  setAutoResumeLimit,
  setPersistentSeatConfig,
} from "../../src/public-cli/config.ts";
import { runWithAutoResumeLoop } from "../../src/public-cli/auto-resume.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";

async function withTempHome<T>(fn:(home:string)=>Promise<T>):Promise<T>{
  return withTempRoot("ak-422-", fn);
}

function failingJudgeRunner(callsRef:{n:number}){
  return async(args:readonly string[])=>{
    callsRef.n+=1;
    const sd=args[args.indexOf("--session-dir")+1]!;await mkdir(sd,{recursive:true});
    const sf=args[args.indexOf("--session")+1]!;
    await writeFile(sf,JSON.stringify({type:"message",message:{role:"user",content:[{type:"text",text:"go"}]}})+"\n","utf8");
    return{code:1,stderr:`fail ${callsRef.n}\n`,timedOut:false,args:[...args]};
  };
}

test("#422 loop honors injected effective limit once (N=4 → 5 dispatches, count=4)", async()=>{
  await withTempHome(async(home)=>{
    const runDir=join(home,"runs","422-loop-n4");await mkdir(join(runDir,"session"),{recursive:true});
    const sessionFile=join(runDir,"session","session.jsonl");await writeFile(sessionFile,"{}\n","utf8");
    let calls=0;const {io}=captureIo();
    const result=await runWithAutoResumeLoop({
    principalAuthority: piDurablePrincipalAuthority,
    sessionAppender: appendPiSessionCustomEntry,
      admitted:{principal:fixturePrincipal(dirname(sessionFile),sessionFile),runDirectory:runDir,role:"judge",runId:runDir,projectRoot:home},
      io,
      autoResumeLimit:4,
      buildInitialPayload: ()=>["--initial"],
      buildResumePayload: ()=>["--resume"],
      // #987: loop no longer supplies a lease; release only when present.
      dispatch: async(_extraArgs,lease)=>{calls+=1;if(lease!==undefined)await lease.release();return{exitCode:1};},
    });
    assert.equal(calls,5);
    assert.equal(result.exitCode,1);
  });
});

test("#422 loop with injected limit 0 disables auto resume (single dispatch)", async()=>{
  await withTempHome(async(home)=>{
    const runDir=join(home,"runs","422-loop-zero");await mkdir(join(runDir,"session"),{recursive:true});
    const sessionFile=join(runDir,"session","session.jsonl");await writeFile(sessionFile,"{}\n","utf8");
    let calls=0;const {io}=captureIo();
    const result=await runWithAutoResumeLoop({
    principalAuthority: piDurablePrincipalAuthority,
    sessionAppender: appendPiSessionCustomEntry,
      admitted:{principal:fixturePrincipal(dirname(sessionFile),sessionFile),runDirectory:runDir,role:"judge",runId:runDir,projectRoot:home},
      io,
      autoResumeLimit:0,
      buildInitialPayload: ()=>["--initial"],
      buildResumePayload: ()=>["--resume"],
      dispatch: async(_extraArgs,lease)=>{calls+=1;if(lease!==undefined)await lease.release();return{exitCode:1};},
    });
    assert.equal(calls,1);
    assert.equal(result.exitCode,1);
  });
});

test("#422 configured autoResumeLimit=N changes ceiling via real entry (judge, N=1 → 2 dispatches)", async()=>{
  await withTempHome(async(home)=>{
    await mkdir(join(home,".ak-roles"),{recursive:true});
    await writeFile(join(home,".ak-roles","public-cli.json"),`${JSON.stringify({seats:{},autoResumeLimit:1})}\n`,"utf8");
    const project=join(home,"proj");await mkdir(project,{recursive:true});seedGitProject(project);
    const runId="422-e2e-n1";const callsRef={n:0};
    const {io}=captureIo();
    const result=await runAkRole(["judge", "--model", "test/caller-seat:high","--project",project,"auto"],{packageRoot,home,cwd:project,credentials:{"openai-codex":true,xai:true},createRunId:()=>runId,io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: failingJudgeRunner(callsRef),
          })});
    assert.equal(callsRef.n,2);
    assert.equal(result.exitCode,1);
    assert.equal(result.terminal?.autoResumeCount,1);
  });
});

test("#422 configured autoResumeLimit=0 disables auto resume via real entry (judge, single dispatch)", async()=>{
  await withTempHome(async(home)=>{
    await mkdir(join(home,".ak-roles"),{recursive:true});
    await writeFile(join(home,".ak-roles","public-cli.json"),`${JSON.stringify({seats:{},autoResumeLimit:0})}\n`,"utf8");
    const project=join(home,"proj");await mkdir(project,{recursive:true});seedGitProject(project);
    const runId="422-e2e-zero";const callsRef={n:0};
    const {io}=captureIo();
    const result=await runAkRole(["judge", "--model", "test/caller-seat:high","--project",project,"auto"],{packageRoot,home,cwd:project,credentials:{"openai-codex":true,xai:true},createRunId:()=>runId,io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: failingJudgeRunner(callsRef),
          })});
    assert.equal(callsRef.n,1);
    assert.equal(result.exitCode,1);
    assert.equal(result.terminal?.autoResumeCount,0);
  });
});

test("#422 config parse and save preserve autoResumeLimit; seat setter keeps it (round-trip)", async()=>{
  await withTempHome(async(home)=>{
    // Raw disk document with both keys must survive a full load→save cycle.
    await mkdir(join(home,".ak-roles"),{recursive:true});
    await writeFile(publicCliConfigPath(home),`${JSON.stringify({seats:{},autoResumeLimit:7})}\n`,"utf8");
    let config=await loadPublicCliConfig(home);
    assert.equal(config.autoResumeLimit,7);

    // Any seat write must keep the sibling key.
    config=setPersistentSeatConfig(config,"judge",{provider:"xai",model:"grok-4.5"});
    await savePublicCliConfig(config,home);
    const raw=JSON.parse(await readFile(publicCliConfigPath(home),"utf8")) as Record<string,unknown>;
    assert.deepEqual(raw.seats,{judge:{provider:"xai",model:"grok-4.5"}});
    assert.equal(raw.autoResumeLimit,7);

    // Setter path writes the key.
    config=setAutoResumeLimit(config,3);
    await savePublicCliConfig(config,home);
    const reloaded=await loadPublicCliConfig(home);
    assert.equal(reloaded.autoResumeLimit,3);
    assert.ok(reloaded.seats.judge);
  });
});

test("#422 non-negative integers are legal including huge N; negatives/non-integers rejected loudly", async()=>{
  await withTempHome(async(home)=>{
    let config=await loadPublicCliConfig(home);
    for(const legal of [0,1,2,999999]){
      const next=setAutoResumeLimit(config,legal);
      assert.equal(next.autoResumeLimit,legal);
      await savePublicCliConfig(next,home);
      assert.equal((await loadPublicCliConfig(home)).autoResumeLimit,legal);
    }
    config=await loadPublicCliConfig(home);
    for(const illegal of [-1,1.5,Number.NaN,Infinity,-Infinity,"3" as unknown as number,null,true]){
      assert.throws(()=>setAutoResumeLimit(config,illegal as number));
    }
    // Disk-level rejects too (parse seam).
    await writeFile(publicCliConfigPath(home),`${JSON.stringify({seats:{},autoResumeLimit:-2})}\n`,"utf8");
    await assert.rejects(()=>loadPublicCliConfig(home));
    await writeFile(publicCliConfigPath(home),`${JSON.stringify({seats:{},autoResumeLimit:"2"})}\n`,"utf8");
    await assert.rejects(()=>loadPublicCliConfig(home));
  });
});

test("#422 ak-role config set-auto-resume-limit <N> writes durably", async()=>{
  await withTempHome(async(home)=>{
    const {io}=captureIo();
    const setResult=await runAkRole(["config","set-auto-resume-limit","5"],{packageRoot,home,io});
    assert.equal(setResult.exitCode,0);

    const persisted=JSON.parse(await readFile(join(home,".ak-roles","public-cli.json"),"utf8")) as Record<string,unknown>;
    assert.equal(persisted.autoResumeLimit,5);

  });
});

test("#422 set-auto-resume-limit rejects negative, fractional and non-numeric input loudly without writing", async()=>{
  await withTempHome(async(home)=>{
    for(const bad of ["-1","1.5","abc","","+2","1e2","0x10"]){
      const {io}=captureIo();
      const rejected=await runAkRole(["config","set-auto-resume-limit",bad],{packageRoot,home,io});
      assert.equal(rejected.exitCode,2,`expected structural rejection for ${JSON.stringify(bad)}`);
    }
    // Nothing was written by any of the failed attempts.
    let wrote=false;
    try{await readFile(join(home,".ak-roles","public-cli.json"),"utf8");wrote=true;}catch{}
    assert.equal(wrote,false);
  });
});

test("#422 set-auto-resume-limit rejects integers beyond the number fidelity boundary loudly without writing", async()=>{
  await withTempHome(async(home)=>{
    // 9007199254740993 is a legal non-negative integer, but Number() rounds it
    // to ...992. The verb seam must refuse (exit 2 + diagnostic) instead of
    // silently persisting a different N — and must not touch the config file.
    const {io}=captureIo();
    const rejected=await runAkRole(["config","set-auto-resume-limit","9007199254740993"],{packageRoot,home,io});
    assert.equal(rejected.exitCode,2);
    let wrote=false;
    try{await readFile(join(home,".ak-roles","public-cli.json"),"utf8");wrote=true;}catch{}
    assert.equal(wrote,false);

    // Fidelity boundary, not a cap: the largest exactly representable value is
    // still accepted and persisted byte-exactly.
    const {io:io2}=captureIo();
    const ok=await runAkRole(["config","set-auto-resume-limit","9007199254740992"],{packageRoot,home,io:io2});
    assert.equal(ok.exitCode,0);
    const raw=JSON.parse(await readFile(join(home,".ak-roles","public-cli.json"),"utf8")) as Record<string,unknown>;
    assert.equal(raw.autoResumeLimit,9007199254740992);
  });
});

test("#422 loop entry rejects NaN/negative/fractional/Infinity limits loudly before any dispatch", async()=>{
  await withTempHome(async(home)=>{
    const runDir=join(home,"runs","422-loop-nan");await mkdir(join(runDir,"session"),{recursive:true});
    const sessionFile=join(runDir,"session","session.jsonl");await writeFile(sessionFile,"{}\n","utf8");
    for(const bad of [Number.NaN,-1,1.5,Infinity,-Infinity]){
      let calls=0;const {io}=captureIo();
      await assert.rejects(
        ()=>runWithAutoResumeLoop({
    principalAuthority: piDurablePrincipalAuthority,
    sessionAppender: appendPiSessionCustomEntry,
          admitted:{principal:fixturePrincipal(dirname(sessionFile),sessionFile),runDirectory:runDir,role:"judge",runId:runDir,projectRoot:home},
          io,
          autoResumeLimit:bad,
          buildInitialPayload: ()=>["--initial"],
          buildResumePayload: ()=>["--resume"],
          dispatch: async(_extraArgs,lease)=>{calls+=1;if(lease!==undefined)await lease.release();return{exitCode:1};},
        }),
        (error: unknown) => error instanceof Error,
        `expected rejection for ${String(bad)}`,
      );
      assert.equal(calls,0,`NaN-style limit must not enter the first dispatch (${String(bad)})`);
    }
  });
});

test("#422 NaN injected via role entry (judge) terminates the whole call loudly without dispatching", async()=>{
  await withTempHome(async(home)=>{
    const project=join(home,"proj");await mkdir(project,{recursive:true});seedGitProject(project);
    const runId="422-nan-role-entry";let calls=0;
    const {io,stderr}=captureIo();
    await assert.rejects(
      ()=>runPublicInstructionSeat(["--project",project,"auto"],{
        home,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        agentDir:join(home,".ak-roles","agent"),
        packageRoot,
        cwd:project,
        credentials:{"openai-codex":true,xai:true},
        createRunId:()=>runId,
        autoResumeLimit:Number.NaN,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async(args)=>{calls+=1;return{code:0,stderr:"",timedOut:false,args:[...args]};},
          }),
      },io,"judge",PUBLIC_ROLE_ARGV.judge.parse),
      (error: unknown) => error instanceof Error,
    );
    assert.equal(calls,0,"role entry with NaN ceiling must terminate the whole call before the first dispatch");
    assert.deepEqual(stderr,[]);
  });
});

test("#422 seat write after set-auto-resume-limit keeps both keys on disk", async()=>{
  await withTempHome(async(home)=>{
    const {io}=captureIo();
    const setResult=await runAkRole(["config","set-auto-resume-limit","9"],{packageRoot,home,io});
    assert.equal(setResult.exitCode,0);

    const seatResult=await runAkRole(["config","set","coder","kimi-coding/k3-256k"],{packageRoot,home,io});
    assert.equal(seatResult.exitCode,0);

    const raw=JSON.parse(await readFile(join(home,".ak-roles","public-cli.json"),"utf8")) as Record<string,unknown>;
    assert.equal(raw.autoResumeLimit,9);
    assert.deepEqual(raw.seats,{coder:{provider:"kimi-coding",model:"k3-256k"}});
  });
});
