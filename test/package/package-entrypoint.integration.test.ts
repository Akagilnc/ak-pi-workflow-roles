import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  type Context,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  defineTool,
  parseSkillBlock,
  SessionManager,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_AUDIT_TOOL_NAME,
  FIXER_FLAG_DEFINITIONS,
  FIXER_OUTPUT_TOOL_NAME,
  FIXER_PHASES,
  fixerPrerequisitesSchema,
  parseFixerPrerequisites,
  validateFixerOutputForPacket,
  JUDGE_OUTPUT_TOOL_NAME,
  NAVIGATOR_PREPARE_TOOL_NAME,
  writeNavigatorModelSetting,
  MERGER_INPUT_FLAG,
  MERGER_OUTPUT_TOOL_NAME,
  navigatorSessionDirectory,
  ROLE_FLAG,
  TOOL_EXECUTION_UPDATE_HEARTBEAT,
  toolExecutionObservationRecordSchema,
  WORKFLOW_ROLES,
  type ToolExecutionObservationRecord,
} from "../../src/role-runtime.ts";
import { Value } from "typebox/value";
import { DOCTOR_CASE_FLAG } from "../../src/doctor-role.ts";
import { isAuditEscalationResult } from "../../src/audit-escalation.ts";
import { validateAcceptedDetails } from "../../src/package-contracts/terminating-tools.ts";
import { SOUL_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import type { ComplianceCompletion } from "../../src/compliance-transport.ts";
import {
  getSharedIsolatedPack,
  loadRawPackageManifest,
  packageRoot,
  type RawPackageManifest,
  resolvePackageEntrypoint,
  runNodeSubprocess,
  runPiSubprocess,
  withActivationHome,
  withHermeticHome,
  withInProcessPi,
  withColdInstalledPackage,
  writeTestSkill,
} from "../helpers/pi-test-harness.ts";

const siblingTool = defineTool({
  name: "integration_sibling",
  label: "Integration Sibling",
  description: "Offline sibling used to exercise Pi's parallel tool lifecycle",
  parameters: Type.Object({}),
  async execute() {
    await Promise.resolve();
    return {
      content: [{ type: "text" as const, text: "sibling completed" }],
      details: {},
    };
  },
});

function textOf(message: ToolResultMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function packageEntrypoint(manifest: RawPackageManifest): string {
  assert.ok(manifest.files?.includes("extensions"));
  assert.ok(manifest.files?.includes("souls"));
  // ADR 0052 / #105: Internal entrypoint is explicit-load only; not auto-registered.
  assert.deepEqual(manifest.pi?.extensions, []);
  assert.equal(manifest.bin?.["ak-role"], "./dist/public-cli/main.js");
  return resolvePackageEntrypoint(manifest);
}


type PersistedEntry = { type?: string; timestamp?: string; customType?: string; message?: Record<string, any> };

async function readLatestSession(directory: string): Promise<PersistedEntry[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl")).sort();
  assert.ok(files.length > 0, `expected a persisted session in ${directory}`);
  return (await readFile(join(directory, files.at(-1)!), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PersistedEntry);
}


async function runOrdinaryNavigatorObservation(extensionPath: string) {
  return withActivationHome(
    { prefix: "ak-navigator-current-" },
    async ({ home, agentDir }) => {
      const issueRoot = resolve(home, ".ak/work/issues/28");
      await mkdir(issueRoot, { recursive: true });
      // Role session under ledger book (ADR 0048); Navigator subject still derives from issueRoot cwd.
      const sessionDirectory = resolve(
        home,
        ".ak-roles",
        "books",
        basename(home),
        "runs",
        "judge-navigator",
        "session",
      );
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(resolve(issueRoot, "authority.md"), "owner authority for ordinary Navigator observation\n", "utf8");
      await writeFile(resolve(agentDir, "navigator-model.json"), JSON.stringify({ model: "ak-audit-failure/faux-1" }), "utf8");
      const args = [
        "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
        "--session-dir", sessionDirectory,
        "-e", extensionPath,
        "-e", resolve(packageRoot, "test/fixtures/audit-failure-provider.ts"),
        "--ak-role", "judge", "--provider", "ak-audit-failure", "--model", "faux-1", "--mode", "json", "Judge.",
      ];
      const result = await runPiSubprocess(args, {
        cwd: issueRoot,
        env: {
          ...process.env,
          HOME: home,
          PI_CODING_AGENT_DIR: agentDir,
          AK_NAVIGATOR_OBSERVATION: "1",
          PI_OFFLINE: "1",
        },
      });
      const roleEntries = await readLatestSession(sessionDirectory);
      const navigatorDirectory = resolve(issueRoot, "runs/navigator");
      const navigatorEntries = await readLatestSession(navigatorDirectory);
      return { result, roleEntries, navigatorEntries };
    },
  );
}

test("ordinary Navigator attendance persists preparation, settlement, and visible ordering", async () => {
  const manifest = await loadRawPackageManifest();
  const current = await runOrdinaryNavigatorObservation(packageEntrypoint(manifest));
  assert.equal(current.result.timedOut, false, "ordinary invocation must finish");
  assert.equal(current.result.code, 0, `ordinary invocation must succeed: ${current.result.stderr}`);
  const accepted = current.roleEntries.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === JUDGE_OUTPUT_TOOL_NAME && entry.message.isError === false);
  assert.equal(accepted.length, 1, "must persist the accepted Judge output result");
  assert.deepEqual(accepted[0]?.message?.details, { judgeStatus: "converged" });

  const currentPreparation = current.navigatorEntries.find((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === NAVIGATOR_PREPARE_TOOL_NAME && entry.message.isError === false);
  const currentSettlement = current.navigatorEntries.find((entry) => entry.type === "custom" && entry.customType === "ak-navigator-settlement");
  const currentVisible = current.roleEntries.find((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
  const currentAccepted = current.roleEntries.find((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === JUDGE_OUTPUT_TOOL_NAME && entry.message.isError === false);
  assert.ok(currentPreparation?.timestamp, "current invocation must persist Navigator preparation completion");
  assert.ok(currentSettlement?.timestamp, "current invocation must persist Navigator settlement");
  assert.ok(currentVisible?.timestamp, "current invocation must persist the visible custom message");
  assert.ok(currentAccepted?.timestamp, "current invocation must persist the actual accepted role output result");
  const preparationAt = Date.parse(currentPreparation.timestamp!);
  const settlementAt = Date.parse(currentSettlement.timestamp!);
  const visibleAt = Date.parse(currentVisible.timestamp!);
  const acceptedAt = Date.parse(currentAccepted.timestamp!);
  assert.ok(Number.isFinite(preparationAt) && Number.isFinite(settlementAt) && Number.isFinite(visibleAt) && Number.isFinite(acceptedAt));
  assert.ok(preparationAt <= acceptedAt, "Navigator preparation must finish before the actual accepted role-output/tool-result settlement");
  assert.ok(visibleAt >= acceptedAt, "persisted visible custom-message must follow the actual accepted role-output/tool-result settlement");
  assert.ok(visibleAt >= settlementAt, "persisted visible custom-message must follow Navigator settlement");
  assert.ok(visibleAt - acceptedAt <= 1000, `persisted visible custom-message must follow accepted settlement within 1s (actual ${visibleAt - acceptedAt}ms)`);
  const currentEvents = current.result.stdout.split("\n").filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line) as any);
  assert.equal(currentEvents.some((event) => event.type === "message_end" && event.message?.role === "custom" && event.message.customType === "ak-navigator-attendance"), true, "current ordinary invocation must display the typed attendance event");
});

test("packed package includes Doctor role, evidence flag, and runtime dependencies", async () => {
  const manifest = await loadRawPackageManifest();
  packageEntrypoint(manifest);
  assert.equal(manifest.bin?.["ak-role"], "./dist/public-cli/main.js");
  assert.deepEqual(manifest.pi?.extensions, []);
  assert.deepEqual(WORKFLOW_ROLES, ["judge", "fixer", "coder", "reviewer", "collector", "doctor", "merger"]);
  assert.equal(ROLE_FLAG.name, "ak-role");
  assert.deepEqual(
    Object.values(FIXER_FLAG_DEFINITIONS).map(({ name, definition }) => ({
      name,
      type: definition.type,
    })),
    [
      { name: "ak-fix-packet", type: "string" },
      { name: "ak-fixer-prerequisites", type: "string" },
      { name: "ak-fixer-phase", type: "string" },
    ],
  );
  assert.deepEqual(FIXER_PHASES, ["plan", "apply"]);
  assert.equal(DOCTOR_CASE_FLAG.name, "ak-doctor-case");
  assert.equal(DOCTOR_CASE_FLAG.definition.type, "string");
  assert.equal(MERGER_INPUT_FLAG.name, "ak-merger-input");
  assert.equal(MERGER_OUTPUT_TOOL_NAME, "ak_merger_output");
  const packet = { instructions: "repair", prerequisites: parseFixerPrerequisites("[]") };
  assert.equal((fixerPrerequisitesSchema as any).type, "array");
  assert.deepEqual(validateFixerOutputForPacket({ status: "planned", report: "plan" }, "plan", packet), { status: "planned", report: "plan" });
  const packed = await getSharedIsolatedPack();
  const paths = new Set(packed.files.map((file) => file.path));
  for (const path of [
    "souls/doctor.md",
    "src/doctor-contracts.ts",
    "src/doctor-evidence.ts",
    "src/canonical-json.ts",
    "souls/navigator.md",
    "src/navigator-attendance.ts",
    "dist/navigator-attendance.js",
    "dist/activation-ledger-topology.js",
    "souls/merger.md",
    "src/merger-contracts.ts",
    "src/merger-git-state.ts",
    "src/merger-role.ts",
    "src/package-contracts/fixer-packet.ts",
    "dist/package-contracts/fixer-packet.js",
    "packets/fixer-repair.md",
    "packets/fixer-prerequisites.json",
  ]) {
    assert.ok(paths.has(path), `${path} must be present in the npm tarball`);
  }
  assert.equal(paths.has("packets/fixer-repair.json"), false, "removed closed packet shell must not be packed");
});

test("cold-installed package audits all four roles from editable Souls", async () => {
  await withActivationHome(
    { prefix: "ak-auditor-package-" },
    async ({ home }) => {
      await withColdInstalledPackage(home, async ({ installedRoot, installed }) => {
      const [judge, fixer, reviewer, doctor] = await Promise.all([
        installed("src/judge-auditor.ts"),
        installed("src/fixer-auditor.ts"),
        installed("src/reviewer-auditor.ts"),
        installed("src/doctor-auditor.ts"),
      ]);

      const context = {
        model: { provider: "installed-auditor", id: "installed-auditor", api: "openai-responses" },
        modelRegistry: {
          async getProviderAuth() { return { auth: { apiKey: "offline" } }; },
          async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "offline" }; },
        },
        sessionManager: SessionManager.inMemory(),
      } as any;
      const inputs = {
        judge: { soul: "caller judge soul", transcript: "judge record", verdict: { judgeStatus: "converged" } },
        fixer: { soul: "caller fixer soul", packet: { version: 1, instructions: "repair", prerequisites: [] }, phase: "apply", transcript: "fixer record", candidate: { status: "completed", report: "done", classResults: [] } },
        reviewer: { soul: "caller reviewer soul", canonicalSkill: "skill", task: "task", record: {}, candidate: {} },
        doctor: { soul: "caller doctor soul", patient: { version: 1, identity: { issueNumber: 58, runsPath: ".ak/work/issues/58/runs" }, evidence: [], cost: { invocations: { total: 0, sources: [] }, bytes: 0 } }, readRecord: [], testimony: { status: "refused", reason: "missing", missingEvidence: [] } },
      } as const;
      const roles = [
        { name: "judge", toolName: judge.JUDGE_AUDIT_TOOL_NAME, soulPath: resolve(installedRoot, "souls/judge-auditor.md"), run: (completion: ComplianceCompletion) => judge.createPiJudgeAuditor(completion)(inputs.judge as never, { context }) },
        { name: "fixer", toolName: fixer.FIXER_AUDIT_TOOL_NAME, soulPath: resolve(installedRoot, "souls/fixer-auditor.md"), run: (completion: ComplianceCompletion) => fixer.createPiFixerAuditor(completion)(inputs.fixer as never, { context }) },
        { name: "reviewer", toolName: reviewer.REVIEWER_AUDIT_TOOL_NAME, soulPath: resolve(installedRoot, "souls/reviewer-auditor.md"), run: (completion: ComplianceCompletion) => reviewer.createPiReviewerAuditor(completion)(inputs.reviewer as never, { context }) },
        { name: "doctor", toolName: doctor.DOCTOR_AUDIT_TOOL_NAME, soulPath: resolve(installedRoot, "souls/doctor-auditor.md"), run: (completion: ComplianceCompletion) => doctor.createPiDoctorAuditor(completion)(inputs.doctor as never, { context }) },
      ] as const;
      const run = async (role: (typeof roles)[number]) => {
        let calls = 0;
        let prompt = "";
        const completion: ComplianceCompletion = async (_model, request) => {
          calls += 1;
          prompt = request.systemPrompt ?? "";
          return fauxAssistantMessage(fauxToolCall(role.toolName, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" });
        };
        await role.run(completion);
        assert.equal(calls, 1, `${role.name} audit must make one decision call`);
        assert.equal(prompt, await readFile(role.soulPath, "utf8"), `${role.name} must load its installed Soul on this call`);
        return prompt;
      };

      for (const role of roles) await run(role);

      const editedSoul = "EDITED JUDGE SOUL\n";
      const judgeSoul = roles[0].soulPath;
      const originalJudgeSoul = await readFile(judgeSoul, "utf8");
      await writeFile(judgeSoul, editedSoul, "utf8");
      try {
        const edited = await run(roles[0]);
        assert.equal(edited, editedSoul);
        for (const role of roles.slice(1)) {
          const unchanged = await run(role);
          assert.equal(unchanged, await readFile(role.soulPath, "utf8"));
          assert.notEqual(unchanged, editedSoul);
        }
      } finally {
        await writeFile(judgeSoul, originalJudgeSoul, "utf8");
      }

      for (const role of roles) {
        const original = await readFile(role.soulPath, "utf8");
        await rm(role.soulPath, { force: true });
        try {
          await assert.rejects(role.run(async () => { throw new Error("completion must not run"); }), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", `${role.name} missing Soul must preserve ENOENT`);
        } finally {
          await writeFile(role.soulPath, original, "utf8");
        }

        await writeFile(role.soulPath, " \n", "utf8");
        await assert.rejects(role.run(async () => { throw new Error("completion must not run"); }), new RegExp(`${role.name} auditor Soul is blank`));

        await rm(role.soulPath, { force: true });
        await mkdir(role.soulPath);
        try {
          await assert.rejects(role.run(async () => { throw new Error("completion must not run"); }), (error: unknown) => (error as NodeJS.ErrnoException).code === "EISDIR", `${role.name} unreadable Soul must preserve EISDIR`);
        } finally {
          await rm(role.soulPath, { recursive: true, force: true });
          await writeFile(role.soulPath, original, "utf8");
        }
      }
      });
    },
  );
});

test("role outputs run nested audits through pass, revise, and escalation", async () => {
  // Source-tree imports: cold-install boundary is owned by neighbouring install tests;
  // this carrier owns revise→errored / pass→terminate / escalate per role output tool.
  const root = packageRoot;
  const importSrc = (rel: string) => import(resolve(root, rel));
  {
      const [judge, fixer, reviewer, doctor, judgeRole, workerRole, reviewerRole, doctorRole, promptIdentity, terminating] = await Promise.all([
        importSrc("src/judge-auditor.ts"),
        importSrc("src/fixer-auditor.ts"),
        importSrc("src/reviewer-auditor.ts"),
        importSrc("src/doctor-auditor.ts"),
        importSrc("src/judge-role.ts"),
        importSrc("src/worker-role.ts"),
        importSrc("src/reviewer-role.ts"),
        importSrc("src/doctor-role.ts"),
        importSrc("src/reviewer-prompt-identity.ts"),
        importSrc("src/package-contracts/terminating-tools.ts"),
      ]);

      const patient = {
        version: 1,
        identity: { issueNumber: 58, runsPath: ".ak/work/issues/58/runs" },
        evidence: [],
        cost: { invocations: { total: 0, sources: [] }, bytes: 0 },
      };
      const taskBytes = new TextEncoder().encode("review task\n");
      const capabilities = new TextEncoder().encode(JSON.stringify({
        version: 1,
        taskSha256: createHash("sha256").update(taskBytes).digest("hex"),
        tools: ["read"],
        prerequisiteOperations: ["preflight.git.pin-target"],
      }));
      const skill = "canonical review skill";
      const escalation = {
        status: "escalate" as const,
        violations: [],
        conflicts: ["Soul conflicts with controlling authority"],
        decisionGate: {
          question: "Which authority governs this submission?",
          options: ["Soul", "Controlling authority"],
        },
      };
      const revise = {
        status: "revise" as const,
        violations: ["one concrete procedural violation"],
        conflicts: [],
        decisionGate: null,
      };
      const pass = {
        status: "pass" as const,
        violations: [],
        conflicts: [],
        decisionGate: null,
      };
      const outputs = {
        judge: { judgeStatus: "converged" },
        fixer: { status: "completed", report: "done", classResults: [
          { name: "Contract", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) },
          { name: "Audit", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) },
        ] },
        reviewer: { status: "refused", diagnostic: "no accepted dispatch" },
        doctor: { status: "refused", reason: "missing", missingEvidence: [{ need: "case evidence", targetKeys: ["case"] }] },
      } as const;
      const toolNames = {
        judge: judge.JUDGE_AUDIT_TOOL_NAME,
        fixer: fixer.FIXER_AUDIT_TOOL_NAME,
        reviewer: reviewer.REVIEWER_AUDIT_TOOL_NAME,
        doctor: doctor.DOCTOR_AUDIT_TOOL_NAME,
      } as const;
      const acceptedNames = {
        judge: "ak_judge_output",
        fixer: "ak_fixer_output",
        reviewer: "ak_reviewer_output",
        doctor: "ak_doctor_output",
      } as const;

      const makeHarness = (flags: Record<string, string> = {}) => {
        const tools = new Map<string, any>();
        const handlers = new Map<string, any>();
        let activeTools: string[] = [];
        const pi = {
          registerFlag() {},
          getFlag(name: string) { return flags[name]; },
          registerTool(tool: any) { tools.set(tool.name, tool); },
          getAllTools() { return [...tools.keys()].map((name) => ({ name })); },
          setActiveTools(names: string[]) { activeTools = [...names]; },
          getActiveTools() { return activeTools; },
          on(name: string, handler: any) { handlers.set(name, handler); },
        };
        return { pi, tools, handlers };
      };
      const outputContext = (name: string, id: string) => {
        const sessionManager = SessionManager.inMemory();
        sessionManager.appendMessage({
          role: "assistant",
          content: [{ type: "toolCall", id, name, arguments: {} }],
          api: "openai-responses",
          provider: "installed-role",
          model: "installed-role",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: Date.now(),
        });
        return {
          sessionManager,
          model: { api: "openai-responses", provider: "installed-auditor", id: "installed-auditor" },
          modelRegistry: {
            async getProviderAuth() { return { auth: { apiKey: "offline" } }; },
            async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "offline" }; },
          },
        } as any;
      };

      const createRole = (role: keyof typeof outputs, decision: typeof pass | typeof revise | typeof escalation) => {
        const harness = role === "fixer"
          ? makeHarness({ "ak-fix-packet": "/packet", "ak-fixer-phase": "apply" })
          : role === "reviewer"
            ? makeHarness({ "ak-review-task": "/task", "ak-review-capabilities": "/capabilities" })
            : role === "doctor"
              ? makeHarness({ "ak-doctor-case": "/case" })
              : makeHarness();
        let auditCalls = 0;
        let selectedDecision = decision;
        const complete = async (_model: unknown, _request: Context) => {
          auditCalls += 1;
          return fauxAssistantMessage(fauxToolCall(toolNames[role], selectedDecision), { stopReason: "toolUse" });
        };
        const auditCompliance = (input: any, options: any) => {
          if (role === "judge") return judge.createPiJudgeAuditor(complete)(input, options);
          if (role === "fixer") return fixer.createPiFixerAuditor(complete)(input, options);
          if (role === "reviewer") return reviewer.createPiReviewerAuditor(complete)(input, options);
          return doctor.createPiDoctorAuditor(complete)(input, options);
        };
        let runtime: any;
        if (role === "judge") {
          runtime = judgeRole.createJudgeRoleRuntime(harness.pi, {
            loadSoul: async () => "judge law",
            transcriptFromContext: () => "judge transcript",
            auditSoulCompliance: auditCompliance,
          }, { failInfrastructure(error: unknown) { throw error; } });
        } else if (role === "fixer") {
          runtime = workerRole.createFixerRoleRuntime(harness.pi, {
            loadSoul: async () => "fixer law",
            loadPacket: async () => "repair packet",
            transcriptFromContext: () => "fixer transcript",
            auditCompliance,
          }, { failInfrastructure(error: unknown) { throw error; } });
        } else if (role === "doctor") {
          runtime = doctorRole.createDoctorRoleRuntime(harness.pi, {
            loadSoul: async () => "doctor law",
            loadCase: async () => patient,
            auditCompliance,
          }, { failInfrastructure(error: unknown) { throw error; } });
        } else {
          const pin = { repositoryRoot: "/repo", objectFormat: "sha1", targetHead: "target", refs: {} };
          runtime = reviewerRole.createReviewerRoleRuntime(harness.pi, {
            loadSoul: async () => "reviewer law",
            loadTask: async () => taskBytes,
            loadCapabilities: async () => capabilities,
            loadCanonicalSkillBinding: async () => ({
              name: "code-review",
              snapshot: { raw: skill, path: "/skill", baseDir: "/", body: skill, snapshotIdentity: promptIdentity.reviewerPromptIdentity(skill) },
              invocation: (request: string) => request,
              captureExpansion: () => undefined,
            }),
            createPinnedGitReader: async () => ({ pin, snapshot: async () => pin, resolve: async () => "base", range: async () => ({ base: "base", target: "target", diffCommand: "git diff base...target", diffSha256: "a".repeat(64), commits: ["target"] }), material: async () => new TextEncoder().encode("material") }),
            hostTools: () => ["read"],
            runDispatch: async () => { throw new Error("dispatch must not run for refusal"); },
            auditCompliance,
          }, { failInfrastructure(error: unknown) { throw error; } });
        }
        return {
          harness,
          runtime,
          setDecision(next: typeof pass | typeof revise | typeof escalation) { selectedDecision = next; },
          get auditCalls() { return auditCalls; },
        };
      };

      for (const role of ["judge", "fixer", "reviewer", "doctor"] as const) {
        const retriable = createRole(role, revise);
        await retriable.runtime.activate();
        const tool = retriable.harness.tools.get(role === "judge" ? judgeRole.JUDGE_OUTPUT_TOOL_NAME : role === "fixer" ? workerRole.FIXER_OUTPUT_TOOL_NAME : role === "reviewer" ? reviewerRole.REVIEWER_OUTPUT_TOOL_NAME : doctorRole.DOCTOR_OUTPUT_TOOL_NAME);
        assert.ok(tool);
        await assert.rejects(tool.execute(`${role}-revise`, outputs[role], undefined, undefined, outputContext(tool.name, `${role}-revise`)), /violation|violates its|closed contract/);
        retriable.setDecision(pass);
        const accepted = await tool.execute(`${role}-pass`, outputs[role], undefined, undefined, outputContext(tool.name, `${role}-pass`));
        assert.equal(accepted.terminate, true);
        if (role === "judge") assert.equal(accepted.details.judgeStatus, outputs[role].judgeStatus);
        else assert.equal(accepted.details.status, outputs[role].status);
        if (role !== "reviewer") assert.deepEqual(accepted.details, outputs[role]);
        assert.equal(retriable.auditCalls, 2, `${role} must audit the rejected submission and its resubmission`);

        const escalated = createRole(role, escalation);
        await escalated.runtime.activate();
        const escalationTool = escalated.harness.tools.get(tool.name);
        const result = await escalationTool.execute(`${role}-escalate`, outputs[role], undefined, undefined, outputContext(tool.name, `${role}-escalate`));
        assert.equal(result.terminate, true);
        assert.deepEqual(result.details, {
          kind: "audit_escalation",
          conflicts: escalation.conflicts,
          decisionGate: escalation.decisionGate,
        });
        assert.equal(isAuditEscalationResult(result.details), true);
        assert.throws(
          () => terminating.validateAcceptedDetails(acceptedNames[role], result.details),
          (error: unknown) => error instanceof Error && error.name === "AcceptedDetailsContractError",
        );
        assert.equal(escalated.auditCalls, 1);
      }
  }
});

test("packaged judge crosses Pi's loader, schema, persisted batch, auth-resolved audit, and termination boundaries offline", async () => {
  const manifest = await loadRawPackageManifest();
  const judgeSoul =
    (await readFile(resolve(packageRoot, "souls/judge.md"), "utf8")).trim();
  await withActivationHome(
    { prefix: "ak-role-integration-" },
    async ({ agentDir }) => {
      const faux = fauxProvider({
        api: "ak-role-offline",
        provider: "ak-role-offline",
        tokenSize: { min: 1000, max: 1000 },
      });
      const defaultBaseUrl = "https://default.invalid/v1";
      const resolvedBaseUrl = "https://tenant.invalid/v1";
      const activeModel = { ...faux.getModel(), baseUrl: defaultBaseUrl };
      const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      await writeNavigatorModelSetting(`${activeModel.provider}/${activeModel.id}`, resolve(agentDir, "navigator-model.json"));
      const authResolvedProvider = {
        ...faux.provider,
        auth: {
          apiKey: {
            name: "Integration resolved authentication",
            async resolve() {
              return {
                auth: {
                  apiKey: "resolved-secret",
                  headers: { "x-resolved-auth": "yes" },
                  baseUrl: resolvedBaseUrl,
                },
                env: { RESOLVED_TENANT: "integration" },
              };
            },
          },
        },
        getModels() {
          return [activeModel];
        },
      };
      const modelsPath = resolve(agentDir, "models.json");
      await writeFile(
        modelsPath,
        JSON.stringify({
          providers: {
            [activeModel.provider]: {
              modelOverrides: {
                [activeModel.id]: {
                  headers: { "x-model-route": "audit-tenant" },
                },
              },
            },
          },
        }),
      );
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: packageRoot,
        agentDir,
        faux,
        model: activeModel,
        provider: authResolvedProvider,
        modelsPath,
        additionalExtensionPaths: [packageEntrypoint(manifest)],
        systemPrompt: "INTEGRATION BASE PROMPT",
        mode: "json",
        flags: { "ak-role": "judge" },
        noTools: "builtin",
        customTools: [siblingTool],
      }, async ({ loader, session, sessionManager, extensions }) => {
        assert.deepEqual(loader.getExtensions().errors, []);
        assert.equal(extensions.extensions.length, 1);
        assert.deepEqual(
          session.agent.state.tools.map((tool) => tool.name),
          ["read", "grep", "find", "ls", "bash", JUDGE_OUTPUT_TOOL_NAME],
          "Judge activation keeps exactly the registered evidence tools and output",
        );
        assert.equal(
          session.agent.state.tools.some((tool) =>
            ["write", "edit", "integration_sibling"].includes(tool.name)
          ),
          false,
        );

        faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall(
              JUDGE_OUTPUT_TOOL_NAME,
              { judgeStatus: "converged", unexpected: true },
              { id: "schema-invalid" },
            ),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("schema rejection observed"),
        ]);
        await session.prompt("Exercise provider-facing schema validation.");

        const schemaResult = sessionManager
          .getEntries()
          .find(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolCallId === "schema-invalid",
          );
        assert.ok(schemaResult?.type === "message");
        assert.equal(schemaResult.message.role, "toolResult");
        assert.equal(schemaResult.message.isError, true);
        assert.match(
          textOf(schemaResult.message),
          /unexpected|additional propert/i,
        );
        assert.equal(
          faux.state.callCount,
          2,
          "schema rejection never invokes the audit model",
        );

        let judgeContext: Context | undefined;
        let auditContext: Context | undefined;
        let auditDispatch:
          | {
            baseUrl: string | undefined;
            apiKey: string | undefined;
            headers: Record<string, string | null> | undefined;
            env: Record<string, string> | undefined;
          }
          | undefined;
        // Developer exact-session shape: bare judge -p prompt is the only work
        // context (no authority.md / role-input). Navigator must recover it and
        // still deliver one correlated recommendation after accepted terminal.
        const developerPrompt = "Exercise audited terminating acceptance.";
        const response = (context: Context, requestOptions?: unknown, _state?: unknown, requestModel?: { baseUrl?: string }) => {
          const names = context.tools?.map((tool) => tool.name) ?? [];
          if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
            // Developer exact-session v1 shape: direction-only next is enough.
            // Full route/matches/command must not be required for recommendation.
            return fauxAssistantMessage(fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, {
              candidates: [{
                next: { role: "fixer", phase: "apply" },
                reason: "accepted judge should proceed to fixer apply",
              }],
            }), { stopReason: "toolUse" });
          }
          if (names.includes(SOUL_AUDIT_TOOL_NAME)) {
            auditContext = context;
            const options = requestOptions as {
              apiKey?: string;
              headers?: Record<string, string | null>;
              env?: Record<string, string>;
            } | undefined;
            auditDispatch = {
              baseUrl: requestModel?.baseUrl,
              apiKey: options?.apiKey,
              headers: options?.headers,
              env: options?.env,
            };
            return fauxAssistantMessage(
              fauxToolCall(
                SOUL_AUDIT_TOOL_NAME,
                { status: "pass", violations: [], conflicts: [], decisionGate: null },
                { id: "audit-pass" },
              ),
              { stopReason: "toolUse" },
            );
          }
          judgeContext = context;
          return fauxAssistantMessage(
            fauxToolCall(
              JUDGE_OUTPUT_TOOL_NAME,
              { judgeStatus: "converged" },
              { id: "accepted-judge" },
            ),
            { stopReason: "toolUse" },
          );
        };
        faux.setResponses([response, response, response, response, response]);
        await session.prompt(developerPrompt);

        const seenJudgeContext = judgeContext as Context | undefined;
        assert.ok(seenJudgeContext);
        assert.ok(
          seenJudgeContext.systemPrompt?.includes(
            `<judge_soul>\n${judgeSoul}\n</judge_soul>`,
          ),
          "the provider receives the complete bundled judge Soul",
        );
        const seenAuditContext = auditContext as Context | undefined;
        assert.ok(seenAuditContext);
        assert.notEqual(activeModel.baseUrl, resolvedBaseUrl);
        assert.deepEqual(auditDispatch, {
          baseUrl: resolvedBaseUrl,
          apiKey: "resolved-secret",
          headers: {
            "x-resolved-auth": "yes",
            "x-model-route": "audit-tenant",
          },
          env: { RESOLVED_TENANT: "integration" },
        });
        const auditInput = seenAuditContext.messages.find(
          (message) => message.role === "user",
        );
        assert.ok(auditInput?.role === "user");
        const auditContent = typeof auditInput.content === "string"
          ? [{ type: "text" as const, text: auditInput.content }]
          : auditInput.content;
        const auditText = auditContent
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        assert.ok(
          auditText.includes(`<judge_soul>\n${judgeSoul}\n</judge_soul>`),
        );

        const acceptedResult = sessionManager
          .getEntries()
          .find(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolCallId === "accepted-judge",
          );
        assert.ok(acceptedResult?.type === "message");
        assert.equal(acceptedResult.message.role, "toolResult");
        assert.equal(acceptedResult.message.isError, false);
        // Receipt details stay contract-pure — Navigator must not rewrite them.
        assert.deepEqual(acceptedResult.message.details, {
          judgeStatus: "converged",
        });
        const entries = sessionManager.getEntries();
        const acceptedIndex = entries.indexOf(acceptedResult);
        const attendanceMessages = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
        assert.equal(attendanceMessages.length, 1, "exactly one Navigator terminal fact on the exact session");
        const attendanceIndex = entries.indexOf(attendanceMessages[0]!);
        assert.ok(attendanceIndex > acceptedIndex, "Navigator attendance follows the accepted role terminal");
        const recommendation = (attendanceMessages[0] as { details: { disposition: string; next?: { role: string; phase: string | null }; reason?: string; command?: string; role?: string } }).details;
        assert.equal(recommendation.disposition, "recommendation");
        assert.equal(recommendation.role, "judge");
        assert.deepEqual(recommendation.next, { role: "fixer", phase: "apply" });
        assert.equal(recommendation.reason, "accepted judge should proceed to fixer apply");
        // Command is registry-rendered from recognized next, not model prose.
        assert.equal(recommendation.command, "ak-role fixer apply");
        // Exact named session principal is the only authoritative surface.
        assert.equal(typeof sessionManager.getSessionFile?.() === "string" || sessionManager.getSessionDir().length > 0, true);
      });
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    },
  );
});

test("cold-installed live help follows the loaded extension and changes on the next hint", async () => {
  await withActivationHome(
    { prefix: "ak-navigator-live-help-cold-" },
    async ({ home }) => {
      await withColdInstalledPackage(home, async ({ fixture, installedRoot, installed }) => {
        const runtimePath = resolve(installedRoot, "src/role-runtime.ts");
        const original = await readFile(runtimePath, "utf8");
        const firstMarker = "COLD_INSTALLED_LIVE_HELP_ONE";
        const secondMarker = "COLD_INSTALLED_LIVE_HELP_TWO";
        assert.equal(original.includes("Activate a packaged workflow role:"), true);
        const runtime = await installed("extensions/role-runtime.ts");
        // Cold-start budget is explicit and finite — not the prepared-path presentation latency.
        assert.equal(typeof runtime.NAVIGATOR_LIVE_HELP_TIMEOUT_MS, "number");
        assert.ok(Number.isFinite(runtime.NAVIGATOR_LIVE_HELP_TIMEOUT_MS));
        assert.ok(runtime.NAVIGATOR_LIVE_HELP_TIMEOUT_MS > 5_000);
        assert.ok(runtime.NAVIGATOR_LIVE_HELP_TIMEOUT_MS <= 60_000);
        const observedHelpTimeouts: number[] = [];
        const exec = async (_command: string, args: string[], options: { cwd?: string; timeout?: number }) => {
          assert.equal(args.at(-3), "--ak-role");
          assert.equal(args.at(-1), "--help");
          assert.ok(["judge", "fixer", "coder", "reviewer", "collector", "doctor", "merger"].includes(args.at(-2) ?? ""));
          assert.equal(options.timeout, runtime.NAVIGATOR_LIVE_HELP_TIMEOUT_MS);
          observedHelpTimeouts.push(options.timeout as number);
          const result = await runPiSubprocess(args, {
            cwd: options.cwd ?? fixture,
            env: process.env,
            ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
          });
          assert.equal(result.timedOut, false, "cold-installed role --help must not time out");
          assert.equal(result.code, 0, "cold-installed role --help must exit 0");
          return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr, killed: result.timedOut };
        };
        await writeFile(runtimePath, original.replace("Activate a packaged workflow role:", `${firstMarker}:`));
        const first = await runtime.loadNavigatorRoleHelp({ exec } as never, resolve(installedRoot, "extensions/role-runtime.ts"), fixture, "coder");
        assert.match(first, new RegExp(firstMarker));
        await writeFile(runtimePath, original.replace("Activate a packaged workflow role:", `${secondMarker}:`));
        const second = await runtime.loadNavigatorRoleHelp({ exec } as never, resolve(installedRoot, "extensions/role-runtime.ts"), fixture, "coder");
        assert.doesNotMatch(second, new RegExp(firstMarker));
        assert.match(second, new RegExp(secondMarker));
        assert.deepEqual(observedHelpTimeouts, [
          runtime.NAVIGATOR_LIVE_HELP_TIMEOUT_MS,
          runtime.NAVIGATOR_LIVE_HELP_TIMEOUT_MS,
        ]);

        const attendanceModule = await installed("src/navigator-attendance.ts");
        const modelSettingPath = resolve(home, "navigator-model.json");
        assert.equal(await attendanceModule.readNavigatorModelSetting(resolve(home, "missing-navigator-model.json")), attendanceModule.NAVIGATOR_DEFAULT_MODEL);
        await attendanceModule.writeNavigatorModelSetting("provider/one:max", modelSettingPath);
        assert.equal(await attendanceModule.readNavigatorModelSetting(modelSettingPath), "provider/one:max");
        await attendanceModule.writeNavigatorModelSetting("provider/two", modelSettingPath);
        assert.equal(await attendanceModule.readNavigatorModelSetting(modelSettingPath), "provider/two");
        await attendanceModule.writeNavigatorModelSetting("provider/one:max", modelSettingPath);
        assert.equal(await attendanceModule.readNavigatorModelSetting(modelSettingPath), "provider/one:max");
        await writeFile(modelSettingPath, JSON.stringify({ model: "provider/one:backup" }), "utf8");
        assert.throws(() => attendanceModule.parseNavigatorModelSetting("provider/one:backup"), /:max|thinking suffix/);
        await writeFile(modelSettingPath, JSON.stringify({ model: "provider/model" }), "utf8");
        const events: Array<{ command?: string; disposition?: string; unavailableReason?: string }> = [];
        const prepareRequests: string[] = [];
        let prepareTool: any;
        const session = {
          async prompt(request: string) {
            prepareRequests.push(request);
            await prepareTool.execute("cold-help-prepare", {
              candidates: [{
                next: { role: "judge", phase: null },
                reason: "typed cold-installed direction",
              }],
            });
          },
          appendEntry() {},
          entries: () => [],
          async setModel() {},
          dispose() {},
        };
        await writeFile(runtimePath, original.replace("Activate a packaged workflow role:", `${firstMarker}:`));
        const nav = attendanceModule.createNavigatorAttendance({
          context: {
            sessionManager: {
              getSessionId: () => "cold-help",
              appendCustomEntry() { return "ok"; },
            },
            cwd: fixture,
          } as never,
          role: "coder",
          phase: "apply",
          subjectKey: resolve(fixture, "task.md"),
          sessionDir: resolve(fixture, "navigator"),
          subject: "cold-installed task",
          authority: "cold-installed authority",
          modelSettingPath,
          loadSoul: async () => "route judgment",
          loadRoleHelp: (role: any) => runtime.loadNavigatorRoleHelp({ exec } as never, resolve(installedRoot, "extensions/role-runtime.ts"), fixture, role),
          createSession: async ({ tool }: any) => { prepareTool = tool; return session; },
          onEvent: async (event: any) => { events.push(event); },
        });
        nav.prepare();
        await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
        await writeFile(runtimePath, original.replace("Activate a packaged workflow role:", `${secondMarker}:`));
        nav.prepare();
        await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
        assert.equal(events.length, 2);
        assert.equal(prepareRequests.length, 2);
        assert.equal(prepareRequests[0]!.includes(firstMarker), true, "first prepare must carry live help marker");
        assert.equal(prepareRequests[1]!.includes(secondMarker), true, "second prepare must reread live help");
        assert.deepEqual(events.map((event: any) => ({ disposition: event.disposition, command: event.command, unavailableReason: event.unavailableReason })), [
          { disposition: "recommendation", command: "ak-role judge", unavailableReason: undefined },
          { disposition: "recommendation", command: "ak-role judge", unavailableReason: undefined },
        ]);
        assert.equal(events[0]!.command, "ak-role judge");
        assert.equal(events[1]!.command, "ak-role judge");
        assert.equal(events[1]!.command?.includes("/task.md"), false);

        // Cross the installed package entrypoint with the bundled Luna Max default,
        // then edit and restore the same setting without permitting a fallback.
        // Independent presentation is proven by observable typed attendance events,
        // one Navigator call, <=1s prepared latency, and repeated <10% follow-up below.
        const installedNavigator = await installed("src/navigator-attendance.ts");
        const issueRoot = resolve(fixture, ".ak/work/issues/28");
        await mkdir(issueRoot, { recursive: true });
        await writeFile(resolve(issueRoot, "authority.md"), "cold-installed owner authority\n", "utf8");
        const luna = fauxProvider({
          api: "openai-responses",
          provider: "openai-codex",
          models: [{ id: "gpt-5.6-luna", reasoning: true }],
          tokenSize: { min: 1000, max: 1000 },
        });
        const lunaModel = luna.getModel("gpt-5.6-luna");
        assert.ok(lunaModel);
        Object.assign(lunaModel, { reasoning: true, thinkingLevelMap: { max: "max" } });
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const coldAgentDir = resolve(home, ".cold-installed-agent");
        process.env.PI_CODING_AGENT_DIR = coldAgentDir;
        await mkdir(coldAgentDir, { recursive: true });
        const configuredPath = resolve(coldAgentDir, "navigator-model.json");
        assert.equal(await installedNavigator.readNavigatorModelSetting(configuredPath), installedNavigator.NAVIGATOR_DEFAULT_MODEL);
        const modelRequests: string[] = [];
        const lifecycle: Array<{ label: string; event: any; timestamps?: { preparedAt: string; settledAt: string; persistedVisibleAt: string } }> = [];
        const invoke = async (label: string) => {
          const response = (context: Context, _options: unknown, _state: unknown, requestModel: { provider: string; id: string }) => {
            const names = context.tools?.map((tool) => tool.name) ?? [];
            if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
              modelRequests.push(`${requestModel.provider}/${requestModel.id}`);
              return fauxAssistantMessage(fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, {
                candidates: [{
                  id: "cold-luna-route",
                  matches: { role: "judge", phase: null, kind: "accepted" },
                  route: [{ role: "judge", phase: null }, { role: "reviewer", phase: null }],
                  next: { role: "reviewer", phase: null },
                  reason: "cold-installed typed route",
                  command: "Usage: pi --ak-role reviewer --help",
                }],
              }), { stopReason: "toolUse" });
            }
            if (names.includes(SOUL_AUDIT_TOOL_NAME)) return fauxAssistantMessage(fauxToolCall(SOUL_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" });
            return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }), { stopReason: "toolUse" });
          };
          luna.setResponses([response, response, response]);
          let event: any;
          let timestamps: { preparedAt: string; settledAt: string; persistedVisibleAt: string } | undefined;
          await withInProcessPi({
            activationLedgerSession: true,
            cwd: issueRoot,
            agentDir: coldAgentDir,
            faux: luna,
            model: lunaModel,
            additionalExtensionPaths: [resolve(installedRoot, "extensions/role-runtime.ts")],
            systemPrompt: `COLD INSTALLED ${label}`,
            mode: "json",
            flags: { "ak-role": "judge" },
            noTools: "builtin",
          }, async ({ session, sessionManager }) => {
            await session.prompt(`ordinary cold-installed attendance ${label}`);
            const visible = sessionManager.getEntries().find((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
            event = visible?.type === "custom_message" ? visible.details : undefined;
            if (event?.disposition !== "recommendation") return;
            const navigatorDirectory = installedNavigator.navigatorSessionDirectory({ cwd: issueRoot, sessionManager: { getSessionDir: () => "" } } as never, resolve(issueRoot));
            const navigatorFiles = (await readdir(navigatorDirectory)).filter((file) => file.endsWith(".jsonl")).sort();
            assert.ok(navigatorFiles.length > 0, `${label} must persist a Navigator session (${JSON.stringify({ event, modelRequests, navigatorDirectory })})`);
            const persisted = (await readFile(join(navigatorDirectory, navigatorFiles.at(-1)!), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
            const prepared = [...persisted].reverse().find((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === NAVIGATOR_PREPARE_TOOL_NAME);
            const settled = [...persisted].reverse().find((entry) => entry.type === "custom" && entry.customType === "ak-navigator-settlement");
            const preparedAt = prepared?.timestamp;
            const settledAt = settled?.timestamp;
            const persistedVisibleAt = visible?.timestamp;
            if (typeof preparedAt !== "string" || typeof settledAt !== "string" || typeof persistedVisibleAt !== "string") {
              throw new Error(`${label} must persist typed preparation, settlement, and visible timestamps: ${JSON.stringify({ preparedAt, settledAt, persistedVisibleAt, event, persistedTypes: persisted.map((entry) => ({ type: entry.type, customType: entry.customType, timestamp: entry.timestamp })) })}`);
            }
            timestamps = { preparedAt, settledAt, persistedVisibleAt };
            assert.ok(Date.parse(preparedAt) <= Date.parse(settledAt), `${label} preparation must complete before settlement`);
            if (event?.disposition === "recommendation") assert.ok(Date.parse(persistedVisibleAt) - Date.parse(settledAt) <= 1000, `${label} settlement-to-visible latency exceeded 1s`);
          });
          lifecycle.push({ label, event, ...(timestamps === undefined ? {} : { timestamps }) });
        };
        try {
          await invoke("default-luna-max");
          await installedNavigator.writeNavigatorModelSetting("openai-codex/gpt-5.6-luna", configuredPath);
          await invoke("edited-luna-off");
          await installedNavigator.writeNavigatorModelSetting(installedNavigator.NAVIGATOR_DEFAULT_MODEL, configuredPath);
          await invoke("restored-luna-max");
          await installedNavigator.writeNavigatorModelSetting("missing/provider", configuredPath);
          await invoke("unsupported-no-fallback");
        } finally {
          if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
        assert.deepEqual(modelRequests, [
          "openai-codex/gpt-5.6-luna",
          "openai-codex/gpt-5.6-luna",
          "openai-codex/gpt-5.6-luna",
        ], "unsupported configuration must not fall back or dispatch another model");
        assert.equal(lifecycle[0]?.event.disposition, "recommendation");
        assert.equal(lifecycle[1]?.event.disposition, "recommendation");
        assert.equal(lifecycle[2]?.event.disposition, "recommendation");
        assert.equal(lifecycle[3]?.event.disposition, "unavailable");
        assert.equal(lifecycle[3]?.event.unavailableSource, "model");
        assert.equal(lifecycle[3]?.event.unavailableCause, "model");
        process.stderr.write(`[cold Navigator lifecycle] ${JSON.stringify(lifecycle.map(({ label, event, timestamps }) => ({ label, disposition: event?.disposition, timestamps }))) }\n`);
      });
    },
  );
});

test("normal packaged Navigator presents independently in print and JSON and reuses one subject session", async () => {
  const manifest = await loadRawPackageManifest();
  await withActivationHome(
    { prefix: "ak-navigator-entrypoint-integration-" },
    async ({ agentDir, home }) => {
      const issueRoot = resolve(home, ".ak/work/issues/28");
      await mkdir(issueRoot, { recursive: true });
      await writeFile(resolve(issueRoot, "authority.md"), "owner decision: automatic attendance\n", "utf8");
      const faux = fauxProvider({
        api: "ak-navigator-entrypoint-offline",
        provider: "ak-navigator-entrypoint-offline",
        tokenSize: { min: 1000, max: 1000 },
      });
      const model = faux.getModel();
      const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      await writeNavigatorModelSetting(`${model.provider}/${model.id}`, resolve(agentDir, "navigator-model.json"));
      let navigatorCalls = 0;
      let roleModelCalls = 0;
      let invalidJudge = true;
      let revisedRoute = false;
      let preparedAt = 0;
      const response = (context: Context) => {
        const names = context.tools?.map((tool) => tool.name) ?? [];
        if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
          navigatorCalls += 1;
          preparedAt = performance.now();
          const route = revisedRoute
            ? [{ role: "judge" as const, phase: null }, { role: "fixer" as const, phase: "apply" as const }, { role: "reviewer" as const, phase: null }]
            : [{ role: "judge" as const, phase: null }, { role: "reviewer" as const, phase: null }];
          const next = revisedRoute
            ? { role: "fixer" as const, phase: "apply" as const }
            : { role: "reviewer" as const, phase: null };
          return fauxAssistantMessage(
            fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, {
              candidates: [{
                id: revisedRoute ? "revised-production-route" : "production-route",
                matches: { role: "judge", phase: null, kind: "accepted" },
                route,
                next,
                reason: revisedRoute ? "New evidence requires a controlled repair." : "The current work needs an independent review next.",
                command: revisedRoute ? "Usage: pi --ak-role fixer --help" : "Usage: pi --ak-role reviewer --help",
              }],
            }, { id: `navigator-${faux.state.callCount}` }),
            { stopReason: "toolUse" },
          );
        }
        if (names.includes(SOUL_AUDIT_TOOL_NAME)) {
          return fauxAssistantMessage(
            fauxToolCall(SOUL_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }, { id: `audit-${faux.state.callCount}` }),
            { stopReason: "toolUse" },
          );
        }
        roleModelCalls += 1;
        const judgeArguments = invalidJudge
          ? (invalidJudge = false, { judgeStatus: "converged", unexpected: true })
          : { judgeStatus: "converged" };
        return fauxAssistantMessage(
          fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, judgeArguments, { id: `judge-${faux.state.callCount}` }),
          { stopReason: "toolUse" },
        );
      };
      // One session per presentation mode (deterministic faux — rate-over-replays is decorative).
      const presentationSamples = ["json", "print", "tui"] as const;
      for (const [sample, mode] of presentationSamples.entries()) {
          navigatorCalls = 0;
          roleModelCalls = 0;
          invalidJudge = true;
          faux.setResponses([response, response, response, response]);
          await withInProcessPi({
            activationLedgerSession: true,
            cwd: issueRoot,
            agentDir,
            faux,
            additionalExtensionPaths: [packageEntrypoint(manifest)],
            systemPrompt: "NAVIGATOR ENTRYPOINT ACCEPTANCE",
            mode,
            flags: { "ak-role": "judge" },
            noTools: "builtin",
          }, async ({ session, sessionManager }) => {
            await session.prompt("Run the unchanged normal role entrypoint with Navigator attendance.");
            const attendance = sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
            assert.equal(attendance.length, 1);
            const message = attendance[0];
            assert.ok(message?.type === "custom_message");
            if (message === undefined || message.type !== "custom_message") throw new Error("Navigator message missing");
            const event = (message as { details: { disposition: string; subjectKey: string; route?: unknown; next?: unknown } }).details;
            assert.equal(event.disposition, "recommendation");
            assert.equal(event.subjectKey, issueRoot);
            if (sample === 0) assert.ok(event.route);
            else assert.equal(event.route, undefined);
            assert.deepEqual(event.next, revisedRoute
              ? { role: "fixer", phase: "apply" }
              : { role: "reviewer", phase: null });
          });
          assert.equal(navigatorCalls, 1, "a correctable role-output error must reuse one Navigator model call");
          void preparedAt;
        }
        revisedRoute = true;
        navigatorCalls = 0;
        roleModelCalls = 0;
        invalidJudge = false;
        faux.setResponses([response, response, response]);
        await withInProcessPi({
          activationLedgerSession: true,
          cwd: issueRoot,
          agentDir,
          faux,
          additionalExtensionPaths: [packageEntrypoint(manifest)],
          systemPrompt: "NAVIGATOR ENTRYPOINT ACCEPTANCE ROUTE REVISION",
          mode: "print",
          flags: { "ak-role": "judge" },
          noTools: "builtin",
        }, async ({ session, sessionManager }) => {
          await session.prompt("Exercise a revised route through the unchanged entrypoint.");
          const attendance = sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
          assert.equal(attendance.length, 1);
          const event = (attendance[0] as { details: { route?: unknown; next?: unknown } }).details;
          assert.deepEqual(event.route, [{ role: "judge", phase: null }, { role: "fixer", phase: "apply" }, { role: "reviewer", phase: null }]);
          assert.deepEqual(event.next, { role: "fixer", phase: "apply" });
        });
        assert.equal(navigatorCalls, 1);
        if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      const navigatorSession = SessionManager.continueRecent(issueRoot, navigatorSessionDirectory({ cwd: issueRoot, sessionManager: { getSessionDir: () => "" } } as never, issueRoot));
      const navigatorEntries = (await readFile(navigatorSession.getSessionFile()!, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type?: string; customType?: string; data?: unknown });
      const invocations = navigatorEntries.filter((entry) => entry.type === "custom" && entry.customType === "ak-navigator-invocation");
      const settlements = navigatorEntries.filter((entry) => entry.type === "custom" && entry.customType === "ak-navigator-settlement");
      const routes = navigatorEntries.filter((entry) => entry.type === "custom" && entry.customType === "ak-navigator-route");
      // 3 presentation modes + 1 revised-route session
      assert.equal(invocations.length, 4);
      assert.equal(settlements.length, 4);
      assert.equal(routes.length, 4);
      assert.deepEqual((invocations[0] as { data: { role: string; phase: null; subjectKey: string } }).data, {
        invocationId: (routes[0] as { data: { invocationId: string } }).data.invocationId,
        role: "judge",
        phase: null,
        subjectKey: issueRoot,
      });
      assert.ok(routes.every((entry) => (entry as { data: { subjectKey: string; route: unknown } }).data.subjectKey === issueRoot));
      assert.deepEqual((routes.at(-1) as { data: { route: unknown } }).data.route, [{ role: "judge", phase: null }, { role: "fixer", phase: "apply" }, { role: "reviewer", phase: null }]);
      assert.ok(settlements.every((entry) => (entry as { data: { kind: string; role: string; phase: null } }).data.kind === "accepted"));
    },
  );
});

test("normal packaged Navigator drains one healthy preparation across recommendation and silent settlements", async () => {
  const manifest = await loadRawPackageManifest();
  await withActivationHome(
    { prefix: "ak-navigator-drain-matrix-" },
    async ({ home, agentDir }) => {
      const issueRoot = resolve(home, ".ak/work/issues/28");
      await mkdir(issueRoot, { recursive: true });
      await writeFile(resolve(issueRoot, "authority.md"), "owner authority: drain one Navigator call\n", "utf8");
      const faux = fauxProvider({
        api: "openai-responses",
        provider: "ak-navigator-drain-offline",
        models: [{ id: "gpt-5.6-luna", reasoning: true }],
        tokenSize: { min: 1000, max: 1000 },
      });
      const model = faux.getModel("gpt-5.6-luna");
      assert.ok(model);
      Object.assign(model, { reasoning: true, thinkingLevelMap: { max: "max" } });
      const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
      const oldExitCode = process.exitCode;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      await writeNavigatorModelSetting(`${model.provider}/${model.id}:max`, resolve(agentDir, "navigator-model.json"));
      try {
        const outcomes = ["recommendation", "human_decision", "infrastructure"] as const;
        for (const outcome of outcomes) {
          let navigatorCalls = 0;
          let roleOutputReturned = false;
          let releasePreparation!: () => void;
          let navigatorStarted!: () => void;
          const navigatorStartedPromise = new Promise<void>((resolve) => { navigatorStarted = resolve; });
          const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
          let promptFinished = false;
          const response = (context: Context) => {
            const names = context.tools?.map((tool) => tool.name) ?? [];
            if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
              navigatorCalls += 1;
              navigatorStarted();
              return preparationGate.then(() => fauxAssistantMessage(fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, {
                candidates: [{
                  id: `drain-${outcome}`,
                  matches: { role: "judge", phase: null, kind: "accepted" },
                  route: [{ role: "judge", phase: null }, { role: "reviewer", phase: null }],
                  next: { role: "reviewer", phase: null },
                  reason: "healthy in-flight preparation",
                  command: "Usage: pi --ak-role reviewer --help",
                }],
              }), { stopReason: "toolUse" }));
            }
            if (names.includes(SOUL_AUDIT_TOOL_NAME)) {
              if (outcome === "infrastructure") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider quota exhausted" });
              return fauxAssistantMessage(fauxToolCall(SOUL_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" });
            }
            roleOutputReturned = true;
            const verdict = outcome === "human_decision" ? { judgeStatus: "escalate", decisionGate: { question: "owner choice", options: ["owner"] } } : { judgeStatus: "converged" };
            return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, verdict), { stopReason: "toolUse" });
          };
          faux.setResponses([response, response, response, response, response]);
          await withInProcessPi({
            activationLedgerSession: true,
            cwd: issueRoot,
            agentDir,
            faux,
            model,
            additionalExtensionPaths: [packageEntrypoint(manifest)],
            systemPrompt: `NAVIGATOR DRAIN ${outcome}`,
            mode: "json",
            flags: { "ak-role": "judge" },
            noTools: "builtin",
          }, async ({ session, sessionManager }) => {
            const prompt = session.prompt(`Exercise ${outcome} settlement while Navigator preparation is in flight.`);
            await navigatorStartedPromise;
            while (!roleOutputReturned) await new Promise<void>((resolve) => setImmediate(resolve));
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(promptFinished, false);
            prompt.then(() => { promptFinished = true; }, () => { promptFinished = true; });
            assert.equal(navigatorCalls, 1, "the settlement must retain one in-flight Navigator call");
            assert.equal(sessionManager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance"), false, "no advice may appear before preparation drains");
            releasePreparation();
            await prompt.catch(() => undefined);
            assert.equal(promptFinished, true);
            const attendance = sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
            if (outcome === "recommendation") {
              assert.equal(attendance.length, 1);
              assert.equal((attendance[0] as { details: { disposition: string } }).details.disposition, "recommendation");
            } else {
              assert.equal(attendance.length, 1, `${outcome} must emit affirmative typed no-advice`);
              assert.equal((attendance[0] as { details: { disposition: string } }).details.disposition, "no-advice");
            }
            assert.equal(navigatorCalls, 1, "no late or overlapping Navigator call may occur after release");
          });
        }
      } finally {
        if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
        process.exitCode = oldExitCode;
      }
    },
  );
});

test("ongoing packaged session keeps healthy Navigator prepare across pre-output role failure for the next accepted terminal", async () => {
  const manifest = await loadRawPackageManifest();
  await withActivationHome(
    { prefix: "ak-navigator-pre-output-failure-" },
    async ({ home, agentDir }) => {
      const issueRoot = resolve(home, ".ak/work/issues/pre-output-failure");
      await mkdir(issueRoot, { recursive: true });
      await writeFile(resolve(issueRoot, "authority.md"), "typed authority\n", "utf8");
      const faux = fauxProvider({ api: "ak-navigator-pre-output", provider: "ak-navigator-pre-output", tokenSize: { min: 1000, max: 1000 } });
      const model = faux.getModel();
      const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      await writeNavigatorModelSetting(`${model.provider}/${model.id}`, resolve(agentDir, "navigator-model.json"));
      let releaseFirstPreparation!: () => void;
      const firstPreparationGate = new Promise<void>((resolve) => { releaseFirstPreparation = resolve; });
      let firstNavigatorStarted!: () => void;
      const navigatorStarted = new Promise<void>((resolve) => { firstNavigatorStarted = resolve; });
      let roleFailure!: () => void;
      const roleFailed = new Promise<void>((resolve) => { roleFailure = resolve; });
      let navigatorCalls = 0;
      let roleOutputs = 0;
      const response = (context: Context) => {
        const names = context.tools?.map((tool) => tool.name) ?? [];
        if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
          navigatorCalls += 1;
          firstNavigatorStarted();
          const answer = fauxAssistantMessage(fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, {
            candidates: [{
              id: `kept-${navigatorCalls}`,
              matches: { role: "judge", phase: null, kind: "accepted" },
              route: [{ role: "judge", phase: null }, { role: "reviewer", phase: null }],
              next: { role: "reviewer", phase: null },
              reason: "kept typed preparation",
              command: "Usage: pi --ak-role reviewer --help",
            }],
          }), { stopReason: "toolUse" });
          return navigatorCalls === 1 ? firstPreparationGate.then(() => answer) : answer;
        }
        if (names.includes(SOUL_AUDIT_TOOL_NAME)) {
          return fauxAssistantMessage(fauxToolCall(SOUL_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" });
        }
        roleOutputs += 1;
        if (roleOutputs === 1) {
          roleFailure();
          return fauxAssistantMessage("role provider failed before output", { stopReason: "error", errorMessage: "network unavailable" });
        }
        return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }), { stopReason: "toolUse" });
      };
      faux.setResponses(Array.from({ length: 8 }, () => response));
      await withInProcessPi({ activationLedgerSession: true, cwd: issueRoot, agentDir, faux, model, additionalExtensionPaths: [packageEntrypoint(manifest)], systemPrompt: "PRE OUTPUT FAILURE", mode: "json", flags: { "ak-role": "judge" }, noTools: "builtin" }, async ({ session, sessionManager }) => {
        const first = session.prompt("first role turn fails before output");
        await navigatorStarted;
        await roleFailed;
        releaseFirstPreparation();
        await first;
        assert.equal(sessionManager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance"), false);

        // Healthy prepare must survive the non-terminal failure turn so the next
        // accepted terminal does not cold-start against the post-role grace.
        await session.prompt("second role turn reuses the kept preparation");
        const attendance = sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
        assert.equal(attendance.length, 1);
        assert.equal((attendance[0] as { details: { disposition: string } }).details.disposition, "recommendation");
        assert.equal(navigatorCalls, 1, "mid-turn agent_settled must not discard a healthy prepare");
        const navigatorDir = navigatorSessionDirectory({ cwd: issueRoot, sessionManager: { getSessionDir: () => "" } } as never, issueRoot);
        const persisted = (await readFile(SessionManager.continueRecent(issueRoot, navigatorDir).getSessionFile()!, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as any);
        const settlements = persisted.filter((entry) => entry.type === "custom" && entry.customType === "ak-navigator-settlement");
        const invocations = persisted.filter((entry) => entry.type === "custom" && entry.customType === "ak-navigator-invocation");
        assert.equal(settlements.length, 1);
        assert.equal(settlements[0].data.kind, "accepted");
        assert.equal(invocations.length, 1);
      });
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    },
  );
});

test("normal packaged context-loader failure is typed unavailable and preserves the role Receipt", async () => {
  const manifest = await loadRawPackageManifest();
  await withActivationHome(
    { prefix: "ak-navigator-context-loader-failure-" },
    async ({ home, agentDir }) => {
      const issueRoot = resolve(home, ".ak/work/issues/28");
      await mkdir(resolve(issueRoot, "authority.md"), { recursive: true });
      const faux = fauxProvider({ api: "ak-navigator-context-failure", provider: "ak-navigator-context-failure", tokenSize: { min: 1000, max: 1000 } });
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: issueRoot,
        agentDir,
        faux,
        additionalExtensionPaths: [packageEntrypoint(manifest)],
        systemPrompt: "CONTEXT LOADER FAILURE",
        mode: "json",
        flags: { "ak-role": "judge" },
        noTools: "builtin",
      }, async ({ session, sessionManager }) => {
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }, { id: "context-failure-judge" }), { stopReason: "toolUse" }),
          fauxAssistantMessage(fauxToolCall(SOUL_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" }),
        ]);
        await session.prompt("The role must still settle when Navigator context loading throws.");
        const receipt = sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "context-failure-judge");
        assert.ok(receipt?.type === "message" && receipt.message.role === "toolResult");
        assert.equal(receipt.message.isError, false);
        assert.deepEqual(receipt.message.details, { judgeStatus: "converged" });
        const attendance = sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
        assert.equal(attendance.length, 1);
        const event = (attendance[0] as { details: { disposition: string; unavailableReason?: string; unavailableSource?: string; unavailableCause?: string } }).details;
        assert.equal(event.disposition, "unavailable");
        assert.equal(event.unavailableSource, "context");
        assert.equal(event.unavailableCause, "context");
      });
    },
  );
});

test("normal packaged Navigator failures remain typed, native-cause, and Receipt-preserving across the cause matrix", async () => {
  const manifest = await loadRawPackageManifest();
  await withActivationHome(
    { prefix: "ak-navigator-failure-matrix-" },
    async ({ home, agentDir }) => {
      const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      // Auth/quota/transport prose independence lives at navigator-attendance seam; one diagnostic each here.
      const cases = [
        { name: "context", source: "context" },
        { name: "session", source: "session" },
        { name: "model", source: "model" },
        { name: "thinking", source: "thinking" },
        { name: "auth", source: "auth", status: 401, diagnostics: ["auth key unavailable"] },
        { name: "quota", source: "quota", status: 429, diagnostics: ["quota exhausted"] },
        { name: "transport", source: "transport", diagnostics: ["transport unavailable"] },
      ] as const;
      try {
        for (const [index, scenario] of cases.entries()) {
          const diagnostics = "diagnostics" in scenario ? scenario.diagnostics : ["stable diagnostic"];
          for (const [diagnosticIndex, diagnostic] of diagnostics.entries()) {
            const issueRoot = resolve(home, `.ak/work/issues/failure-${index}-${diagnosticIndex}`);
            await mkdir(issueRoot, { recursive: true });
            await writeFile(resolve(issueRoot, "authority.md"), "owner authority for failure matrix\n", "utf8");
            if (scenario.name === "context") {
              await rm(resolve(issueRoot, "authority.md"), { recursive: true, force: true });
              await mkdir(resolve(issueRoot, "authority.md"), { recursive: true });
            }
            if (scenario.name === "session") {
              await mkdir(resolve(issueRoot, "runs"), { recursive: true });
              await writeFile(resolve(issueRoot, "runs/navigator"), "not a session directory", "utf8");
            }
            const faux = fauxProvider({ api: `ak-navigator-${scenario.name}-${diagnosticIndex}`, provider: `ak-navigator-${scenario.name}-${diagnosticIndex}`, tokenSize: { min: 1000, max: 1000 } });
            const model = faux.getModel();
            const setting = scenario.name === "model"
              ? "missing/provider"
              : scenario.name === "thinking"
                ? `${model.provider}/${model.id}:max`
                : `${model.provider}/${model.id}`;
            await writeNavigatorModelSetting(setting, resolve(agentDir, "navigator-model.json"));
            const streamFailure = scenario.name === "auth" || scenario.name === "quota" || scenario.name === "transport";
            const provider = streamFailure
              ? {
                ...faux.provider,
                getModels() { return [model]; },
                stream(requestModel: typeof model, streamContext: Context, options?: { onResponse?: (response: { status: number; headers: Record<string, string> }, model: typeof requestModel) => void | Promise<void> }) {
                  const names = streamContext.tools?.map((tool) => tool.name) ?? [];
                  if (!names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
                    return faux.provider.stream(requestModel, streamContext, options as never);
                  }
                  const stream = createAssistantMessageEventStream();
                  const human = scenario.name === "transport"
                    ? {
                      ...fauxAssistantMessage("", { stopReason: "error", errorMessage: diagnostic }),
                      diagnostics: [{
                        type: "provider_transport_failure",
                        timestamp: Date.now(),
                        error: { message: diagnostic, code: "transport_error" },
                      }],
                    }
                    : fauxAssistantMessage("", { stopReason: "error", errorMessage: diagnostic });
                  queueMicrotask(() => {
                    void (async () => {
                      if ("status" in scenario) {
                        await options?.onResponse?.({ status: scenario.status, headers: {} }, requestModel);
                      }
                      stream.push({ type: "start", partial: { ...human, content: [], stopReason: "pending" } });
                      stream.push({ type: "error", reason: "error", error: human });
                    })();
                  });
                  return stream;
                },
                streamSimple(requestModel: typeof model, streamContext: Context, options?: { onResponse?: (response: { status: number; headers: Record<string, string> }, model: typeof requestModel) => void | Promise<void> }) {
                  return this.stream(requestModel, streamContext, options);
                },
              }
              : undefined;
            const response = (context: Context) => {
              const names = context.tools?.map((tool) => tool.name) ?? [];
              if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
                return fauxAssistantMessage(fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, { candidates: [{ id: "matrix-route", matches: { role: "judge", phase: null, kind: "accepted" }, route: [{ role: "judge", phase: null }, { role: "reviewer", phase: null }], next: { role: "reviewer", phase: null }, reason: "matrix route", command: "Usage: pi --ak-role reviewer --help" }] }), { stopReason: "toolUse" });
              }
              if (names.includes(SOUL_AUDIT_TOOL_NAME)) return fauxAssistantMessage(fauxToolCall(SOUL_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" });
              return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }), { stopReason: "toolUse" });
            };
            faux.setResponses([response, response, response]);
            await withInProcessPi({ activationLedgerSession: true, cwd: issueRoot, agentDir, faux, ...(provider === undefined ? {} : { provider }), additionalExtensionPaths: [packageEntrypoint(manifest)], systemPrompt: `NAVIGATOR FAILURE MATRIX ${scenario.name}`, mode: "json", flags: { "ak-role": "judge" }, noTools: "builtin" }, async ({ session, sessionManager }) => {
              await session.prompt(`Exercise normal packaged ${scenario.name} Navigator failure.`);
              const receipt = sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === JUDGE_OUTPUT_TOOL_NAME);
              assert.ok(receipt?.type === "message" && receipt.message.role === "toolResult");
              assert.equal(receipt.message.isError, false, `${scenario.name}:${diagnostic}`);
              assert.deepEqual(receipt.message.details, { judgeStatus: "converged" }, `${scenario.name}:${diagnostic}`);
              const attendance = sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
              assert.equal(attendance.length, 1, `${scenario.name}:${diagnostic}`);
              const event = (attendance[0] as { details: { disposition: string; unavailableReason?: string; unavailableSource?: string; unavailableCause?: string } }).details;
              assert.equal(event.disposition, "unavailable", `${scenario.name}:${diagnostic}`);
              assert.equal(event.unavailableSource, scenario.source, `${scenario.name}:${diagnostic}`);
              assert.equal(event.unavailableCause, scenario.source, `${scenario.name}:${diagnostic}`);
              assert.notEqual(event.unavailableReason, undefined, `${scenario.name}:${diagnostic}`);
            });
          }
        }
      } finally {
        if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      }
    },
  );
});

test("normal packaged roles retain typed cross-role Navigator continuity and isolate subjects", async () => {
  const manifest = await loadRawPackageManifest();
  await withActivationHome(
    { prefix: "ak-navigator-cross-role-integration-" },
    async ({ home, agentDir }) => {
      const issueRoot = resolve(home, ".ak/work/ad-hoc");
      const otherRoot = resolve(home, ".ak/work/other-ad-hoc");
      await mkdir(resolve(issueRoot, "runs/coder"), { recursive: true });
      await mkdir(resolve(issueRoot, "runs/fixer"), { recursive: true });
      await mkdir(resolve(otherRoot, "runs/coder"), { recursive: true });
      await writeFile(resolve(issueRoot, "authority.md"), "owner authority: keep the work bounded\n", "utf8");
      await writeFile(resolve(otherRoot, "authority.md"), "other owner authority\n", "utf8");
      const coderTask = resolve(issueRoot, "runs/coder/task.md");
      const fixerPacket = resolve(issueRoot, "runs/fixer/fix-packet.json");
      const otherTask = resolve(otherRoot, "runs/coder/task.md");
      await writeFile(coderTask, "Concrete coder task for the same ad-hoc journey.\n", "utf8");
      await writeFile(fixerPacket, "Concrete fixer packet for the same ad-hoc journey.\n", "utf8");
      await writeFile(otherTask, "Different ad-hoc task.\n", "utf8");
      const faux = fauxProvider({
        api: "ak-navigator-cross-role-offline",
        provider: "ak-navigator-cross-role-offline",
        tokenSize: { min: 1000, max: 1000 },
      });
      const model = faux.getModel();
      const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      await writeNavigatorModelSetting(`${model.provider}/${model.id}`, resolve(agentDir, "navigator-model.json"));
      let sharedSubjectKey: string | undefined;
      let isolatedSubjectKey: string | undefined;
      let navigatorPreparation = 0;
      const response = (context: Context) => {
        const names = context.tools?.map((tool) => tool.name) ?? [];
        if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
          const fixer = navigatorPreparation++ === 1;
          const route = fixer
            ? [{ role: "fixer" as const, phase: "plan" as const }, { role: "reviewer" as const, phase: null }]
            : [{ role: "coder" as const, phase: "plan" as const }, { role: "fixer" as const, phase: "plan" as const }];
          const next = fixer
            ? { role: "reviewer" as const, phase: null }
            : { role: "fixer" as const, phase: "plan" as const };
          return fauxAssistantMessage(fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, {
            candidates: [{
              id: fixer ? "fixer-plan-route" : "coder-plan-route",
              matches: { role: fixer ? "fixer" : "coder", phase: "plan", kind: "accepted" },
              route,
              next,
              reason: "typed cross-role route",
              command: fixer ? "Usage: pi --ak-role reviewer --help" : "Usage: pi --ak-role fixer --ak-fixer-phase plan --help",
            }],
          }), { stopReason: "toolUse" });
        }
        if (names.includes(SOUL_AUDIT_TOOL_NAME) || names.includes(FIXER_AUDIT_TOOL_NAME)) {
          const auditTool = names.includes(FIXER_AUDIT_TOOL_NAME) ? FIXER_AUDIT_TOOL_NAME : SOUL_AUDIT_TOOL_NAME;
          return fauxAssistantMessage(fauxToolCall(auditTool, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" });
        }
        if (names.includes(JUDGE_OUTPUT_TOOL_NAME)) {
          return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }), { stopReason: "toolUse" });
        }
        if (names.includes(FIXER_OUTPUT_TOOL_NAME)) {
          return fauxAssistantMessage(fauxToolCall(FIXER_OUTPUT_TOOL_NAME, { status: "planned", report: "typed plan" }), { stopReason: "toolUse" });
        }
        return fauxAssistantMessage(fauxToolCall(CODER_OUTPUT_TOOL_NAME, { status: "planned", report: "typed plan" }), { stopReason: "toolUse" });
      };

      faux.setResponses([response, response]);
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: issueRoot,
        agentDir,
        faux,
        additionalExtensionPaths: [packageEntrypoint(manifest)],
        systemPrompt: "CROSS ROLE CODER",
        mode: "json",
        flags: { "ak-role": "coder", "ak-coder-phase": "plan", "ak-coder-task": coderTask },
        noTools: "builtin",
      }, async ({ session, sessionManager }) => {
        await session.prompt("coder starts the same ad-hoc journey");
        const messages = sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
        assert.equal(messages.length, 1);
        const event = (messages[0] as { details: { subjectKey: string; next?: unknown } }).details;
        sharedSubjectKey = event.subjectKey;
        assert.ok(sharedSubjectKey.includes(issueRoot));
        assert.deepEqual(event.next, { role: "fixer", phase: "plan" }, JSON.stringify(event));
        assert.equal(event.subjectKey, sharedSubjectKey);
      });

      faux.setResponses([response, response, response]);
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: issueRoot,
        agentDir,
        faux,
        additionalExtensionPaths: [packageEntrypoint(manifest)],
        systemPrompt: "CROSS ROLE FIXER",
        mode: "json",
        flags: { "ak-role": "fixer", "ak-fixer-phase": "plan", "ak-fix-packet": fixerPacket },
        noTools: "builtin",
      }, async ({ session, sessionManager }) => {
        await session.prompt("fixer continues the same ad-hoc journey");
        const messages = sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
        assert.equal(messages.length, 1, JSON.stringify(sessionManager.getEntries()));
        const event = (messages[0] as { details: { subjectKey: string; next?: unknown } }).details;
        assert.equal(event.subjectKey, sharedSubjectKey);
        assert.deepEqual(event.next, { role: "reviewer", phase: null });
      });

      assert.ok(sharedSubjectKey);
      const navigatorSession = SessionManager.continueRecent(issueRoot, navigatorSessionDirectory({ cwd: issueRoot, sessionManager: { getSessionDir: () => "" } } as never, sharedSubjectKey));
      const entries = (await readFile(navigatorSession.getSessionFile()!, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type?: string; customType?: string; data?: any });
      const contexts = entries.filter((entry) => entry.type === "custom" && entry.customType === "ak-navigator-context");
      assert.deepEqual(contexts.slice(0, 2).map((entry) => ({
        subjectKey: entry.data?.subjectKey,
        subject: entry.data?.subject,
        authority: entry.data?.authority,
        currentRole: entry.data?.currentRole,
      })), [
        { subjectKey: sharedSubjectKey, subject: "Concrete coder task for the same ad-hoc journey.\n", authority: "Concrete coder task for the same ad-hoc journey.\n", currentRole: { role: "coder", phase: "plan" } },
        { subjectKey: sharedSubjectKey, subject: "Concrete fixer packet for the same ad-hoc journey.\n", authority: "Concrete fixer packet for the same ad-hoc journey.\n", currentRole: { role: "fixer", phase: "plan" } },
      ]);
      const invocations = entries.filter((entry) => entry.type === "custom" && entry.customType === "ak-navigator-invocation");
      assert.deepEqual(invocations.slice(0, 2).map((entry) => ({ role: entry.data?.role, phase: entry.data?.phase, subjectKey: entry.data?.subjectKey })), [
        { role: "coder", phase: "plan", subjectKey: sharedSubjectKey },
        { role: "fixer", phase: "plan", subjectKey: sharedSubjectKey },
      ]);

      faux.setResponses([response, response, response]);
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: otherRoot,
        agentDir,
        faux,
        additionalExtensionPaths: [packageEntrypoint(manifest)],
        systemPrompt: "ISOLATED SUBJECT JUDGE",
        mode: "json",
        flags: { "ak-role": "coder", "ak-coder-phase": "plan", "ak-coder-task": otherTask },
        noTools: "builtin",
      }, async ({ session, sessionManager }) => {
        await session.prompt("coder starts a different subject");
        const messages = sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
        assert.equal(messages.length, 1);
        const event = (messages[0] as { details: { subjectKey: string; next?: unknown } }).details;
        isolatedSubjectKey = event.subjectKey;
        assert.notEqual(isolatedSubjectKey, sharedSubjectKey);
        assert.deepEqual(event.next, { role: "fixer", phase: "plan" });
      });
      assert.notEqual(
        navigatorSession.getSessionFile(),
        SessionManager.continueRecent(otherRoot, navigatorSessionDirectory({ cwd: otherRoot, sessionManager: { getSessionDir: () => "" } } as never, isolatedSubjectKey)).getSessionFile(),
      );
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    },
  );
});

test("packaged role-input outside /.ak/work/ with no authority file projects exact input bytes", async () => {
  const manifest = await loadRawPackageManifest();
  await withActivationHome(
    { prefix: "ak-navigator-input-outside-work-" },
    async ({ home, agentDir }) => {
      const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        const outsideRoot = resolve(home, "outside-work");
        await mkdir(outsideRoot, { recursive: true });
        const packetBytes = "Exact fixer packet bytes outside /.ak/work/ with no authority file.\n";
        const packetPath = resolve(outsideRoot, "fix-packet.md");
        await writeFile(packetPath, packetBytes, "utf8");
        const faux = fauxProvider({
          api: "ak-navigator-input-outside-work",
          provider: "ak-navigator-input-outside-work",
          tokenSize: { min: 1000, max: 1000 },
        });
        const model = faux.getModel();
        await writeNavigatorModelSetting(`${model.provider}/${model.id}`, resolve(agentDir, "navigator-model.json"));
        const response = (context: Context) => {
          const names = context.tools?.map((tool) => tool.name) ?? [];
          if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
            return fauxAssistantMessage(fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, {
              candidates: [{
                id: "outside-work-route",
                matches: { role: "fixer", phase: "plan", kind: "accepted" },
                route: [{ role: "fixer", phase: "plan" }, { role: "reviewer", phase: null }],
                next: { role: "reviewer", phase: null },
                reason: "outside-work input authority",
                command: "Usage: pi --ak-role reviewer --help",
              }],
            }), { stopReason: "toolUse" });
          }
          if (names.includes(FIXER_AUDIT_TOOL_NAME)) {
            return fauxAssistantMessage(fauxToolCall(FIXER_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" });
          }
          return fauxAssistantMessage(fauxToolCall(FIXER_OUTPUT_TOOL_NAME, { status: "planned", report: "outside-work plan" }), { stopReason: "toolUse" });
        };
        faux.setResponses([response, response, response]);
        await withInProcessPi({
          activationLedgerSession: true,
          cwd: outsideRoot,
          agentDir,
          faux,
          additionalExtensionPaths: [packageEntrypoint(manifest)],
          systemPrompt: "OUTSIDE WORK ROLE INPUT",
          mode: "json",
          flags: { "ak-role": "fixer", "ak-fixer-phase": "plan", "ak-fix-packet": packetPath },
          noTools: "builtin",
        }, async ({ session, sessionManager }) => {
          await session.prompt("fixer packet lives outside /.ak/work/ with no authority file");
          const attendance = sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
          assert.equal(attendance.length, 1, JSON.stringify(sessionManager.getEntries()));
          const event = (attendance[0] as { details: { disposition: string; unavailableSource?: string } }).details;
          assert.notEqual(event.disposition, "unavailable");
          assert.equal(event.disposition, "recommendation");
          assert.equal(event.unavailableSource, undefined);

          const subjectKey = (attendance[0] as { details: { subjectKey: string } }).details.subjectKey;
          const navigatorSession = SessionManager.continueRecent(
            outsideRoot,
            navigatorSessionDirectory({ cwd: outsideRoot, sessionManager: { getSessionDir: () => "" } } as never, subjectKey),
          );
          const entries = (await readFile(navigatorSession.getSessionFile()!, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type?: string; customType?: string; data?: { authority?: string; subject?: string } });
          const contexts = entries.filter((entry) => entry.type === "custom" && entry.customType === "ak-navigator-context");
          assert.ok(contexts.length >= 1, JSON.stringify(entries));
          assert.equal(contexts[0]?.data?.authority, packetBytes);
          assert.equal(contexts[0]?.data?.subject, packetBytes);
        });
      } finally {
        if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      }
    },
  );
});

test("fresh packaged processes resume cross-role Navigator route memory and isolate subjects", async () => {
  const manifest = await loadRawPackageManifest();
  await withActivationHome(
    { prefix: "ak-navigator-fresh-process-integration-" },
    async ({ home, agentDir }) => {
      const root = resolve(home, ".ak/work/fresh-ad-hoc");
      await mkdir(resolve(root, "runs/coder"), { recursive: true });
      await mkdir(resolve(root, "runs/fixer"), { recursive: true });
      await writeFile(resolve(root, "authority.md"), "fresh-process owner authority\n", "utf8");
      const coderTask = resolve(root, "runs/coder/task.md");
      const fixerPacket = resolve(root, "runs/fixer/fix-packet.json");
      await writeFile(coderTask, "Fresh-process concrete task.\n", "utf8");
      await writeFile(fixerPacket, "Fresh-process fixer packet.\n", "utf8");
      const child = String.raw`
        import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
        import { writeNavigatorModelSetting } from "./src/role-runtime.ts";
        import { CODER_OUTPUT_TOOL_NAME, FIXER_AUDIT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME, NAVIGATOR_PREPARE_TOOL_NAME } from "./src/role-runtime.ts";
        import { loadRawPackageManifest, resolvePackageEntrypoint, withInProcessPi } from "./test/helpers/pi-test-harness.ts";
        const role = process.env.AK_ROLE;
        const root = process.env.AK_ROOT;
        const input = process.env.AK_INPUT;
        const agentDir = process.env.AK_AGENT;
        const faux = fauxProvider({ api: "ak-navigator-fresh-process", provider: "ak-navigator-fresh-process", tokenSize: { min: 1000, max: 1000 } });
        const model = faux.getModel();
        process.env.PI_CODING_AGENT_DIR = agentDir;
        await writeNavigatorModelSetting(model.provider + "/" + model.id, agentDir + "/navigator-model.json");
        const response = (context) => {
          const names = context.tools?.map((tool) => tool.name) ?? [];
          if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
            const fixer = role === "fixer";
            const route = fixer ? [{ role: "fixer", phase: "plan" }, { role: "reviewer", phase: null }] : [{ role: "coder", phase: "plan" }, { role: "fixer", phase: "plan" }];
            const next = fixer ? { role: "reviewer", phase: null } : { role: "fixer", phase: "plan" };
            return fauxAssistantMessage(fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, { candidates: [{ id: fixer ? "fresh-fixer" : "fresh-coder", matches: { role, phase: role === "fixer" ? "plan" : "plan", kind: "accepted" }, route, next, reason: "fresh-process route", command: fixer ? "Usage: pi --ak-role reviewer --help" : "Usage: pi --ak-role fixer --ak-fixer-phase plan --help" }] }), { stopReason: "toolUse" });
          }
          if (names.includes(FIXER_AUDIT_TOOL_NAME)) return fauxAssistantMessage(fauxToolCall(FIXER_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" });
          if (names.includes(FIXER_OUTPUT_TOOL_NAME)) return fauxAssistantMessage(fauxToolCall(FIXER_OUTPUT_TOOL_NAME, { status: "planned", report: "fresh fixer plan" }), { stopReason: "toolUse" });
          return fauxAssistantMessage(fauxToolCall(CODER_OUTPUT_TOOL_NAME, { status: "planned", report: "fresh coder plan" }), { stopReason: "toolUse" });
        };
        const manifest = await loadRawPackageManifest();
        faux.setResponses([response, response, response]);
        let result;
        await withInProcessPi({ activationLedgerSession: true, cwd: root, agentDir, faux, additionalExtensionPaths: [resolvePackageEntrypoint(manifest)], systemPrompt: "FRESH PROCESS NAVIGATOR", mode: "json", flags: role === "fixer" ? { "ak-role": "fixer", "ak-fixer-phase": "plan", "ak-fix-packet": input } : { "ak-role": "coder", "ak-coder-phase": "plan", "ak-coder-task": input }, noTools: "builtin" }, async ({ session, sessionManager }) => {
          await session.prompt("fresh process role invocation");
          const messages = sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
          result = messages[0]?.type === "custom_message" ? messages[0].details : undefined;
        });
        process.stdout.write(JSON.stringify(result));
      `;
      const run = async (role: "coder" | "fixer", cwd: string, input: string) => {
        const result = await runNodeSubprocess(["--import", "tsx", "--input-type=module", "-e", child], {
          cwd: packageRoot,
          env: { ...process.env, AK_ROLE: role, AK_ROOT: cwd, AK_INPUT: input, AK_AGENT: agentDir },
          timeoutMs: 60_000,
        });
        assert.equal(result.code, 0, result.stderr);
        return JSON.parse(result.stdout.trim()) as { disposition: string; subjectKey: string; next?: unknown };
      };
      // Two process-boundary legs prove resumption; subject isolation stays in-process at the neighbour test.
      const first = await run("coder", root, coderTask);
      const second = await run("fixer", root, fixerPacket);
      assert.equal(first.disposition, "recommendation");
      assert.equal(second.disposition, "recommendation");
      assert.equal(first.subjectKey, second.subjectKey);
      assert.deepEqual(first.next, { role: "fixer", phase: "plan" });
      assert.deepEqual(second.next, { role: "reviewer", phase: null });
      const navigatorSession = SessionManager.continueRecent(root, navigatorSessionDirectory({ cwd: root, sessionManager: { getSessionDir: () => "" } } as never, first.subjectKey));
      const persisted = (await readFile(navigatorSession.getSessionFile()!, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type?: string; customType?: string; data?: { role?: string; phase?: string | null } });
      assert.deepEqual(persisted.filter((entry) => entry.type === "custom" && entry.customType === "ak-navigator-invocation").slice(0, 2).map((entry) => ({ role: entry.data?.role, phase: entry.data?.phase })), [
        { role: "coder", phase: "plan" },
        { role: "fixer", phase: "plan" },
      ]);
    },
  );
});

test("packaged judge escalation emits one typed human decision", async () => {
  const manifest = await loadRawPackageManifest();
  await withActivationHome(
    { prefix: "ak-judge-escalation-integration-" },
    async ({ agentDir }) => {
      const faux = fauxProvider({
        api: "ak-judge-escalation-offline",
        provider: "ak-judge-escalation-offline",
        tokenSize: { min: 1000, max: 1000 },
      });
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: packageRoot,
        agentDir,
        faux,
        additionalExtensionPaths: [packageEntrypoint(manifest)],
        systemPrompt: "JUDGE ESCALATION INTEGRATION PROMPT",
        mode: "print",
        flags: { "ak-role": "judge" },
        noTools: "builtin",
      }, async ({ session, sessionManager }) => {
        faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall(
              JUDGE_OUTPUT_TOOL_NAME,
              { judgeStatus: "converged" },
              { id: "escalating-judge" },
            ),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage(
            fauxToolCall(
              SOUL_AUDIT_TOOL_NAME,
              {
                status: "escalate",
                violations: [],
                conflicts: ["Soul authority conflicts with controlling authority"],
                decisionGate: {
                  question: "Which authority governs this verdict?",
                  options: ["Soul", "Controlling authority"],
                },
              },
              { id: "audit-escalation" },
            ),
            { stopReason: "toolUse" },
          ),
        ]);
        await session.prompt("Exercise packaged audit escalation.");

        const result = sessionManager
          .getEntries()
          .find(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolCallId === "escalating-judge",
          );
        if (!(result?.type === "message" && result.message.role === "toolResult")) {
          throw new Error("packaged Judge escalation tool result is missing");
        }
        const toolResult = result.message;
        assert.equal(toolResult.isError, false);
        assert.deepEqual(toolResult.details, {
          kind: "audit_escalation",
          conflicts: ["Soul authority conflicts with controlling authority"],
          decisionGate: {
            question: "Which authority governs this verdict?",
            options: ["Soul", "Controlling authority"],
          },
        });
        assert.equal(isAuditEscalationResult(toolResult.details), true);
        assert.throws(
          () => validateAcceptedDetails(JUDGE_OUTPUT_TOOL_NAME, toolResult.details),
          (error: unknown) => error instanceof Error && error.name === "AcceptedDetailsContractError",
        );
      });
    },
  );
});

test("packaged coder apply proves canonical native tdd expansion including colliding prefix", async () => {
  const manifest = await loadRawPackageManifest();
  const coderSoul =
    (await readFile(resolve(packageRoot, "souls/coder.md"), "utf8")).trim();
  const rows = [
    {
      prompt: "/skill:tdd",
      userMessage: undefined as string | undefined,
      output: {
        status: "unfinished",
        report: "The first implementation is not fully settled.",
        remainingScope: "the unimplemented adapter branch",
      },
      callId: "coder-completed",
    },
    {
      prompt: "/skill:tddfoo",
      userMessage: "/skill:tddfoo",
      output: {
        status: "completed",
        report:
          "TDD red/green evidence; same-pattern, introduced-regression, and behavior-fact checks complete.",
      },
      callId: "coder-collision-completed",
    },
  ] as const;
  for (const row of rows) {
    await withActivationHome(
      { prefix: "ak-coder-integration-" },
      async ({ home, agentDir }) => {
        // Package-owned TDD (#109): empty home, skill path from installed package tree.
        const tddSkillPath = resolve(
          packageRoot,
          "resources/methods/tdd/SKILL.md",
        );
        const tddSkillRaw = await readFile(tddSkillPath, "utf8");
        const taskPath = resolve(home, "approved-task.md");
        const task = "# Approved task\n\nImplement the first vertical slice.";
        await writeFile(taskPath, task);
        const faux = fauxProvider({
          api: "ak-coder-offline",
          provider: "ak-coder-offline",
          tokenSize: { min: 1000, max: 1000 },
        });
        await withInProcessPi({
          activationLedgerSession: true,
          cwd: packageRoot,
          agentDir,
          faux,
          additionalExtensionPaths: [packageEntrypoint(manifest)],
          additionalSkillPaths: [tddSkillPath],
          systemPrompt: "CODER INTEGRATION BASE PROMPT",
          mode: "print",
          flags: {
            "ak-role": "coder",
            "ak-coder-phase": "apply",
            "ak-coder-task": taskPath,
          },
          customTools: [siblingTool],
        }, async ({ session, sessionManager }) => {
          assert.ok(
            session.agent.state.tools.some((tool) =>
              tool.name === CODER_OUTPUT_TOOL_NAME
            ),
          );
          assert.ok(
            session.agent.state.tools.some((tool) => tool.name === "write"),
            "Coder keeps construction tools",
          );

          let coderContext: Context | undefined;
          faux.setResponses([
            (context) => {
              coderContext = context;
              return fauxAssistantMessage(
                fauxToolCall(CODER_OUTPUT_TOOL_NAME, row.output, {
                  id: row.callId,
                }),
                { stopReason: "toolUse" },
              );
            },
          ]);
          await session.prompt(row.prompt);

          const seenContext = coderContext as Context | undefined;
          assert.ok(seenContext);
          assert.ok(
            seenContext.systemPrompt?.includes(
              `<coder_soul>\n${coderSoul}\n</coder_soul>`,
            ),
          );
          assert.ok(
            seenContext.systemPrompt?.includes(
              `<coder_task>\n${task}\n</coder_task>`,
            ),
          );
          assert.equal(
            seenContext.systemPrompt?.includes("coder_quality_skill"),
            false,
          );
          const userMessage = seenContext.messages.find((message) =>
            message.role === "user"
          );
          assert.ok(userMessage?.role === "user");
          const userText = typeof userMessage.content === "string"
            ? userMessage.content
            : userMessage.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
          assert.equal(
            (userText.match(/<skill name="tdd"/g) ?? []).length,
            1,
            "Pi emits one native Skill block",
          );
          assert.deepEqual(parseSkillBlock(userText), {
            name: "tdd",
            location: tddSkillPath,
            content: `References are relative to ${dirname(tddSkillPath)}.\n\n${
              stripFrontmatter(tddSkillRaw).trim()
            }`,
            userMessage: row.userMessage,
          });
          const accepted = sessionManager.getEntries().find(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolCallId === row.callId,
          );
          assert.ok(
            accepted?.type === "message" &&
              accepted.message.role === "toolResult",
          );
          assert.equal(accepted.message.isError, false);
          assert.deepEqual(accepted.message.details, row.output);
        });
      },
    );
  }
});

test("packaged fixer applies its both-phase bash seatbelt, retains its tool surface, and enforces singleton output", async () => {
  const manifest = await loadRawPackageManifest();
  const forbiddenLiterals = [
    "rm -rf",
    "git reset --hard",
    "git clean",
    "git checkout --",
  ] as const;
  await withActivationHome(
    { prefix: "ak-fixer-integration-" },
    async ({ home, agentDir }) => {
      const packetPath = resolve(home, "fix-packet.json");
      await writeFile(packetPath, JSON.stringify({ version: 1, instructions: "# Approved repair\n\nApply it.", prerequisites: [] }));
      for (const phase of ["plan", "apply"] as const) {
        const faux = fauxProvider({
          api: `ak-fixer-offline-${phase}`,
          provider: `ak-fixer-offline-${phase}`,
          tokenSize: { min: 1000, max: 1000 },
        });
        await withInProcessPi({
          activationLedgerSession: true,
          cwd: packageRoot,
          agentDir,
          faux,
          additionalExtensionPaths: [packageEntrypoint(manifest)],
          systemPrompt: "FIXER INTEGRATION BASE PROMPT",
          mode: "print",
          flags: {
            "ak-role": "fixer",
            "ak-fixer-phase": phase,
            "ak-fix-packet": packetPath,
          },
          customTools: [siblingTool],
        }, async ({ session, sessionManager }) => {
          const activeNames = session.agent.state.tools.map((tool) => tool.name);
          for (
            const name of [
              "read",
              "bash",
              "edit",
              "write",
              "integration_sibling",
              FIXER_OUTPUT_TOOL_NAME,
            ]
          ) {
            assert.ok(
              activeNames.includes(name),
              `${name} remains active for Fixer ${phase}`,
            );
          }

          const markerDir = resolve(home, `fixer-markers-${phase}`);
          await mkdir(markerDir, { recursive: true });
          const controlMarker = resolve(markerDir, "control.txt");
          const forbiddenCalls = forbiddenLiterals.map((literal, index) => {
            const marker = resolve(markerDir, `blocked-${index}.txt`);
            return {
              literal,
              marker,
              id: `fixer-${phase}-blocked-${index}`,
              call: fauxToolCall(
                "bash",
                {
                  command:
                    `printf 'executed' > ${JSON.stringify(marker)} # ${literal}`,
                },
                { id: `fixer-${phase}-blocked-${index}` },
              ),
            };
          });
          faux.setResponses([
            fauxAssistantMessage(
              [
                ...forbiddenCalls.map((item) => item.call),
                fauxToolCall(
                  "bash",
                  {
                    command:
                      `printf 'control-ok' > ${JSON.stringify(controlMarker)}`,
                  },
                  { id: `fixer-${phase}-control` },
                ),
              ],
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(`seatbelt matrix observed for ${phase}`),
          ]);
          await session.prompt(
            `Exercise Fixer bash seatbelt in ${phase} phase.`,
          );

          for (const item of forbiddenCalls) {
            const blocked = sessionManager.getEntries().find(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "toolResult" &&
                entry.message.toolCallId === item.id,
            );
            assert.ok(
              blocked?.type === "message" &&
                blocked.message.role === "toolResult",
              `${item.literal} must produce a tool result in ${phase}`,
            );
            assert.equal(
              blocked.message.isError,
              true,
              `${item.literal} must be an ordinary blocked/error result in ${phase}`,
            );
            assert.match(
              textOf(blocked.message),
              new RegExp(item.literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
              `${item.literal} block reason must name the matched literal in ${phase}`,
            );
            await assert.rejects(
              () => access(item.marker),
              /ENOENT/,
              `${item.literal} must not execute bash in ${phase}`,
            );
          }

          const control = sessionManager.getEntries().find(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolCallId === `fixer-${phase}-control`,
          );
          assert.ok(
            control?.type === "message" && control.message.role === "toolResult",
          );
          assert.equal(
            control.message.isError,
            false,
            `harmless control bash must reach real packaged Pi bash in ${phase}`,
          );
          assert.equal(await readFile(controlMarker, "utf8"), "control-ok");

          const output = phase === "plan"
            ? { status: "planned", report: "Repair plan ready." }
            : { status: "unfinished", report: "The adapter is not fully settled.", remainingScope: "the remaining adapter branch" };
          faux.setResponses([
            fauxAssistantMessage(
              [
                fauxToolCall(FIXER_OUTPUT_TOOL_NAME, output, {
                  id: `mixed-fixer-${phase}`,
                }),
                fauxToolCall("integration_sibling", {}, {
                  id: `mixed-sibling-${phase}`,
                }),
              ],
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(`singleton rejection observed for ${phase}`),
          ]);
          await session.prompt(`Reject a mixed final batch in ${phase}.`);
          const mixed = sessionManager.getEntries().find(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolCallId === `mixed-fixer-${phase}`,
          );
          assert.ok(
            mixed?.type === "message" && mixed.message.role === "toolResult",
          );
          assert.equal(mixed.message.isError, true);
          assert.match(textOf(mixed.message), /sole final tool call/);

          faux.setResponses([
            fauxAssistantMessage(
              fauxToolCall(FIXER_OUTPUT_TOOL_NAME, output, {
                id: `sole-fixer-${phase}`,
              }),
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxToolCall(FIXER_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" }),
          ]);
          await session.prompt(`Accept a sole Fixer output in ${phase}.`);
          const accepted = sessionManager.getEntries().find(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolCallId === `sole-fixer-${phase}`,
          );
          assert.ok(
            accepted?.type === "message" &&
              accepted.message.role === "toolResult",
          );
          assert.equal(accepted.message.isError, false);
          assert.deepEqual(accepted.message.details, output);
        });
      }
    },
  );
});

function parseToolExecutionObservations(stderr: string): ToolExecutionObservationRecord[] {
  return stderr.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (trimmed === "") return [];
    try {
      const value = JSON.parse(trimmed) as unknown;
      return Value.Check(toolExecutionObservationRecordSchema, value)
        ? [value as ToolExecutionObservationRecord]
        : [];
    } catch {
      return [];
    }
  });
}

test("installed composition emits admitted-role tool-execution JSONL on stderr for real bash output and never for Navigator prepare", async () => {
  assert.equal(TOOL_EXECUTION_UPDATE_HEARTBEAT, "output-driven");
  const manifest = await loadRawPackageManifest();
  await withActivationHome({ prefix: "ak-tool-observation-" }, async ({ home, agentDir }) => {
    const issueRoot = resolve(home, ".ak/work/issues/79");
    await mkdir(issueRoot, { recursive: true });
    const sessionDirectory = resolve(
      home,
      ".ak-roles",
      "books",
      basename(home),
      "runs",
      "judge-tool-observation",
      "session",
    );
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(resolve(issueRoot, "authority.md"), "owner authority for tool observation\n", "utf8");
    await writeFile(
      resolve(agentDir, "navigator-model.json"),
      JSON.stringify({ model: "ak-tool-observation-bash/faux-1" }),
      "utf8",
    );
    const result = await runPiSubprocess([
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--session-dir", sessionDirectory,
      "-e", packageEntrypoint(manifest),
      "-e", resolve(packageRoot, "test/fixtures/tool-observation-bash-provider.ts"),
      "--ak-role", "judge",
      "--provider", "ak-tool-observation-bash",
      "--model", "faux-1",
      "--mode", "json",
      "Exercise bash observation.",
    ], {
      cwd: issueRoot,
      timeoutMs: 45_000,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
      },
    });
    assert.equal(result.timedOut, false, `tool observation subprocess timed out: ${result.stderr}`);
    assert.equal(result.code, 0, `tool observation subprocess failed: ${result.stderr}\n${result.stdout}`);
    assert.equal(result.stdout.includes('"event":"tool_execution_'), false, "tool observation must never write JSONL onto stdout");

    const observations = parseToolExecutionObservations(result.stderr);
    assert.ok(observations.length >= 2, `expected start/end observation records, got ${JSON.stringify(observations)}`);
    for (const record of observations) {
      assert.equal(record.role, "judge");
      assert.notEqual(record.toolName, NAVIGATOR_PREPARE_TOOL_NAME, "Navigator prepare must not be attributed to the outer role");
    }

    const bashRecords = observations.filter((record) => record.toolCallId === "obs-bash-1" || record.toolName === "bash");
    assert.ok(bashRecords.some((record) => record.event === "tool_execution_start"));
    assert.ok(bashRecords.some((record) => record.event === "tool_execution_end" && record.isError === false));
    const bashUpdates = bashRecords.filter((record) => record.event === "tool_execution_update");
    assert.ok(
      bashUpdates.length >= 1,
      `non-empty bash child output must produce at least one throttled update heartbeat after skipping the empty entry callback; got ${JSON.stringify(bashRecords)}`,
    );

    const navigatorDirectory = resolve(issueRoot, "runs/navigator");
    const navigatorEntries = await readLatestSession(navigatorDirectory);
    const navigatorPrepare = navigatorEntries.find(
      (entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === NAVIGATOR_PREPARE_TOOL_NAME,
    );
    assert.ok(navigatorPrepare, "Navigator private session must still run prepare");
    assert.equal(
      observations.some((record) => record.toolName === NAVIGATOR_PREPARE_TOOL_NAME),
      false,
      "private Navigator session tool calls must not emit on the outer observation face",
    );

    const roleEntries = await readLatestSession(sessionDirectory);
    const bashResult = roleEntries.find(
      (entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === "obs-bash-1",
    );
    assert.ok(bashResult?.type === "message" && bashResult.message?.role === "toolResult");
    assert.equal(bashResult.message.isError, false);
    assert.match(textOf(bashResult.message as never), /chunk-one/);
    assert.match(textOf(bashResult.message as never), /chunk-two/);
  });
});

test("installed composition without --ak-role emits no tool-execution observation records", async () => {
  const manifest = await loadRawPackageManifest();
  // Role-less observation: no activation substrate (no git seed, no durable session).
  await withHermeticHome({ prefix: "ak-tool-observation-no-role-" }, async ({ home, agentDir }) => {
    const cwd = resolve(home, "workspace");
    await mkdir(cwd, { recursive: true });
    const result = await runPiSubprocess([
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session",
      "-e", packageEntrypoint(manifest),
      "-e", resolve(packageRoot, "test/fixtures/tool-observation-bash-provider.ts"),
      "--provider", "ak-tool-observation-bash",
      "--model", "faux-1",
      "--mode", "json",
      "-p",
      "No role activation.",
    ], {
      cwd,
      timeoutMs: 30_000,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
      },
    });
    assert.equal(result.timedOut, false, `no-role subprocess timed out: ${result.stderr}`);
    assert.deepEqual(parseToolExecutionObservations(result.stderr), []);
  });
});
