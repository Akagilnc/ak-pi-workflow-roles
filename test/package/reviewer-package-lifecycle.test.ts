import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { type Context, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { withColdInstalledPackage, withHermeticHome, withInProcessPi, withProcessCwd } from "../helpers/pi-test-harness.ts";

const exec = promisify(execFile);
const Output = "ak_reviewer_output";
const Audit = "ak_reviewer_audit_decision";
function userText(context: Context): string {
  const message = context.messages.find((item) => item.role === "user");
  if (!message || message.role !== "user") return "";
  return typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
async function git(cwd: string, ...args: string[]) { return (await exec("git", ["-C", cwd, ...args])).stdout.trim(); }

test("installed npm tarball runs the fixed two-axis Reviewer lifecycle", async () => {
  process.env.CI = "true";
  await withHermeticHome({ prefix: "ak-reviewer-package-" }, async ({ home }) => {
    await withColdInstalledPackage(home, async ({ fixture, pack, installedRoot }) => {
      assert.ok(pack.files.some((file) => file.path === "dist/public-cli/main.js"));
      assert.ok(pack.files.some((file) => file.path === "src/reviewer-dispatch.ts"));
      assert.ok(pack.files.some((file) => file.path === "resources/methods/code-review/SKILL.md"));
      assert.equal(pack.files.some((file) => file.path === "src/reviewer-admission.ts"), false);

      await git(fixture, "init");
      await git(fixture, "config", "user.email", "consumer@example.com");
      await git(fixture, "config", "user.name", "Consumer");
      await writeFile(resolve(fixture, ".gitignore"), "node_modules\n.pi-agent*\n");
      await writeFile(resolve(fixture, "consumer.txt"), "base\n");
      await git(fixture, "add", ".gitignore", "consumer.txt");
      await git(fixture, "commit", "-m", "base");
      await git(fixture, "branch", "review-base");
      await writeFile(resolve(fixture, "consumer.txt"), "reviewed\n");
      await git(fixture, "commit", "-am", "reviewed change");

      const taskPath = resolve(fixture, "review-task.md");
      await writeFile(taskPath, "Review the fixed target against review-base.\n");
      const nestedCwd = resolve(fixture, "nested", "invocation");
      await mkdir(nestedCwd, { recursive: true });
      const skillPath = resolve(installedRoot, "resources/methods/code-review/SKILL.md");
      const agentDir = resolve(fixture, ".pi-agent");
      const faux = fauxProvider({ api: "package-reviewer", provider: "package-reviewer", tokenSize: { min: 1000, max: 1000 } });
      const children: Context[] = [];
      const audits: Context[] = [];
      faux.setResponses([
        (context) => { children.push(context); return fauxAssistantMessage("Standards finding count: 0."); },
        (context) => { children.push(context); return fauxAssistantMessage("Spec: fixed target satisfies the stated behavior."); },
        fauxAssistantMessage(fauxToolCall(Output, { status: "completed" }, { id: "output" }), { stopReason: "toolUse" }),
        (context) => { audits.push(context); return fauxAssistantMessage(fauxToolCall(Audit, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" }); },
      ]);

      await withProcessCwd(nestedCwd, async () => {
        await withInProcessPi({ activationLedgerSession: true, cwd: nestedCwd, agentDir, faux, modelsPath: null, additionalExtensionPaths: [resolve(installedRoot, "extensions/role-runtime.ts")], additionalSkillPaths: [skillPath], noExtensions: true, systemPrompt: "PACKAGED REVIEWER", mode: "print", flags: { "ak-role": "reviewer", "ak-review-task": taskPath, "ak-review-base": "review-base" }, reviewerShutdown: true }, async ({ loader, session, sessionManager }) => {
          assert.deepEqual(loader.getExtensions().errors, []);
          await session.prompt("Review this fixed point.");
          assert.equal(children.length, 2);
          assert.deepEqual(children.map((context) => /standards/.test(userText(context)) ? "standards" : "spec"), ["standards", "spec"]);
          assert.equal(audits.length, 1);
          const output = sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "output") as any;
          assert.equal(output.message.isError, false);
          assert.equal(output.message.details.status, "completed");
          assert.deepEqual(output.message.details.acceptedBatch.legs.map((leg: any) => leg.axis), ["standards", "spec"]);
          assert.equal(output.message.details.reports.standards.text, "Standards finding count: 0.");
          assert.equal(output.message.details.reports.spec.text, "Spec: fixed target satisfies the stated behavior.");
          assert.equal(faux.getPendingResponseCount(), 0);
        });
      });
    });
  });
});
