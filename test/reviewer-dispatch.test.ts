import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createReviewerDispatcher,
  parseReviewerCapabilities,
  type ReviewerPinnedGitReader,
  type ReviewerProposalV1,
} from "../src/reviewer-dispatch.ts";

const task = Buffer.from(" review exactly \n");
const digest = createHash("sha256").update(task).digest("hex");
const skill = `# Code review\n## Standards baseline\n- Readability\n- Design\n- Tests\n## Standards review burden\nApply every baseline item.\n## Spec review burden\nCheck every requirement.\n`;
const ceiling = JSON.stringify({version:1,taskSha256:digest,tools:["read","bash"],bashCommands:["git diff A..B"],prerequisiteOperations:["preflight.git.resolve-base","preflight.git.derive-range","preflight.git.list-ordered-commits","preflight.git.read-material","runner.git.materialize-mirror","runner.git.materialize-workspace","runner.git.verify-snapshot"]});

test("capability ceiling is exact, task-byte-bound, and closed", () => {
  const parsed = parseReviewerCapabilities(Buffer.from(ceiling), task);
  assert.deepEqual(parsed.tools, ["read", "bash"]);
  for (const bad of [
    {...JSON.parse(ceiling), taskSha256: digest.toUpperCase()},
    {...JSON.parse(ceiling), tools:["read","shell"]},
    {...JSON.parse(ceiling), tools:["read"], bashCommands:["git diff A..B"]},
    {...JSON.parse(ceiling), extra:true},
  ]) assert.throws(() => parseReviewerCapabilities(Buffer.from(JSON.stringify(bad)), task));
  assert.throws(() => parseReviewerCapabilities(Buffer.from(ceiling), Buffer.from(task.toString().trim())));
});

function reader(): ReviewerPinnedGitReader {
  return {
    pin: {repositoryRoot:"/repo",targetHead:"B",refs:{"refs/heads/main":"B"}},
    async resolve(base) { assert.equal(base,"A"); return "A"; },
    async range(base) { return {base,target:"B",diffCommand:"git diff A..B",commits:["B"]}; },
    async material(path, revision) { return Buffer.from(`${revision}:${path}\n`); },
  };
}
const required = {tools:["read","bash"] as const,bashCommands:["git diff A..B"] as const,prerequisiteOperations:["preflight.git.resolve-base","preflight.git.derive-range","preflight.git.list-ordered-commits","preflight.git.read-material","runner.git.materialize-mirror","runner.git.materialize-workspace","runner.git.verify-snapshot"] as const};
const proposal: ReviewerProposalV1 = {version:1,base:{revision:"A"},standardsMaterials:[{id:"style",repositoryPath:"STYLE.md"}],spec:{state:"established",materials:[{id:"requirements",repositoryPath:"SPEC.md"}]},required:{standards:required,spec:required}};

test("atomic compiler binds canonical bytes and accepts exactly once", async () => {
  let starts=0; let accepted:any;
  const dispatcher=createReviewerDispatcher({task,canonicalSkill:skill,capabilities:parseReviewerCapabilities(Buffer.from(ceiling),task),reader:reader(),hostTools:["read","bash"],run:async value=>{starts++;accepted=value;return [{axis:"standards",report:"ok",workspaceDisposition:"deleted"},{axis:"spec",report:"ok",workspaceDisposition:"deleted"}];}});
  const result=await dispatcher.propose(proposal);
  assert.equal(result.status,"accepted"); assert.equal(starts,1); assert.equal(accepted.legs.length,2);
  for(const leg of accepted.legs){assert.equal(Buffer.byteLength(leg.prompt),leg.utf8Length);assert.equal(createHash("sha256").update(leg.prompt).digest("hex"),leg.sha256);}
  assert.match(accepted.legs[0].prompt,/Readability/); assert.doesNotMatch(accepted.legs[1].prompt,/Readability/);
  assert.equal(accepted.legs[0].actualPrompt,undefined);
  assert.equal((await dispatcher.propose(proposal)).status,"closed"); assert.equal(starts,1);
});

test("failed all-leg preflight has no effect and correction remains possible", async () => {
  let starts=0;
  const dispatcher=createReviewerDispatcher({task,canonicalSkill:skill,capabilities:parseReviewerCapabilities(Buffer.from(ceiling),task),reader:reader(),hostTools:["read","bash"],run:async()=>{starts++;return[];}});
  const bad={...proposal,required:{...proposal.required,spec:{...required,bashCommands:["git status"]}}};
  assert.equal((await dispatcher.propose(bad)).status,"rejected"); assert.equal(starts,0);
  assert.equal((await dispatcher.propose(proposal)).status,"accepted"); assert.equal(starts,1);
});

test("established no-spec compiles and runs one Standards leg and no Spec bytes", async () => {
  let accepted:any;
  const dispatcher=createReviewerDispatcher({task,canonicalSkill:skill,capabilities:parseReviewerCapabilities(Buffer.from(ceiling),task),reader:reader(),hostTools:["read","bash"],run:async value=>{accepted=value;return[];}});
  const one={...proposal,spec:{state:"not-established" as const,evidence:[{id:"absence",repositoryPath:"NO-SPEC.md"}]},required:{standards:required}};
  assert.equal((await dispatcher.propose(one)).status,"accepted");
  assert.deepEqual(accepted.legs.map((x:any)=>x.axis),["standards"]); assert.doesNotMatch(accepted.legs[0].prompt,/Spec review burden/);
});
