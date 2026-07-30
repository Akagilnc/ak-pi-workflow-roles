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
    const request = { tools: ["read", "bash"], bashCommands: [diffCommand], prerequisiteOperations: prerequisites };
    const root = await realpath(fixture);

    const pack = await packIsolatedPackage(home);
    assert.ok(pack.files.some((f) => f.path === "src/reviewer-dispatch.ts"));
    assert.ok(pack.files.some((f) => f.path === "src/reviewer-pinned-git.ts"));
    assert.equal(pack.files.some((f) => /(^|\/)SKILL\.md$/.test(f.path)), false);
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
    await writeFile(capsPath, JSON.stringify({ version: 1, taskSha256: createHash("sha256").update(taskBytes).digest("hex"), tools: ["read", "bash"], bashCommands: [diffCommand], prerequisiteOperations: prerequisites }));

    const proposal = { version: 1, base: { revision: "review-base" }, standardsMaterials: [{ id: "standards", repositoryPath: "STANDARDS.md" }], spec: { state: "established", materials: [{ id: "spec", repositoryPath: "SPEC.md" }] }, required: { standards: request, spec: request } };
    const bad = { ...proposal, required: { standards: request, spec: { ...request, bashCommands: ["git status"] } } };
    const candidate = { status: "completed", report: "## Standards\nReadable.\n\n## Spec\nSatisfied." };
    const corrected = { status: "completed", report: "## Standards\nReadable; no findings.\n\n## Spec\nRequirement satisfied; no findings.\n\nStandards: 0; Spec: 0." };
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
    process.chdir(fixture);
    try {
    await withInProcessPi({ cwd: fixture, agentDir, faux, modelsPath: null, additionalExtensionPaths: [resolve(fixture, "node_modules/@ak/pi-workflow-roles/extensions/role-runtime.ts")], additionalSkillPaths: [skillPath], noExtensions: true, systemPrompt: "PACKAGED REVIEWER", mode: "print", flags: { "ak-role": "reviewer", "ak-review-task": taskPath, "ak-review-capabilities": capsPath }, reviewerShutdown: true }, async ({ loader, session, sessionManager }) => {
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
      assert.equal(accepted.message.details.status, "accepted", JSON.stringify(accepted.message.details));
      assert.equal(accepted.message.details.dispatch.legs.length, 2);
      assert.match(accepted.message.details.dispatch.legs[0].prompt, /\*\*Refused Bequest\*\*/);
      assert.match(accepted.message.details.dispatch.legs[1].prompt, /Quote the spec line for each finding/);
      assert.doesNotMatch(accepted.message.details.dispatch.legs[0].prompt, /consumer text must become reviewed|Review current HEAD against/);
      assert.equal(accepted.message.details.dispatch.input.task.bytes, taskBytes.toString("utf8"));
      assert.equal(accepted.message.details.dispatch.input.task.sha256, createHash("sha256").update(taskBytes).digest("hex"));
      assert.match(accepted.message.details.dispatch.range.diffCommand, /^git diff [0-9a-f]{40}\.\.\.[0-9a-f]{40}$/);
      assert.match(accepted.message.details.dispatch.range.diffSha256, /^[0-9a-f]{64}$/);
      assert.deepEqual(accepted.message.details.dispatch.legs.map((l: any) => l.axis), ["standards", "spec"]);
      assert.equal(accepted.message.details.dispatch.targetSnapshot.repositoryRoot, root);
      assert.equal(accepted.message.details.dispatch.targetSnapshot.targetHead, target);
      for (const leg of accepted.message.details.dispatch.legs) {
        assert.equal(createHash("sha256").update(leg.prompt).digest("hex"), leg.sha256);
        assert.match(leg.prompt, /Task-SHA256: [0-9a-f]{64}/);
      }
      assert.equal(audits.length, 2);
      assert.match(userText(audits[0]!), /structured_execution_record/);
      const firstOutput = results.find((e: any) => e.message.toolCallId === "candidate") as any;
      const finalOutput = results.find((e: any) => e.message.toolCallId === "corrected") as any;
      assert.equal(firstOutput.message.isError, true);
      assert.equal(finalOutput.message.isError, false);
      assert.deepEqual(finalOutput.message.details, corrected);
      assert.equal(await readFile(resolve(fixture, "consumer.txt"), "utf8"), before);
      assert.equal(faux.getPendingResponseCount(), 0);
    });
    } finally {
      process.chdir(originalCwd);
    }
  });
});
