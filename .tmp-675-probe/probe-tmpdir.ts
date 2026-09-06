import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, type Context,
} from "@earendil-works/pi-ai";
import type { RoleTurnHost, RoleTurnRequest } from "../src/host-contracts.ts";
import { NAVIGATOR_OUTPUT_TOOL_NAME } from "../src/package-contracts/navigator-output.ts";
import { piDurablePrincipalAuthority } from "../src/pi/durable-principal.ts";
import { runAkRole } from "../src/public-cli/cli.ts";
import { JUDGE_OUTPUT_TOOL_NAME, NAVIGATOR_PREPARE_TOOL_NAME, NOTARY_OUTPUT_TOOL } from "../src/role-runtime.ts";
import { installHermesFixture } from "../test/helpers/hermes-fixture.ts";
import { packageRoot, seedGitRepository, withAgentDirProviderFixture, withInProcessPi } from "../test/helpers/pi-test-harness.ts";
import { roleTurnHostFromLegacyPiRunner, scriptedTerminatingToolSession } from "../test/helpers/role-turn-host-fixture.ts";

function seedGitProject(root: string) {
  seedGitRepository(root);
  try { execFileSync("git", ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"], { cwd: root }); } catch {}
}
function runIdFromDirectory(runDirectory: string) {
  const base = runDirectory.split(/[\\/]/).pop() ?? "";
  const at = base.indexOf("@");
  return at === -1 ? base : base.slice(0, at);
}
async function listRuns(home: string) {
  const booksRoot = join(home, ".ak-roles", "books");
  const out = [];
  for (const b of await readdir(booksRoot).catch(() => [] as string[])) {
    for (const entry of await readdir(join(booksRoot, b, "runs")).catch(() => [] as string[])) {
      const runDir = join(booksRoot, b, "runs", entry);
      const ticket = await readFile(join(runDir, "ticket-number"), "utf8").catch(() => null);
      out.push({ entry, ticket: ticket?.trim() ?? null, role: entry.split("@").pop() });
    }
  }
  return out;
}

// ===== A: navigator instruction seat with ticket 675 =====
async function probeA() {
  const home = await mkdtemp(join(tmpdir(), "ak675-nav-"));
  const project = join(home, "project");
  await mkdir(project, { recursive: true });
  seedGitProject(project);
  const issueRoot = join(project, ".ak/work/issues/675");
  await mkdir(issueRoot, { recursive: true });
  await writeFile(join(issueRoot, "authority.md"), "owner\n", "utf8");
  const binDir = join(home, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "package.json"), '{"type":"commonjs"}\n', "utf8");
  await installHermesFixture(binDir, { resolverResponse: { assertion: "ticket", ticketNumber: 675 } });
  const priorPath = process.env.PATH;
  process.env.PATH = `${binDir}:${priorPath ?? ""}`;
  const io = { stdout() {}, stderr() {} };
  const credentials = { "openai-codex": true, xai: true } as const;
  await runAkRole(["config", "set", "navigator", "faux/nav-model:high"], { home, packageRoot, io });
  type Seen = { kind: string; runId: string; model?: string; thinking?: string; courtAttemptId?: string; same: boolean };
  const seen: Seen[] = [];
  let firstDir: string | undefined;
  let turn = 0;
  const candidates = [{ id: "r", matches: { role: "judge", phase: null, kind: "accepted" }, route: [{ role: "judge", phase: null }], next: { role: "reviewer", phase: null }, reason: "p", command: "c" }];
  const host: RoleTurnHost = {
    executeTurn: async (request) => {
      turn += 1;
      if (firstDir === undefined) firstDir = request.runDirectory;
      seen.push({
        kind: request.continuation.kind,
        runId: runIdFromDirectory(request.runDirectory),
        model: request.model?.model,
        thinking: request.model?.thinking,
        courtAttemptId: request.courtAttemptId,
        same: request.runDirectory === firstDir,
      });
      return roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: scriptedTerminatingToolSession({
          role: "navigator",
          toolName: NAVIGATOR_OUTPUT_TOOL_NAME,
          details: { status: "advice", candidates },
        }),
      }).executeTurn(request);
    },
  };
  try {
    const first = await runAkRole(["navigator", "route for #675"], { home, packageRoot, cwd: issueRoot, credentials, io, roleTurnHost: host, createRunId: () => "01a067500-0000-7000-8000-00000000a001" });
    await runAkRole(["config", "set", "navigator", "faux/live-nav:low"], { home, packageRoot, io });
    const second = await runAkRole(["navigator", "route for #675 again"], { home, packageRoot, cwd: issueRoot, credentials, io, roleTurnHost: host, createRunId: () => "01a067500-0000-7000-8000-00000000a002" });
    const runId = seen[0]?.runId;
    const resumed = runId ? await runAkRole(["resume", runId], { home, packageRoot, cwd: issueRoot, credentials, io, roleTurnHost: host }) : undefined;
    const runs = await listRuns(home);
    return {
      probe: "A-navigator-ticket-675",
      exits: { first: first.exitCode, second: second.exitCode, resume: resumed?.exitCode },
      kinds: { first: first.terminal?.roleOutcome?.kind, second: second.terminal?.roleOutcome?.kind, resume: resumed?.terminal?.roleOutcome?.kind },
      turn, seen, runs,
    };
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    await rm(home, { recursive: true, force: true });
  }
}

// ===== B: judge + navigator attendance under true-unbound hermes (package test face) =====
async function probeB() {
  const home = await mkdtemp(join(tmpdir(), "ak675-jdg-"));
  const project = join(home, "project");
  await mkdir(project, { recursive: true });
  seedGitProject(project);
  const issueRoot = join(project, ".ak/work/issues/28");
  await mkdir(issueRoot, { recursive: true });
  await writeFile(join(issueRoot, "authority.md"), "owner\n", "utf8");
  const binDir = join(home, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "package.json"), '{"type":"commonjs"}\n', "utf8");
  await installHermesFixture(binDir); // true-unbound default
  const priorPath = process.env.PATH;
  process.env.PATH = `${binDir}:${priorPath ?? ""}`;
  const agentDir = join(home, ".pi-agent");
  await mkdir(agentDir, { recursive: true });
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  const prevHome = process.env.HOME;
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
    const label = names.find((n) => n.startsWith("ak_")) ?? "?";
    hits.push(`${rm.provider}/${rm.id}:${label}`);
    if (names.includes(NOTARY_OUTPUT_TOOL)) return fauxAssistantMessage(fauxToolCall(NOTARY_OUTPUT_TOOL, { status: "pass", findings: [] }), { stopReason: "toolUse" });
    if (names.includes("ak_navigator_output") || names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
      const tool = names.includes("ak_navigator_output") ? "ak_navigator_output" : NAVIGATOR_PREPARE_TOOL_NAME;
      const candidates = [{ id: "r", matches: { role: "judge", phase: null, kind: "accepted" }, route: [{ role: "judge", phase: null }, { role: "reviewer", phase: null }], next: { role: "reviewer", phase: null }, reason: "p", command: "ak-role reviewer" }];
      return fauxAssistantMessage(fauxToolCall(tool, tool === "ak_navigator_output" ? { status: "advice", candidates } : { candidates }), { stopReason: "toolUse" });
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
  try {
    await withAgentDirProviderFixture(faux, agentDir, async () => {
      await withInProcessPi({
        activationLedgerSession: true, cwd: issueRoot, agentDir, faux, model, modelsPath: null,
        additionalExtensionPaths: [join(packageRoot, "extensions/role-runtime.ts")],
        systemPrompt: "B", mode: "json", flags: { "ak-role": "judge" }, noTools: "builtin",
      }, async ({ session, sessionManager }) => {
        await session.prompt("ordinary");
        attendance = sessionManager.getEntries().find((e) => e.type === "custom_message" && e.customType === "ak-navigator-attendance");
      });
    });
    const runs = await listRuns(home);
    const details = (attendance as { details?: Record<string, unknown> } | undefined)?.details;
    return {
      probe: "B-judge-nav-true-unbound",
      disposition: details?.disposition,
      unavailableSource: details?.unavailableSource,
      hits,
      navHits: hits.filter((h) => h.includes("navigator")).length,
      runs,
      roleCounts: runs.reduce((acc: Record<string, number>, r) => { acc[r.role!] = (acc[r.role!] ?? 0) + 1; return acc; }, {}),
    };
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevAgent;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
}

// ===== C: same as B but with ticket binding hermes =====
async function probeC() {
  const home = await mkdtemp(join(tmpdir(), "ak675-tk-"));
  const project = join(home, "project");
  await mkdir(project, { recursive: true });
  seedGitProject(project);
  const issueRoot = join(project, ".ak/work/issues/675");
  await mkdir(issueRoot, { recursive: true });
  await writeFile(join(issueRoot, "authority.md"), "owner\n", "utf8");
  const binDir = join(home, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "package.json"), '{"type":"commonjs"}\n', "utf8");
  await installHermesFixture(binDir, { resolverResponse: { assertion: "ticket", ticketNumber: 675 } });
  const priorPath = process.env.PATH;
  process.env.PATH = `${binDir}:${priorPath ?? ""}`;
  const agentDir = join(home, ".pi-agent");
  await mkdir(agentDir, { recursive: true });
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  const prevHome = process.env.HOME;
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
    const label = names.find((n) => n.startsWith("ak_")) ?? "?";
    hits.push(`${rm.provider}/${rm.id}:${label}`);
    if (names.includes(NOTARY_OUTPUT_TOOL)) return fauxAssistantMessage(fauxToolCall(NOTARY_OUTPUT_TOOL, { status: "pass", findings: [] }), { stopReason: "toolUse" });
    if (names.includes("ak_navigator_output") || names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
      const tool = names.includes("ak_navigator_output") ? "ak_navigator_output" : NAVIGATOR_PREPARE_TOOL_NAME;
      const candidates = [{ id: "r", matches: { role: "judge", phase: null, kind: "accepted" }, route: [{ role: "judge", phase: null }, { role: "reviewer", phase: null }], next: { role: "reviewer", phase: null }, reason: "p", command: "ak-role reviewer" }];
      return fauxAssistantMessage(fauxToolCall(tool, tool === "ak_navigator_output" ? { status: "advice", candidates } : { candidates }), { stopReason: "toolUse" });
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
  try {
    await withAgentDirProviderFixture(faux, agentDir, async () => {
      await withInProcessPi({
        activationLedgerSession: true, cwd: issueRoot, agentDir, faux, model, modelsPath: null,
        additionalExtensionPaths: [join(packageRoot, "extensions/role-runtime.ts")],
        systemPrompt: "C", mode: "json", flags: { "ak-role": "judge" }, noTools: "builtin",
      }, async ({ session, sessionManager }) => {
        await session.prompt("ticketed ordinary");
        attendance = sessionManager.getEntries().find((e) => e.type === "custom_message" && e.customType === "ak-navigator-attendance");
      });
    });
    const runs = await listRuns(home);
    const details = (attendance as { details?: Record<string, unknown> } | undefined)?.details;
    return {
      probe: "C-judge-nav-ticket-675",
      disposition: details?.disposition,
      unavailableSource: details?.unavailableSource,
      hits,
      navHits: hits.filter((h) => h.includes("navigator")).length,
      runs,
      roleCounts: runs.reduce((acc: Record<string, number>, r) => { acc[r.role!] = (acc[r.role!] ?? 0) + 1; return acc; }, {}),
    };
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevAgent;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
}

const out = [];
for (const p of [probeA, probeB, probeC]) {
  try { out.push(await p()); }
  catch (e) { out.push({ error: String(e), stack: (e as Error).stack?.split("\n").slice(0, 8) }); }
}
console.log(JSON.stringify(out, null, 2));
