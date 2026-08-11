import assert from "node:assert/strict";
import test from "node:test";
import { createReviewerDispatcher, type AcceptedReviewerExecution, type ReviewerPinnedGitReader } from "../../src/reviewer-dispatch.ts";

const pin={repositoryRoot:"/repo",objectFormat:"sha1" as const,targetHead:"target",refs:{}};
const range={base:"base",target:"target",diffCommand:"git diff base...target",diffSha256:"1".repeat(64),commits:["target"]};
function harness(snapshot=pin){let execution:AcceptedReviewerExecution|undefined;const reader:ReviewerPinnedGitReader={pin,async snapshot(){return snapshot},async resolve(){return "base"},async range(){return range}};const dispatcher=createReviewerDispatcher({canonicalSkill:"review skill",reader,async run(value){execution=value;return "done"}});return {dispatcher,get execution(){return execution}}}
test("fixed dispatch always launches independent Standards and Spec legs",async()=>{const h=harness();const result=await h.dispatcher.dispatch("main~1");assert.equal(result.status,"accepted");assert.deepEqual(h.execution?.legs.map(x=>x.axis),["standards","spec"])});
test("target drift prevents child execution",async()=>{const h=harness({...pin,targetHead:"other"});const result=await h.dispatcher.dispatch("main~1");assert.equal(result.status,"rejected");if(result.status==="rejected")assert.deepEqual(result.violations,["target-drift"]);assert.equal(h.execution,undefined)});
test("constructed legs exclude caller task channel", async () => {
  const h = harness();
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  for (const leg of result.dispatch.legs) {
    assert.equal(leg.prompt.includes("Task:"), false);
    assert.equal(leg.prompt.includes("supplied task"), false);
    assert.equal(leg.prompt.includes("review task"), false);
    assert.match(leg.prompt, /Canonical-Skill:/);
    assert.match(leg.prompt, /Fixed-Range:/);
  }
  assert.equal("task" in result.dispatch.input, false);
  assert.equal(result.dispatch.input.canonicalSkill, "review skill");
});
