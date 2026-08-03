import assert from "node:assert/strict";
import test from "node:test";
import { admitReviewerProposal, REVIEWER_CHILD_TOOLS, REVIEWER_PREREQUISITES } from "../../src/reviewer-admission.ts";
import { acquireReviewerPinnedEvidence, type ReviewerPinnedGitReader } from "../../src/reviewer-pinned-git.ts";
import { parseReviewerCapabilities } from "../../src/reviewer-dispatch.ts";
import { sha256Hex } from "../../src/sha256.ts";

const task=Buffer.from("task"); const command="git diff A...B";
const capabilities=parseReviewerCapabilities(Buffer.from(JSON.stringify({version:1,taskSha256:sha256Hex(task),tools:[...REVIEWER_CHILD_TOOLS],prerequisiteOperations:[...REVIEWER_PREREQUISITES]})),task);
const grant={tools:["read","bash"] as const,prerequisiteOperations:[...REVIEWER_PREREQUISITES]};
const proposal={version:1 as const,base:{revision:"A"},materials:[{id:"rules",repositoryPath:"RULES.md"}],relevanceHints:{standards:["rules"]},spec:{state:"not-established" as const},required:{standards:grant}};

test("mechanical admission accepts presentation extras and advisory dangling hints while preserving identity constraints",()=>{const presented={...proposal,presentation:"ignored",base:{revision:"A",label:"base"},materials:[{id:"rules",repositoryPath:"RULES.md",label:"rules"}],relevanceHints:{standards:["not-a-material-id"],note:"advisory"},spec:{state:"not-established" as const,note:"known"},required:{standards:{...grant,note:"grant"}},};const admitted=admitReviewerProposal(presented,capabilities,REVIEWER_CHILD_TOOLS);assert.equal(admitted.baseRevision,"A");assert.deepEqual(admitted.relevanceHints?.standards,["not-a-material-id"]);assert.ok(Object.isFrozen(admitted));assert.ok(Object.isFrozen(admitted.materials));assert.throws(()=>admitReviewerProposal({...proposal,materials:[proposal.materials[0]!,proposal.materials[0]!]},capabilities,REVIEWER_CHILD_TOOLS),/material-invalid/);});

test("pinned evidence acquisition normalizes only after admission and preserves infrastructure errors",async()=>{let reads=0;const pin={repositoryRoot:"/r",objectFormat:"sha1" as const,targetHead:"B",refs:{}};const reader:ReviewerPinnedGitReader={pin,async snapshot(){return pin},async resolve(){reads++;return "A"},async range(){reads++;return {base:"A",target:"B",diffCommand:command,diffSha256:"1".repeat(64),commits:["B"]}},async material(){reads++;return Buffer.from("rules")}};const admitted=admitReviewerProposal(proposal,capabilities,REVIEWER_CHILD_TOOLS);const evidence=await acquireReviewerPinnedEvidence(reader,pin,admitted);assert.equal(reads,3);assert.ok(Object.isFrozen(evidence));assert.equal(evidence.materials[0]!.text,"rules");const boom=new Error("disk failed");await assert.rejects(acquireReviewerPinnedEvidence({...reader,async material(){throw boom}},pin,admitted),error=>error===boom);});

// Deleted pure self-double-call determinism case (assert.deepEqual(f(x), f(x))).
// Production already double-compiles at reviewer-construction.ts; dispatch seams own the contract.
