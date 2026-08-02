import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { type Context, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { packageRoot, packIsolatedPackage, withHermeticHome, withInProcessPi, writeTestSkill } from "./helpers/pi-test-harness.ts";

const exec = promisify(execFile);
const Agent = "Agent";
const Output = "ak_reviewer_output";
const Audit = "ak_reviewer_audit_decision";
const prerequisites = [
  "preflight.git.pin-target", "preflight.git.resolve-base", "preflight.git.derive-range",
  "preflight.git.list-ordered-commits", "preflight.git.read-material", "runner.git.materialize-mirror",
  "runner.git.materialize-workspace", "runner.git.verify-snapshot",
];
function userText(context: Context): string {
  const message = context.messages.find((item) => item.role === "user");
  if (!message || message.role !== "user") return "";
  return typeof message.content === "string" ? message.content : message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
}
async function git(cwd: string, ...args: string[]) { return (await exec("git", ["-C", cwd, ...args])).stdout.trim(); }

test("installed npm tarball runs the complete established-Spec Reviewer lifecycle", async () => {
  await withHermeticHome({ prefix: "ak-reviewer-package-" }, async ({ home }) => {
    const fixture = resolve(home, "consumer");
    const agentDir = resolve(fixture, ".pi-agent");
    const { path: skillPath } = await writeTestSkill(home, "code-review");
    const skillRaw = await readFile(new URL("./fixtures/canonical-code-review-SKILL.md", import.meta.url), "utf8");
    await writeFile(skillPath, skillRaw);
    await mkdir(fixture, { recursive: true });
    await git(fixture, "init");
    await git(fixture, "config", "user.email", "consumer@example.com");
    await git(fixture, "config", "user.name", "Consumer");
    await writeFile(resolve(fixture, "consumer.txt"), "base\n");
    await writeFile(resolve(fixture, "STANDARDS.md"), "Require a tested readable change.\n");
    await writeFile(resolve(fixture, "SPEC.md"), "The consumer text must become reviewed.\n");
    await git(fixture, "add", "."); await git(fixture, "commit", "-m", "base");
    await git(fixture, "branch", "review-base");
    await writeFile(resolve(fixture, "consumer.txt"), "reviewed\n");
    await git(fixture, "commit", "-am", "reviewed change");
    const target = await git(fixture, "rev-parse", "HEAD");
    const base = await git(fixture, "rev-parse", "review-base");
    const diffCommand = `git diff ${base}...${target}`;
    const standardsRequest = { tools: ["read", "bash"], prerequisiteOperations: [] };
    const specRequest = { tools: ["read", "bash"], prerequisiteOperations: ["preflight.git.read-material"] };
    const root = await realpath(fixture);
    const nestedCwd = resolve(fixture, "nested", "invocation");
    await mkdir(nestedCwd, { recursive: true });

    const pack = await packIsolatedPackage(home);
    assert.ok(pack.files.some((file) => file.path === "src/reviewer-dispatch.ts"));
    assert.ok(pack.files.some((file) => file.path === "src/reviewer-pinned-git.ts"));
    assert.equal(pack.files.some((file) => /(^|\/)SKILL\.md$/.test(file.path)), false);
    assert.ok(pack.files.some((file) => file.path === "README.md"));
    const packagedReadme = (await exec("tar", ["-xOf", pack.tarball, "package/README.md"])).stdout;
    assert.match(packagedReadme, /reviewerProposalSchema/);
    assert.doesNotMatch(packagedReadme, /standardsMaterials.*may be empty|preflight\.git\.pin-target\|/);
    await writeFile(resolve(fixture, "package.json"), JSON.stringify({ private: true, dependencies: {
      "@ak/pi-workflow-roles": `file:${pack.tarball}`,
      "@earendil-works/pi-ai": `file:${resolve(packageRoot, "node_modules/@earendil-works/pi-ai")}`,
      "@earendil-works/pi-coding-agent": `file:${resolve(packageRoot, "node_modules/@earendil-works/pi-coding-agent")}`,
      typebox: `file:${resolve(packageRoot, "node_modules/typebox")}`,
    }}));
    await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: fixture });

    const taskBytes = Buffer.from("# Fixed review task\n\nReview current HEAD against review-base using STANDARDS.md and SPEC.md.\n");
    const taskPath = resolve(fixture, "review-task.md");
    const capsPath = resolve(fixture, "review-capabilities.json");
    await writeFile(taskPath, taskBytes);
    const capabilityText = JSON.stringify({ version: 1, taskSha256: createHash("sha256").update(taskBytes).digest("hex"), tools: ["read", "bash", "edit"], prerequisiteOperations: prerequisites }, null, 2) + "\n";
    await writeFile(capsPath, capabilityText);

    const installedDispatch = await import(new URL(`file://${resolve(fixture, "node_modules/@ak/pi-workflow-roles/src/reviewer-dispatch.ts")}`).href);
    const installedContracts = await import(new URL(`file://${resolve(fixture, "node_modules/@ak/pi-workflow-roles/src/package-contracts/reviewer-output.ts")}`).href);
    assert.equal("validateAcceptedReviewerDetails" in installedContracts, false);
    assert.equal(typeof installedContracts.validateReviewerIntent, "function");
    assert.equal(typeof installedContracts.validateRuntimeReviewerReceipt, "function");
    assert.equal(typeof installedContracts.projectReviewerIntentToReceipt, "function");
    const missingRecipeText = JSON.stringify({
      version: 1,
      taskSha256: createHash("sha256").update(taskBytes).digest("hex"),
      tools: ["read", "bash"],
      prerequisiteOperations: prerequisites.filter((operation) => operation !== "runner.git.verify-snapshot"),
    });
    let missingRecipeRuns = 0;
    const missingRecipeDispatcher = installedDispatch.createReviewerDispatcher({
      task: taskBytes,
      canonicalSkill: skillRaw,
      capabilities: installedDispatch.parseReviewerCapabilities(Buffer.from(missingRecipeText), taskBytes),
      reader: {
        pin: { repositoryRoot: root, objectFormat: "sha1" as const, targetHead: target, refs: {} },
        async snapshot() { return this.pin; },
        async resolve() { return base; },
        async range() { return { base, target, diffCommand, diffSha256: "1".repeat(64), commits: [target] }; },
        async material(repositoryPath: string) { return readFile(resolve(fixture, repositoryPath)); },
      },
      hostTools: ["read", "bash"],
      async run() { missingRecipeRuns += 1; throw new Error("must not run"); },
    });

    const proposal =  { version: 1, base: { revision: "review-base" }, materials: [{ id: "spec", repositoryPath: "SPEC.md" }], spec: { state: "established" }, required: { standards: standardsRequest, spec: specRequest } };
    const bad = { ...proposal, required: { standards: standardsRequest, spec: { ...specRequest, tools: ["write"] } } };
    const missingRecipe = await missingRecipeDispatcher.propose(proposal);
    assert.equal(missingRecipe.status, "rejected");
    if (missingRecipe.status === "rejected") assert.deepEqual(missingRecipe.violations, ["prerequisite-missing"]);
    assert.equal(missingRecipeRuns, 0);
    const candidate = { status: "completed" };
    const corrected = { status: "completed" };
    const faux = fauxProvider({ api: "package-reviewer", provider: "package-reviewer", tokenSize: { min: 1000, max: 1000 } });
    let parent: Context | undefined;
    const children: Context[] = []; const audits: Context[] = [];
    faux.setResponses([
      (ctx) => { parent = ctx; return fauxAssistantMessage(fauxToolCall(Agent, bad, { id: "rejected" }), { stopReason: "toolUse" }); },
      fauxAssistantMessage(fauxToolCall(Agent, proposal, { id: "accepted" }), { stopReason: "toolUse" }),
      (ctx) => { children.push(ctx); return fauxAssistantMessage("Standards report: no findings."); },
      (ctx) => { children.push(ctx); return fauxAssistantMessage("Spec report: requirement satisfied."); },
      fauxAssistantMessage(fauxToolCall(Output, candidate, { id: "candidate" }), { stopReason: "toolUse" }),
      (ctx) => { audits.push(ctx); return fauxAssistantMessage(fauxToolCall(Audit, { status: "revise", violations: ["add axis counts"] }), { stopReason: "toolUse" }); },
      fauxAssistantMessage(fauxToolCall(Output, corrected, { id: "corrected" }), { stopReason: "toolUse" }),
      (ctx) => { audits.push(ctx); return fauxAssistantMessage(fauxToolCall(Audit, { status: "pass", violations: [] }), { stopReason: "toolUse" }); },
    ]);

    const originalCwd = process.cwd();
    process.chdir(nestedCwd);
    try {
    await withInProcessPi({ cwd: nestedCwd, agentDir, faux, modelsPath: null, additionalExtensionPaths: [resolve(fixture, "node_modules/@ak/pi-workflow-roles/extensions/role-runtime.ts")], additionalSkillPaths: [skillPath], noExtensions: true, systemPrompt: "PACKAGED REVIEWER", mode: "print", flags: { "ak-role": "reviewer", "ak-review-task": taskPath, "ak-review-capabilities": capsPath }, reviewerShutdown: true }, async ({ loader, session, sessionManager }) => {
      assert.deepEqual(loader.getExtensions().errors, []);
      const before = await readFile(resolve(fixture, "consumer.txt"), "utf8");
      await session.prompt("Review this fixed point.");
      assert.ok(parent);
      assert.match(userText(parent), new RegExp(`<skill name="code-review" location="${skillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">`));
      assert.ok(userText(parent).includes(stripFrontmatter(skillRaw).trim()));
      assert.ok(children.length >= 1);
      const results = sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "toolResult");
      const rejected = results.find((e: any) => e.message.toolCallId === "rejected") as any;
      const accepted = results.find((e: any) => e.message.toolCallId === "accepted") as any;
      assert.equal(rejected.message.details.status, "rejected");
      assert.deepEqual(accepted.message.details, { status: "accepted", identity: accepted.message.details.identity });
      assert.deepEqual(accepted.message.content, [{ type: "text", text: "Reviewer dispatch accepted" }]);
      assert.equal(children.some((child) => userText(child).includes(capabilityText)), false);
      assert.equal(audits.length, 2);
      assert.match(userText(audits[0]!), /structured_execution_record/);
      assert.ok(userText(audits[0]!).includes(createHash("sha256").update(capabilityText).digest("hex")));
      const firstOutput = results.find((e: any) => e.message.toolCallId === "candidate") as any;
      const finalOutput = results.find((e: any) => e.message.toolCallId === "corrected") as any;
      assert.equal(firstOutput.message.isError, true);
      assert.equal(finalOutput.message.isError, false);
      assert.equal(finalOutput.message.details.version, 2);
      assert.equal(finalOutput.message.details.status, "completed");
      assert.equal(finalOutput.message.details.acceptedBatch.identity, accepted.message.details.identity);
      assert.deepEqual(finalOutput.message.details.acceptedBatch.legs.map((leg: any) => leg.axis), ["standards", "spec"]);
      assert.match(finalOutput.message.details.acceptedBatch.legs[0].prompt.text, /canonical-skill\.md.*sha256/);
      assert.deepEqual(
        [finalOutput.message.details.reports.standards.text, finalOutput.message.details.reports.spec.text].sort(),
        ["Standards report: no findings.", "Spec report: requirement satisfied."].sort(),
      );
      assert.equal(await readFile(resolve(fixture, "consumer.txt"), "utf8"), before);
      assert.equal(faux.getPendingResponseCount(), 0);
    });

    const noSpecFaux = fauxProvider({ api: "package-reviewer-no-spec", provider: "package-reviewer-no-spec", tokenSize: { min: 1000, max: 1000 } });
    const noSpecProposal = { version: 1, base: { revision: "review-base" }, materials: [{ id: "no-spec", repositoryPath: "SPEC.md" }], spec: { state: "not-established" }, required: { standards: standardsRequest } };
    const noSpecChildren: Context[] = []; const noSpecCommandContexts: Context[] = []; const noSpecAudits: Context[] = [];
    noSpecFaux.setResponses([
      fauxAssistantMessage(fauxToolCall(Agent, noSpecProposal, { id: "no-spec-accepted" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", { command: "git status" }, { id: "arbitrary-command" }), { stopReason: "toolUse" }),
      (ctx) => { noSpecCommandContexts.push(ctx); return fauxAssistantMessage(fauxToolCall("bash", { command: `${diffCommand} ` }, { id: "near-match-command" }), { stopReason: "toolUse" }); },
      (ctx) => { noSpecCommandContexts.push(ctx); return fauxAssistantMessage(fauxToolCall("bash", { command: diffCommand }, { id: "canonical-command" }), { stopReason: "toolUse" }); },
      (ctx) => { noSpecCommandContexts.push(ctx); noSpecChildren.push(ctx); return fauxAssistantMessage("Standards report: no findings."); },
      fauxAssistantMessage(fauxToolCall(Output, { status: "completed" }, { id: "no-spec-output" }), { stopReason: "toolUse" }),
      (ctx) => { noSpecAudits.push(ctx); return fauxAssistantMessage(fauxToolCall(Audit, { status: "pass", violations: [] }), { stopReason: "toolUse" }); },
    ]);
    await withInProcessPi({ cwd: nestedCwd, agentDir: resolve(fixture, ".pi-agent-no-spec"), faux: noSpecFaux, modelsPath: null, additionalExtensionPaths: [resolve(fixture, "node_modules/@ak/pi-workflow-roles/extensions/role-runtime.ts")], additionalSkillPaths: [skillPath], noExtensions: true, systemPrompt: "PACKAGED REVIEWER", mode: "print", flags: { "ak-role": "reviewer", "ak-review-task": taskPath, "ak-review-capabilities": capsPath }, reviewerShutdown: true }, async ({ loader, session, sessionManager }) => {
      assert.deepEqual(loader.getExtensions().errors, []);
      await session.prompt("Review with no established Spec.");
      const results = sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "toolResult") as any[];
      const accepted = results.find((e: any) => e.message.toolCallId === "no-spec-accepted");
      const output = results.find((e: any) => e.message.toolCallId === "no-spec-output");
      assert.deepEqual(accepted.message.details, { status: "accepted", identity: accepted.message.details.identity });
      assert.deepEqual(output.message.details.acceptedBatch.legs.map((leg: any) => leg.axis), ["standards"]);
      assert.equal(output.message.details.identities.target.objectFormat, "sha1");
      assert.equal(noSpecChildren.length, 1); assert.equal(noSpecAudits.length, 1);
      const commandResults = noSpecCommandContexts.map((ctx) => ctx.messages.filter((message) => message.role === "toolResult").at(-1));
      assert.equal((commandResults[0] as any)?.isError, true); assert.match(JSON.stringify(commandResults[0]), /exact accepted member/);
      assert.equal((commandResults[1] as any)?.isError, true); assert.match(JSON.stringify(commandResults[1]), /exact accepted member/);
      assert.equal((commandResults[2] as any)?.isError, false); assert.match(JSON.stringify(commandResults[2]), /consumer\.txt/);
      assert.equal(JSON.stringify(noSpecProposal).includes(diffCommand), false); assert.equal(capabilityText.includes(diffCommand), false);
      assert.doesNotMatch(userText(noSpecChildren[0]!), /Quote the spec line for each finding/);
      assert.doesNotMatch(userText(noSpecAudits[0]!), /\"axis\":\"spec\"/);
      assert.equal(output.message.isError, false); assert.equal(output.message.details.status, "completed");
      assert.equal(noSpecFaux.getPendingResponseCount(), 0);
    });

    const refusedFaux = fauxProvider({ api: "package-reviewer-refused", provider: "package-reviewer-refused", tokenSize: { min: 1000, max: 1000 } });
    refusedFaux.setResponses([
      fauxAssistantMessage(fauxToolCall(Output, { status: "refused", diagnostic: "No review can be started." }, { id: "refused-output" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall(Audit, { status: "pass", violations: [] }), { stopReason: "toolUse" }),
    ]);
    await withInProcessPi({ cwd: nestedCwd, agentDir: resolve(fixture, ".pi-agent-refused"), faux: refusedFaux, modelsPath: null, additionalExtensionPaths: [resolve(fixture, "node_modules/@ak/pi-workflow-roles/extensions/role-runtime.ts")], additionalSkillPaths: [skillPath], noExtensions: true, systemPrompt: "PACKAGED REVIEWER", mode: "print", flags: { "ak-role": "reviewer", "ak-review-task": taskPath, "ak-review-capabilities": capsPath }, reviewerShutdown: true }, async ({ session, sessionManager }) => {
      await session.prompt("Refuse before dispatch.");
      const output = sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "refused-output") as any;
      assert.equal(output.message.isError, false);
      assert.equal(output.message.details.version, 2);
      assert.equal(output.message.details.status, "refused");
      assert.equal(output.message.details.diagnostic, "No review can be started.");
      assert.deepEqual(output.message.details.reports, {});
      assert.deepEqual(output.message.details.outcomes, {});
      installedContracts.projectReviewerIntentToReceipt({ status: "refused", diagnostic: "No review can be started." }, output.message.details);
    });
    } finally {
      process.chdir(originalCwd);
    }
  });
});
