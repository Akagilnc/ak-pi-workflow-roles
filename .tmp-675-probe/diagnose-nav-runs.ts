import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, type Context,
} from "@earendil-works/pi-ai";
import { NAVIGATOR_PREPARE_TOOL_NAME, JUDGE_OUTPUT_TOOL_NAME, NOTARY_OUTPUT_TOOL } from "../src/role-runtime.ts";
import { installHermesFixture } from "../test/helpers/hermes-fixture.ts";
import { packageRoot, seedGitRepository, withAgentDirProviderFixture, withInProcessPi } from "../test/helpers/pi-test-harness.ts";

const SCRATCH = dirname(fileURLToPath(import.meta.url));
function seedGitProject(root: string): void {
  seedGitRepository(root);
  try { execFileSync("git", ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"], { cwd: root }); } catch {}
}

const home = await mkdtemp(join(SCRATCH, "diag-"));
const project = join(home, "project");
await mkdir(project, { recursive: true });
seedGitProject(project);
const issueRoot = join(project, ".ak/work/issues/675");
await mkdir(issueRoot, { recursive: true });
await writeFile(join(issueRoot, "authority.md"), "owner authority\n", "utf8");
const binDir = join(home, "bin");
await mkdir(binDir, { recursive: true });
await installHermesFixture(binDir);
const priorPath = process.env.PATH;
process.env.PATH = `${binDir}:${priorPath ?? ""}`;
const agentDir = join(home, ".pi-agent");
await mkdir(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = home;

const faux = fauxProvider({ api: "openai-responses", provider: "ak-probe-offline", tokenSize: { min: 1000, max: 1000 } });
const model = faux.getModel();
assert.ok(model);
const { savePublicCliConfig } = await import("../src/public-cli/config.ts");
const seat = { provider: model.provider, model: model.id! };
await savePublicCliConfig({ seats: { navigator: seat, judge: seat, notary: seat, inspector: seat, auditor: seat } }, home);

const hits: string[] = [];
const response = (context: Context, _o: unknown, _s: unknown, rm: { provider: string; id: string }) => {
  const names = context.tools?.map((t) => t.name) ?? [];
  const label = names.find((n) => n.startsWith("ak_")) ?? "none";
  hits.push(`${rm.provider}/${rm.id}:${label}`);
  if (names.includes(NOTARY_OUTPUT_TOOL)) return fauxAssistantMessage(fauxToolCall(NOTARY_OUTPUT_TOOL, { status: "pass", findings: [] }), { stopReason: "toolUse" });
  if (names.includes("ak_navigator_output")) {
    return fauxAssistantMessage(fauxToolCall("ak_navigator_output", { status: "advice", candidates: [{
      id: "r", matches: { role: "judge", phase: null, kind: "accepted" },
      route: [{ role: "judge", phase: null }], next: { role: "reviewer", phase: null }, reason: "p", command: "ak-role reviewer",
    }] }), { stopReason: "toolUse" });
  }
  if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
    return fauxAssistantMessage(fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, { candidates: [{
      id: "r", matches: { role: "judge", phase: null, kind: "accepted" },
      route: [{ role: "judge", phase: null }], next: { role: "reviewer", phase: null }, reason: "p", command: "ak-role reviewer",
    }] }), { stopReason: "toolUse" });
  }
  if (names.includes("ak_auditor_output") || names.includes("ak_soul_audit")) {
    const t = names.includes("ak_auditor_output") ? "ak_auditor_output" : "ak_soul_audit";
    return fauxAssistantMessage(fauxToolCall(t, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" });
  }
  if (names.includes(JUDGE_OUTPUT_TOOL_NAME)) return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }), { stopReason: "toolUse" });
  return fauxAssistantMessage("idle", { stopReason: "stop" });
};
faux.setResponses(Array.from({ length: 40 }, () => response));

let attendance: unknown;
await withAgentDirProviderFixture(faux, agentDir, async () => {
  await withInProcessPi({
    activationLedgerSession: true, cwd: issueRoot, agentDir, faux, model, modelsPath: null,
    additionalExtensionPaths: [join(packageRoot, "extensions/role-runtime.ts")],
    systemPrompt: "DIAG", mode: "json", flags: { "ak-role": "judge" }, noTools: "builtin",
  }, async ({ session, sessionManager }) => {
    await session.prompt("diag attendance");
    attendance = sessionManager.getEntries().find((e) => e.type === "custom_message" && e.customType === "ak-navigator-attendance");
  });
});

const booksRoot = join(home, ".ak-roles", "books");
const books = await readdir(booksRoot);
const runInfo = [];
for (const b of books) {
  const runsDir = join(booksRoot, b, "runs");
  for (const entry of await readdir(runsDir)) {
    const runDir = join(runsDir, entry);
    const ticket = await readFile(join(runDir, "ticket-number"), "utf8").catch(() => null);
    const state = await readFile(join(runDir, "run-state.json"), "utf8").catch(() => null);
    const terminal = await readFile(join(runDir, "terminal.json"), "utf8").catch(() => null);
    const stderr = await readFile(join(runDir, "stderr.log"), "utf8").catch(() => null);
    const inv = await readFile(join(runDir, "invocation.json"), "utf8").catch(() => null);
    runInfo.push({
      entry,
      ticket: ticket?.trim() ?? null,
      state: state ? JSON.parse(state) : null,
      terminalKind: terminal ? (JSON.parse(terminal) as { roleOutcome?: { kind?: string; diagnostic?: string; cause?: string; decisiveFacts?: unknown } }).roleOutcome : null,
      inv: inv ? JSON.parse(inv) : null,
      stderrTail: stderr?.slice(-500) ?? null,
    });
  }
}

console.log(JSON.stringify({ hits, attendance, runInfo }, null, 2));
await rm(home, { recursive: true, force: true });
if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
