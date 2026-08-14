/**
 * #319 Batch 4 (R1): thematic split from package-entrypoint.integration.test.ts.
 * Packaged workers: pack contents, auditors, judge/coder/fixer gates
 * All split files remain on the heavy serial manifest (庭定『先拆且全留 heavy』).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
  machineLedgerHome,
  withActivationHome,
  withHermeticHome,
  withInProcessPi,
  withColdInstalledPackage,
  writeTestSkill,
} from "../helpers/pi-test-harness.ts";

import {
  siblingTool,
  textOf,
  packageEntrypoint,
} from "../helpers/package-entrypoint-fixtures.ts";


test("packed package includes Doctor role, evidence flag, and runtime dependencies", async () => {
  const manifest = await loadRawPackageManifest();
  packageEntrypoint(manifest);
  assert.equal(manifest.bin?.["ak-role"], "dist/public-cli/main.js");
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

test("cold-installed package audits active auditor seats from editable Souls", async () => {
  await withActivationHome(
    { prefix: "ak-auditor-package-" },
    async ({ home }) => {
      await withColdInstalledPackage(home, async ({ installedRoot, installed }) => {
      const [judge, reviewer, doctor] = await Promise.all([
        installed("src/judge-auditor.ts"),
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
// Judge/reviewer/doctor auditors take zero hand-delivered materials (#233).
      // Fixer LLM auditor retired (#242) — active auditor seats only.
      // Seed the real run record shape; the locator binds from the parent record,
      // never from an environment-variable convention.
      const runDirectory = resolve(installedRoot, "fixture-run");
      await mkdir(resolve(runDirectory, "session"), { recursive: true });
      await mkdir(resolve(runDirectory, "attachments"));
      await mkdir(resolve(runDirectory, "artifacts"));
      await writeFile(resolve(runDirectory, "admitted-request.json"), "{}\n");
      context.sessionManager = SessionManager.open(resolve(runDirectory, "session/session.jsonl"));
      context.sessionManager.appendMessage({ role: "user", content: "assignment", timestamp: Date.now() });
      context.sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "v1", name: "ak_judge_output", arguments: { judgeStatus: "converged" } }],
        api: "openai-responses", provider: "test", model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse", timestamp: Date.now(),
      });
      context.sessionManager.appendCustomEntry("ak_reviewer_audit_candidate", { version: 1, candidate: {} });
      context.sessionManager.appendCustomEntry("ak_doctor_audit_candidate", { version: 1, testimony: {} });
      const roles = [
        { name: "judge", toolName: judge.JUDGE_AUDIT_TOOL_NAME, soulPath: resolve(installedRoot, "souls/judge-auditor.md"), run: (completion: ComplianceCompletion) => judge.createPiJudgeAuditor(completion)({ context }) },
        { name: "reviewer", toolName: reviewer.REVIEWER_AUDIT_TOOL_NAME, soulPath: resolve(installedRoot, "souls/reviewer-auditor.md"), run: (completion: ComplianceCompletion) => reviewer.createPiReviewerAuditor(completion)({ context }) },
        { name: "doctor", toolName: doctor.DOCTOR_AUDIT_TOOL_NAME, soulPath: resolve(installedRoot, "souls/doctor-auditor.md"), run: (completion: ComplianceCompletion) => doctor.createPiDoctorAuditor(completion)({ context }) },
      ] as const;
      const run = async (role: (typeof roles)[number]) => {
        let calls = 0;
        let prompt = "";
        const completion: ComplianceCompletion = async (_model, request) => {
          calls += 1;
          prompt = request.systemPrompt ?? "";
          const locator = request.tools?.find((tool) => tool.name === "ak_get_run_dossier");
          assert.ok(locator, `${role.name} must expose the shared dossier locator`);
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
  const nestedRunDir = await mkdtemp(join(tmpdir(), "ak-nested-audit-run-"));
  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
  process.env.AK_ROLE_RUN_DIR = nestedRunDir;
  try {
  {
      const [judge, reviewer, doctor, judgeRole, workerRole, reviewerRole, doctorRole, terminating] = await Promise.all([
        importSrc("src/judge-auditor.ts"),
        importSrc("src/reviewer-auditor.ts"),
        importSrc("src/doctor-auditor.ts"),
        importSrc("src/judge-role.ts"),
        importSrc("src/worker-role.ts"),
        importSrc("src/reviewer-role.ts"),
        importSrc("src/doctor-role.ts"),
        importSrc("src/package-contracts/terminating-tools.ts"),
      ]);

      const patient = {
        version: 1,
        identity: { issueNumber: 58, runsPath: ".ak/work/issues/58/runs" },
        evidence: [],
        cost: { invocations: { total: 0, sources: [] }, bytes: 0 },
      };
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
        const hostTools = ["read", "write", "grep", "find", "bash"];
        let activeTools: string[] = [...hostTools];
        const pi = {
          registerFlag() {},
          getFlag(name: string) { return flags[name]; },
          registerTool(tool: any) { tools.set(tool.name, tool); },
          getAllTools() { return [...hostTools, ...tools.keys()].map((name) => ({ name })); },
          setActiveTools(names: string[]) { activeTools = [...names]; },
          getActiveTools() { return activeTools; },
          on(name: string, handler: any) { handlers.set(name, handler); },
        };
        return { pi, tools, handlers, activeTools: () => [...activeTools] };
      };
      const outputContext = (name: string, id: string, arguments_: Record<string, unknown> = {}) => {
        const sessionManager = SessionManager.inMemory();
        sessionManager.appendMessage({ role: "user", content: "assignment", timestamp: Date.now() });
        sessionManager.appendMessage({
          role: "assistant",
          content: [{ type: "toolCall", id, name, arguments: arguments_ }],
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
            ? makeHarness({ "ak-review-base": "review-base" })
            : role === "doctor"
              ? makeHarness({ "ak-doctor-case": "/case" })
              : makeHarness();
        let auditCalls = 0;
        let selectedDecision = decision;
        const complete = async (_model: unknown, _request: Context) => {
          auditCalls += 1;
          const auditTool = toolNames[role as Exclude<typeof role, "fixer">];
          return fauxAssistantMessage(fauxToolCall(auditTool, selectedDecision), { stopReason: "toolUse" });
        };
// Judge/reviewer/doctor: zero-arg materials (#233). Fixer LLM auditor retired (#242).
        const auditCompliance = (options: any) => {
          if (role === "judge") return judge.createPiJudgeAuditor(complete)(options);
          if (role === "reviewer") return reviewer.createPiReviewerAuditor(complete)(options);
          return doctor.createPiDoctorAuditor(complete)(options);
        };
        let runtime: any;
        if (role === "judge") {
          runtime = judgeRole.createJudgeRoleRuntime(harness.pi, {
            loadSoul: async () => "judge law",
            auditSoulCompliance: auditCompliance,
          }, { failInfrastructure(error: unknown) { throw error; } });
        } else if (role === "fixer") {
          runtime = workerRole.createFixerRoleRuntime(harness.pi, {
            loadSoul: async () => "fixer law",
            loadPacket: async () => "repair packet",
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
            loadCanonicalSkillBinding: async () => ({
              name: "code-review",
              snapshot: { raw: skill, path: "/skill", baseDir: "/", body: skill, snapshotIdentity: Object.freeze({ text: skill }) },
              invocation: (request: string) => request,
              captureExpansion: () => ({ name: "code-review" as const, location: "/skill", content: skill }),
            }),
            createPinnedGitReader: async () => ({
              pin,
              snapshot: async () => pin,
              resolve: async () => "base",
              range: async () => ({ base: "base", target: "target", diffCommand: "git diff base...target", diffSha256: "a".repeat(64), commits: ["target"] }),
              featureTokens: async () => Object.freeze([]),
            }),
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
        const toolName = role === "judge" ? judgeRole.JUDGE_OUTPUT_TOOL_NAME : role === "fixer" ? workerRole.FIXER_OUTPUT_TOOL_NAME : role === "reviewer" ? reviewerRole.REVIEWER_OUTPUT_TOOL_NAME : doctorRole.DOCTOR_OUTPUT_TOOL_NAME;
        if (role === "fixer") {
          // #242: Fixer LLM auditor retired — accept on schema validate only, no audit leg.
          const plain = createRole(role, pass);
          await plain.runtime.activate();
          const tool = plain.harness.tools.get(toolName);
          assert.ok(tool);
          const accepted = await tool.execute(`${role}-pass`, outputs[role], undefined, undefined, outputContext(tool.name, `${role}-pass`));
          assert.equal(accepted.terminate, true);
          assert.deepEqual(accepted.details, outputs[role]);
          assert.equal(plain.auditCalls, 0);
          continue;
        }
        const retriable = createRole(role, revise);
        await retriable.runtime.activate();
        if (role === "reviewer") {
          assert.deepEqual(
            retriable.harness.activeTools(),
            ["read", "write", "grep", "find", "bash"],
            "Reviewer activation must preserve Pi's evidence tool surface",
          );
        }
        const tool = retriable.harness.tools.get(toolName);
        assert.ok(tool);
        await assert.rejects(tool.execute(`${role}-revise`, outputs[role], undefined, undefined, outputContext(tool.name, `${role}-revise`, outputs[role] as Record<string, unknown>)), /violation|violates its|closed contract/);
        retriable.setDecision(pass);
        const accepted = await tool.execute(`${role}-pass`, outputs[role], undefined, undefined, outputContext(tool.name, `${role}-pass`, outputs[role] as Record<string, unknown>));
        assert.equal(accepted.terminate, true);
        if (role === "judge") assert.equal(accepted.details.judgeStatus, outputs[role].judgeStatus);
        else assert.equal(accepted.details.status, outputs[role].status);
        if (role !== "reviewer") assert.deepEqual(accepted.details, outputs[role]);
        assert.equal(retriable.auditCalls, 2, `${role} must audit the rejected submission and its resubmission`);

        const escalated = createRole(role, escalation);
        await escalated.runtime.activate();
        const escalationTool = escalated.harness.tools.get(tool.name);
        const result = await escalationTool.execute(`${role}-escalate`, outputs[role], undefined, undefined, outputContext(tool.name, `${role}-escalate`, outputs[role] as Record<string, unknown>));
        assert.equal(result.terminate, true);
        // Escalation face carries audit kind/conflicts/gate AND the seat's
        // already-delivered fields (ADR 0055). Old "exactly three keys" deepEqual
        // encoded the destruction this ticket forbids.
        assert.equal(result.details.kind, "audit_escalation");
        assert.deepEqual(result.details.conflicts, escalation.conflicts);
        assert.deepEqual(result.details.auditDecisionGate, escalation.decisionGate);
        for (const [key, value] of Object.entries(outputs[role])) {
          assert.deepEqual(
            (result.details as Record<string, unknown>)[key],
            value,
            `${role} delivered field ${key} must ride the escalate face`,
          );
        }
        assert.equal(isAuditEscalationResult(result.details), true);
        assert.throws(
          () => terminating.validateAcceptedDetails(acceptedNames[role], result.details),
          (error: unknown) => error instanceof Error && error.name === "AcceptedDetailsContractError",
        );
        assert.equal(escalated.auditCalls, 1);
      }
  }
  } finally {
    if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previousRunDir;
    await rm(nestedRunDir, { recursive: true, force: true });
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
      try {
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
        const activeToolNames = session.agent.state.tools.map((tool) => tool.name);
        assert.ok(
          activeToolNames.includes("integration_sibling") &&
            activeToolNames.includes(JUDGE_OUTPUT_TOOL_NAME),
          "Judge activation preserves host tools and activates its output",
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
        // #233 zero projection: user prompt carries no hand-delivered soul/transcript/verdict.
        assert.equal(/judge_soul|adjudication_record|proposed_verdict/.test(auditText), false);
        // Soul is systemPrompt only — auditor loads it itself.
        assert.ok(
          (seenAuditContext.systemPrompt?.length ?? 0) > 0,
          "auditor system prompt must carry the installed judge-auditor soul",
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
        const recommendation = (attendanceMessages[0] as { details: { disposition: string; next?: { role: string; phase: string | null }; reason?: string; command?: string; role?: string; invocationId?: string } }).details;
        assert.equal(recommendation.disposition, "recommendation");
        assert.equal(recommendation.role, "judge");
        assert.deepEqual(recommendation.next, { role: "fixer", phase: "apply" });
        assert.equal(recommendation.reason, "accepted judge should proceed to fixer apply");
        // Command is registry-rendered from recognized next, not model prose.
        assert.equal(recommendation.command, "ak-role fixer apply");
        // Exact named session principal is the only authoritative surface.
        assert.equal(typeof sessionManager.getSessionFile?.() === "string" || sessionManager.getSessionDir().length > 0, true);
        // Shared lifecycle principal on the exact role session (pi.appendEntry), bound to attendance.
        const invocationMarkers = entries.filter(
          (entry) => entry.type === "custom" && (entry as { customType?: string }).customType === "ak-navigator-invocation",
        );
        assert.ok(invocationMarkers.length >= 1, "exact session carries independent invocation principal marker");
        const markersBeforeTerminal = invocationMarkers.filter((entry) => entries.indexOf(entry) < acceptedIndex);
        assert.ok(markersBeforeTerminal.length >= 1, "principal marker is before the role terminal");
        const nearest = markersBeforeTerminal[markersBeforeTerminal.length - 1] as {
          data?: { invocationId?: string };
        };
        assert.equal(typeof nearest.data?.invocationId, "string");
        assert.ok(String(nearest.data?.invocationId).length > 0);
        assert.equal(recommendation.invocationId, nearest.data?.invocationId);
        // Opaque uuidv7 principal — not sessionId:sequence spelling.
        const { isUuidV7 } = await import("../../src/uuidv7.ts");
        assert.equal(isUuidV7(nearest.data?.invocationId), true);
        assert.equal(String(nearest.data?.invocationId).includes(":"), false);

        // Nested auditor JSONL stays under the parent session dir, not repo root.
        // activationLedgerSession supplies real file+dir topology (ADR 0048).
        const parentSessionFile = sessionManager.getSessionFile();
        const parentDir = sessionManager.getSessionDir();
        assert.equal(typeof parentSessionFile, "string");
        assert.ok(String(parentSessionFile).length > 0);
        assert.equal(parentDir, dirname(parentSessionFile!));
        assert.equal(sessionManager.getHeader()?.cwd, packageRoot);
        const auditorDir = join(parentDir, "auditor-roles");
        const auditorFiles = (await readdir(auditorDir))
          .filter((file) => file.endsWith(".jsonl"))
          .sort();
        assert.ok(auditorFiles.length >= 1, "nested auditor wrote under parent session dir");
        const auditorHeader = JSON.parse(
          (await readFile(join(auditorDir, auditorFiles[0]!), "utf8")).trim().split("\n")[0]!,
        ) as { type?: string; cwd?: string };
        assert.equal(auditorHeader.type, "session");
        assert.equal(auditorHeader.cwd, packageRoot);
        await assert.rejects(
          () => access(resolve(packageRoot, "auditor-roles")),
          (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        );
      });
      } finally {
        if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      }
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
        // Audit face + delivered judge verdict retained together (ADR 0055).
        assert.equal(toolResult.details.kind, "audit_escalation");
        assert.deepEqual(toolResult.details.conflicts, [
          "Soul authority conflicts with controlling authority",
        ]);
        assert.deepEqual(toolResult.details.auditDecisionGate, {
          question: "Which authority governs this verdict?",
          options: ["Soul", "Controlling authority"],
        });
        assert.equal(
          (toolResult.details as { judgeStatus?: unknown }).judgeStatus,
          "converged",
        );
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
        reason: "prerequisite_missing: owner has not chosen the adapter branch",
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
        // Worktree is a temp git repo — never arm the real package checkout (gate ②④ install).
        const work = resolve(home, "work");
        await mkdir(work, { recursive: true });
        execFileSync("git", ["init", "-b", "main"], { cwd: work });
        execFileSync("git", ["config", "user.email", "coder-tdd@test.local"], { cwd: work });
        execFileSync("git", ["config", "user.name", "Coder TDD"], { cwd: work });
        execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: work });
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
          cwd: work,
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
          // completed zero-commit: ① bounces once; same payload resubmit confirms.
          // unfinished: ① does not apply — single call accepted.
          const firstCallId = row.output.status === "completed"
            ? `${row.callId}-bounce`
            : row.callId;
          faux.setResponses(
            row.output.status === "completed"
              ? [
                (context) => {
                  coderContext = context;
                  return fauxAssistantMessage(
                    fauxToolCall(CODER_OUTPUT_TOOL_NAME, row.output, {
                      id: firstCallId,
                    }),
                    { stopReason: "toolUse" },
                  );
                },
                () =>
                  fauxAssistantMessage(
                    fauxToolCall(CODER_OUTPUT_TOOL_NAME, row.output, {
                      id: row.callId,
                    }),
                    { stopReason: "toolUse" },
                  ),
              ]
              : [
                (context) => {
                  coderContext = context;
                  return fauxAssistantMessage(
                    fauxToolCall(CODER_OUTPUT_TOOL_NAME, row.output, {
                      id: row.callId,
                    }),
                    { stopReason: "toolUse" },
                  );
                },
              ],
          );
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
          if (row.output.status === "completed") {
            const bounced = sessionManager.getEntries().find(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "toolResult" &&
                entry.message.toolCallId === firstCallId,
            );
            assert.ok(
              bounced?.type === "message" &&
                bounced.message.role === "toolResult",
            );
            assert.equal(bounced.message.isError, true);
            assert.match(textOf(bounced.message), /未观察到 commit/);
          }
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
      // Temp git worktree — production arm must not mutate the real package checkout.
      const work = resolve(home, "work");
      await mkdir(work, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: work });
      execFileSync("git", ["config", "user.email", "fixer-seatbelt@test.local"], { cwd: work });
      execFileSync("git", ["config", "user.name", "Fixer Seatbelt"], { cwd: work });
      execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: work });
      for (const phase of ["plan", "apply"] as const) {
        const faux = fauxProvider({
          api: `ak-fixer-offline-${phase}`,
          provider: `ak-fixer-offline-${phase}`,
          tokenSize: { min: 1000, max: 1000 },
        });
        await withInProcessPi({
          activationLedgerSession: true,
          cwd: work,
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
            : { status: "unfinished", report: "The adapter is not fully settled.", remainingScope: "the remaining adapter branch", reason: "prerequisite_missing: adapter branch owner answer absent" };
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
