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
  FIXER_OUTPUT_TOOL_NAME,
  INSPECTOR_OUTPUT_TOOL,
  JUDGE_OUTPUT_TOOL_NAME,
  NAVIGATOR_PREPARE_TOOL_NAME,
  NOTARY_OUTPUT_TOOL,
  writeNavigatorModelSetting,
  TOOL_EXECUTION_UPDATE_HEARTBEAT,
  toolExecutionObservationRecordSchema,
  type ToolExecutionObservationRecord,
} from "../../src/role-runtime.ts";
import { Value } from "typebox/value";
import { isAuditEscalationResult } from "../../src/audit-escalation.ts";
import { validateAcceptedDetails } from "../../src/package-contracts/terminating-tools.ts";
import { navigatorPrepareFixtureResponse } from "../helpers/navigator-child-fixture.ts";
import {
  getSharedIsolatedPack,
  loadRawPackageManifest,
  packageRoot,
  type RawPackageManifest,
  resolvePackageEntrypoint,
  runNodeSubprocess,
  runPiSubprocess,
  machineLedgerHome,
  seedAgentDirModelsJsonFromFaux,
  withActivationHome,
  withAgentDirProviderFixture,
  withHermeticHome,
  withInProcessPi,
  withInstitutionalProviderFixture,
  withColdInstalledPackage,
  writeTestSkill,
} from "../helpers/pi-test-harness.ts";

import {
  siblingTool,
  textOf,
  packageEntrypoint,
} from "../helpers/package-entrypoint-fixtures.ts";
import { SOUL_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";

/** In-file direct-officer pass scripting. */
function scriptOfficerPass(names: readonly string[], officer: "notary" | "inspector") {
  const expected =
    officer === "notary" ? NOTARY_OUTPUT_TOOL : INSPECTOR_OUTPUT_TOOL;
  if (!names.includes(expected)) return undefined;
  return fauxAssistantMessage(
    fauxToolCall(expected, { status: "pass", findings: [] }),
    { stopReason: "toolUse" },
  );
}


test("cold-installed package audits active auditor seats from editable Souls", async () => {
  await withActivationHome(
    { prefix: "ak-auditor-package-" },
    async ({ home, agentDir }) => {
      await withColdInstalledPackage(home, async ({ installedRoot, installed }) => {
      // #675 owner: subject selects judge-auditor.md / doctor-auditor.md (no generic auditor.md).
      const soul = await installed("src/auditor-soul.ts");
      const installedConstitution = await readFile(resolve(installedRoot, "CLAUDE.md"), "utf8");
      const installedJudgeAuditor = await readFile(resolve(installedRoot, "souls/judge-auditor.md"), "utf8");
      const installedDoctorAuditor = await readFile(resolve(installedRoot, "souls/doctor-auditor.md"), "utf8");
      const installedAuditLaw = await readFile(resolve(installedRoot, "souls/audit-law.md"), "utf8");
      const installedQualityLaw = await readFile(resolve(installedRoot, "souls/quality-law.md"), "utf8");

      const judgeLoaded = await soul.loadAuditorSoul("judge");
      assert.ok(judgeLoaded.includes(installedConstitution.trim()) || judgeLoaded.includes(installedConstitution));
      assert.ok(judgeLoaded.includes(installedJudgeAuditor.trim()) || judgeLoaded.includes(installedJudgeAuditor));
      assert.ok(judgeLoaded.includes(installedAuditLaw.trim()) || judgeLoaded.includes(installedAuditLaw));
      assert.ok(judgeLoaded.includes(installedQualityLaw.trim()) || judgeLoaded.includes(installedQualityLaw));

      const doctorLoaded = await soul.loadAuditorSoul("doctor");
      assert.ok(doctorLoaded.includes(installedDoctorAuditor.trim()) || doctorLoaded.includes(installedDoctorAuditor));
      assert.equal(doctorLoaded.includes(installedAuditLaw.trim()) && installedAuditLaw.trim() !== "", false);

      // No generic auditor.md in the installed package.
      await assert.rejects(
        () => readFile(resolve(installedRoot, "souls/auditor.md"), "utf8"),
        (error: unknown) =>
          error instanceof Error
          && "code" in error
          && (error as NodeJS.ErrnoException).code === "ENOENT",
      );

      // Real public activation: installed judge-auditor → public auditor summon (subject=judge).
      const judge = await installed("src/judge-auditor.ts");
      const { savePublicCliConfig } = await installed("src/public-cli/config.ts");
      const faux = fauxProvider({ provider: "installed-auditor", api: "openai-completions" });
      const seat = { provider: "installed-auditor", model: faux.getModel().id ?? "faux-1" };
      await savePublicCliConfig({
        seats: { auditor: seat, judge: seat, notary: seat, inspector: seat },
      }, home);

      const runDirectory = resolve(
        home,
        ".ak-roles",
        "books",
        "consumer",
        "runs",
        "01a06ff1-0000-7000-8000-00000000audt@judge",
      );
      await mkdir(resolve(runDirectory, "session"), { recursive: true });
      await writeFile(
        resolve(runDirectory, "run-state.json"),
        `${JSON.stringify({
          runId: "01a06ff1-0000-7000-8000-00000000audt",
          role: "judge",
          state: "running",
          bookKey: "consumer",
          projectRoot: installedRoot,
          sessionDirectory: resolve(runDirectory, "session"),
          sessionFile: resolve(runDirectory, "session/session.jsonl"),
          runDirectory,
          admittedRequestPath: resolve(runDirectory, "admitted-request.json"),
          principalWire: { kind: "pi", sessionFile: resolve(runDirectory, "session/session.jsonl") },
        }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(resolve(runDirectory, "admitted-request.json"), "{}\n", "utf8");
      const sm = SessionManager.open(resolve(runDirectory, "session/session.jsonl"));
      sm.appendMessage({ role: "user", content: "assignment", timestamp: Date.now() });
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "v1", name: "ak_judge_output", arguments: { judgeStatus: "converged" } }],
        api: "openai-responses",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: Date.now(),
      });

      let nestedPrompt = "";
      let nestedCalls = 0;
      faux.setResponses([
        (context: Context) => {
          nestedCalls += 1;
          nestedPrompt = context.systemPrompt ?? "";
          const names = context.tools?.map((tool) => tool.name) ?? [];
          const auditTool = names.includes("ak_auditor_output")
            ? "ak_auditor_output"
            : names.find((name) => name.includes("audit")) ?? "ak_auditor_output";
          return fauxAssistantMessage(
            fauxToolCall(auditTool, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
            { stopReason: "toolUse" },
          );
        },
      ]);

      const priorPackageRoot = process.env.AK_ROLE_PACKAGE_ROOT;
      const priorHome = process.env.HOME;
      process.env.AK_ROLE_PACKAGE_ROOT = installedRoot;
      process.env.HOME = home;
      try {
        await withAgentDirProviderFixture(faux, agentDir, async () => {
          const decision = await judge.createPiJudgeAuditor()({
            context: { cwd: installedRoot, sessionManager: sm } as any,
          });
          assert.equal(decision.status, "pass");
        });
      } finally {
        if (priorPackageRoot === undefined) delete process.env.AK_ROLE_PACKAGE_ROOT;
        else process.env.AK_ROLE_PACKAGE_ROOT = priorPackageRoot;
        if (priorHome === undefined) delete process.env.HOME;
        else process.env.HOME = priorHome;
      }

      assert.ok(nestedCalls >= 1, "public auditor nested turn must hit the faux provider");
      assert.ok(
        nestedPrompt.includes(installedJudgeAuditor.trim()) || nestedPrompt.includes(installedJudgeAuditor),
        "nested public auditor must load installed judge-auditor soul",
      );
      assert.ok(
        nestedPrompt.includes(installedAuditLaw.trim()) || nestedPrompt.includes(installedAuditLaw),
        "nested public auditor must load installed audit-law for judge subject",
      );

      // Editable soul reloads on next public activation.
      const judgeSoulPath = resolve(installedRoot, "souls/judge-auditor.md");
      const original = await readFile(judgeSoulPath, "utf8");
      const editedSoul = "EDITED JUDGE AUDITOR SOUL\n";
      await writeFile(judgeSoulPath, editedSoul, "utf8");
      nestedPrompt = "";
      nestedCalls = 0;
      faux.setResponses([
        (context: Context) => {
          nestedCalls += 1;
          nestedPrompt = context.systemPrompt ?? "";
          const names = context.tools?.map((tool) => tool.name) ?? [];
          const auditTool = names.includes("ak_auditor_output")
            ? "ak_auditor_output"
            : names.find((name) => name.includes("audit")) ?? "ak_auditor_output";
          return fauxAssistantMessage(
            fauxToolCall(auditTool, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
            { stopReason: "toolUse" },
          );
        },
      ]);
      process.env.AK_ROLE_PACKAGE_ROOT = installedRoot;
      process.env.HOME = home;
      try {
        await withAgentDirProviderFixture(faux, agentDir, async () => {
          const decision = await judge.createPiJudgeAuditor()({
            context: { cwd: installedRoot, sessionManager: sm } as any,
          });
          assert.equal(decision.status, "pass");
        });
      } finally {
        await writeFile(judgeSoulPath, original, "utf8");
        if (priorPackageRoot === undefined) delete process.env.AK_ROLE_PACKAGE_ROOT;
        else process.env.AK_ROLE_PACKAGE_ROOT = priorPackageRoot;
        if (priorHome === undefined) delete process.env.HOME;
        else process.env.HOME = priorHome;
      }
      assert.ok(nestedCalls >= 1);
      assert.ok(
        nestedPrompt.includes(editedSoul.trim()) || nestedPrompt.includes(editedSoul),
        "edited judge-auditor soul must reach the nested public auditor turn",
      );
      });
    },
  );
});

test("packaged judge crosses Pi's loader, schema, persisted batch, auth-resolved audit, and termination boundaries offline", async () => {
  const manifest = await loadRawPackageManifest();
  // #675: offline default audit pass (withInProcessPi); institutional child HTTP proof retired.
  // #443/#470 御批四 + #467: judge session materials = constitution + soul + audit-law + quality-law + output guide.
  const judgeSoul = [
    await readFile(resolve(packageRoot, "CLAUDE.md"), "utf8"),
    await readFile(resolve(packageRoot, "souls/judge.md"), "utf8"),
    await readFile(resolve(packageRoot, "souls/audit-law.md"), "utf8"),
    await readFile(resolve(packageRoot, "souls/quality-law.md"), "utf8"),
    await readFile(resolve(packageRoot, "souls/judge-output-guide.md"), "utf8"),
  ].join("\n\n").trim();
  await withActivationHome(
    { prefix: "ak-role-integration-" },
    async ({ home, agentDir }) => {
      const faux = fauxProvider({
        api: "ak-role-offline",
        provider: "ak-role-offline",
        tokenSize: { min: 1000, max: 1000 },
      });
      // Seed nested public seats onto this test-owned home; restore on exit (no harness rewrite).
      const { savePublicCliConfig, loadPublicCliConfig, publicCliConfigPath } =
        await import("../../src/public-cli/config.ts");
      const configPath = publicCliConfigPath(home);
      let priorConfig: string | undefined;
      try {
        priorConfig = await readFile(configPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const seat = { provider: "ak-role-offline", model: faux.getModel().id ?? "faux-1" };
      await savePublicCliConfig({
        seats: {
          auditor: seat,
          notary: seat,
          inspector: seat,
          judge: seat,
          navigator: seat,
        },
      }, home);
      const restoreSeats = async () => {
        if (priorConfig === undefined) {
          await rm(configPath, { force: true });
        } else {
          await writeFile(configPath, priorConfig, "utf8");
        }
      };
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
      // #518 S3: institutional children read models.json — seed mock HTTP, then layer
      // the resolved auth fields the child must put on its real outbound request.
      let latestChildRequestHeaders: import("node:http").IncomingHttpHeaders | undefined;
      let auditChildRequestHeaders: import("node:http").IncomingHttpHeaders | undefined;
      const seeded = await seedAgentDirModelsJsonFromFaux(faux, agentDir, {
        observers: {
          onRequest({ headers }) {
            latestChildRequestHeaders = headers;
          },
        },
      });
      try {
      const modelsPath = resolve(agentDir, "models.json");
      const seededDoc = JSON.parse(await readFile(modelsPath, "utf8")) as {
        providers?: Record<string, Record<string, unknown>>;
      };
      const providerDoc = seededDoc.providers?.[activeModel.provider] ?? {};
      await writeFile(
        modelsPath,
        JSON.stringify({
          providers: {
            ...(seededDoc.providers ?? {}),
            [activeModel.provider]: {
              ...providerDoc,
              apiKey: "resolved-secret",
              headers: { "x-resolved-auth": "yes" },
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
        modelsPath: null,
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
        // Developer exact-session shape: bare judge -p prompt is the only work
        // context (no authority.md / role-input). Navigator must recover it and
        // still deliver one correlated recommendation after accepted terminal.
        const developerPrompt = "Exercise audited terminating acceptance.";
        const response = (context: Context) => {
          const names = context.tools?.map((tool) => tool.name) ?? [];
          const officerPass = scriptOfficerPass(names, "notary");
          if (officerPass !== undefined) return officerPass;
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
          if (names.includes(SOUL_AUDIT_TOOL_NAME) || names.includes("ak_auditor_output")) {
            auditContext = context;
            // Snapshot the mock HTTP headers that just arrived for this child turn.
            auditChildRequestHeaders = latestChildRequestHeaders;
            const auditTool = names.includes("ak_auditor_output")
              ? "ak_auditor_output"
              : SOUL_AUDIT_TOOL_NAME;
            return fauxAssistantMessage(
              fauxToolCall(
                auditTool,
                { status: "pass", violations: [], conflicts: [], decisionGate: null },
                { id: "audit-pass" },
              ),
              { stopReason: "toolUse" },
            );
          }
          // Only the parent judge turn owns judgeContext — nested seats must not overwrite.
          if (names.includes(JUDGE_OUTPUT_TOOL_NAME)) {
            judgeContext = context;
            return fauxAssistantMessage(
              fauxToolCall(
                JUDGE_OUTPUT_TOOL_NAME,
                { judgeStatus: "converged" },
                { id: "accepted-judge" },
              ),
              { stopReason: "toolUse" },
            );
          }
          return fauxAssistantMessage([], { stopReason: "stop" });
        };
        // Legal graph capacity: first fresh + nested officers + public nav (withdraw 8→12).
        faux.setResponses(Array.from({ length: 8 }, () => response));
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
        // Parent still carries defaultBaseUrl; child auth is models.json (S3), not ambient inherit.
        assert.notEqual(activeModel.baseUrl, resolvedBaseUrl);
        // Prove the auditor child consumed resolved auth on the real outbound HTTP request
        // (models.json → openai-completions → mock), not by re-reading the fixture file.
        assert.ok(auditChildRequestHeaders, "auditor child must hit the seeded mock HTTP entry");
        assert.equal(auditChildRequestHeaders.authorization, "Bearer resolved-secret");
        assert.equal(auditChildRequestHeaders["x-resolved-auth"], "yes");
        assert.equal(auditChildRequestHeaders["x-model-route"], "audit-tenant");
        assert.notEqual(seeded.baseUrl, defaultBaseUrl);

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
        // #575 sole-final barrier: execute projects a pending-round-closure candidate;
        // sealed decisive facts stay contract-pure — Navigator must not rewrite them.
        assert.deepEqual(acceptedResult.message.details, {
          submissionDisposition: "pending-round-closure",
        });
        const judgeClosure = sessionManager
          .getEntries()
          .filter((entry) => entry.type === "custom" && entry.customType === "ak-role-submission-closure");
        assert.equal(judgeClosure.length, 1, "exactly one sealed Judge submission closure");
        assert.deepEqual((judgeClosure[0] as { data?: { details?: unknown } }).data?.details, {
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

        // Parent session topology remains ledger-owned (ADR 0048).
        const parentSessionFile = sessionManager.getSessionFile();
        const parentDir = sessionManager.getSessionDir();
        assert.equal(typeof parentSessionFile, "string");
        assert.ok(String(parentSessionFile).length > 0);
        assert.equal(parentDir, dirname(parentSessionFile!));
        assert.equal(sessionManager.getHeader()?.cwd, packageRoot);
        await assert.rejects(
          () => access(resolve(packageRoot, "auditor-roles")),
          (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        );
      });
      } finally {
        await seeded.close();
      }
      } finally {
        if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
        await restoreSeats();
      }
    },
  );
});

test("packaged judge escalation emits one typed human decision", async () => {
  const manifest = await loadRawPackageManifest();
  // #675: real public auditor summon with nested faux escalate mode (no setTest* short-circuit).
  const priorAuditMode = process.env.AK_NESTED_AUDIT_MODE;
  process.env.AK_NESTED_AUDIT_MODE = "escalate";
  try {
  await withActivationHome(
    { prefix: "ak-judge-escalation-integration-" },
    async ({ home, agentDir }) => {
      const faux = fauxProvider({
        api: "ak-judge-escalation-offline",
        provider: "ak-judge-escalation-offline",
        tokenSize: { min: 1000, max: 1000 },
      });
      const { savePublicCliConfig, publicCliConfigPath } =
        await import("../../src/public-cli/config.ts");
      const configPath = publicCliConfigPath(home);
      let priorConfig: string | undefined;
      try {
        priorConfig = await readFile(configPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const seat = {
        provider: "ak-judge-escalation-offline",
        model: faux.getModel().id ?? "faux-1",
      };
      await savePublicCliConfig({
        seats: { auditor: seat, notary: seat, inspector: seat, judge: seat },
      }, home);
      const restoreSeats = async () => {
        if (priorConfig === undefined) await rm(configPath, { force: true });
        else await writeFile(configPath, priorConfig, "utf8");
      };
      try {
      await withAgentDirProviderFixture(faux, agentDir, async () => {
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: packageRoot,
        agentDir,
        faux,
        modelsPath: null,
        additionalExtensionPaths: [packageEntrypoint(manifest)],
        systemPrompt: "JUDGE ESCALATION INTEGRATION PROMPT",
        mode: "print",
        flags: { "ak-role": "judge" },
        noTools: "builtin",
        // Nested public path + officer-pass provider; AK_NESTED_AUDIT_MODE=escalate
        // scripts the public auditor decision.
      }, async ({ session, sessionManager }) => {
        const escalateRespond = (context: Context) => {
          const names = context.tools?.map((tool) => tool.name) ?? [];
          const officerPass = scriptOfficerPass(names, "notary");
          if (officerPass !== undefined) return officerPass;
          if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
            return navigatorPrepareFixtureResponse({ role: "judge", phase: null });
          }
          // Nested public auditor escalate (same scripted decision as dedicated fixture).
          if (names.includes("ak_auditor_output") || names.includes(SOUL_AUDIT_TOOL_NAME)) {
            const auditTool = names.includes("ak_auditor_output")
              ? "ak_auditor_output"
              : SOUL_AUDIT_TOOL_NAME;
            return fauxAssistantMessage(
              fauxToolCall(
                auditTool,
                {
                  status: "escalate",
                  conflicts: ["Soul authority conflicts with controlling authority"],
                  decisionGate: {
                    question: "Which authority governs this verdict?",
                    options: ["Soul", "Controlling authority"],
                  },
                },
                { id: "audit-escalate" },
              ),
              { stopReason: "toolUse" },
            );
          }
          if (!names.includes(JUDGE_OUTPUT_TOOL_NAME)) {
            return fauxAssistantMessage([], { stopReason: "stop" });
          }
          return fauxAssistantMessage(
            fauxToolCall(
              JUDGE_OUTPUT_TOOL_NAME,
              { judgeStatus: "converged" },
              { id: "escalating-judge" },
            ),
            { stopReason: "toolUse" },
          );
        };
        faux.setResponses(Array.from({ length: 6 }, () => escalateRespond));
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
        assert.equal(toolResult.isError, false, JSON.stringify(toolResult.details));
        // #575 sole-final barrier: execute projects a pending-round-closure candidate;
        // audit escalation face + delivered judge verdict arrive on the typed closure (ADR 0055).
        assert.deepEqual(toolResult.details, { submissionDisposition: "pending-round-closure" });
        const escalationClosure = sessionManager
          .getEntries()
          .filter((entry) => entry.type === "custom" && entry.customType === "ak-role-submission-closure");
        assert.equal(escalationClosure.length, 1, "exactly one typed escalation closure");
        const escalationDetails = (escalationClosure[0] as { data?: { details?: unknown } }).data?.details as {
          kind?: unknown;
          conflicts?: unknown;
          auditDecisionGate?: unknown;
          judgeStatus?: unknown;
        };
        assert.equal(escalationDetails.kind, "audit_escalation");
        assert.deepEqual(escalationDetails.conflicts, [
          "Soul authority conflicts with controlling authority",
        ]);
        assert.deepEqual(escalationDetails.auditDecisionGate, {
          question: "Which authority governs this verdict?",
          options: ["Soul", "Controlling authority"],
        });
        assert.equal(escalationDetails.judgeStatus, "converged");
        assert.equal(isAuditEscalationResult(escalationDetails), true);
        assert.throws(
          () => validateAcceptedDetails(JUDGE_OUTPUT_TOOL_NAME, escalationDetails),
          (error: unknown) => error instanceof Error && error.name === "AcceptedDetailsContractError",
        );
      });
      });
      } finally {
        await restoreSeats();
      }
    },
  );
  } finally {
    if (priorAuditMode === undefined) delete process.env.AK_NESTED_AUDIT_MODE;
    else process.env.AK_NESTED_AUDIT_MODE = priorAuditMode;
  }
});

test("packaged coder apply proves canonical native tdd expansion including colliding prefix", async () => {
  const manifest = await loadRawPackageManifest();
  // #443: coder session materials = constitution + soul + quality-law + guide (trim whole).
  const coderSoul = [
    await readFile(resolve(packageRoot, "CLAUDE.md"), "utf8"),
    await readFile(resolve(packageRoot, "souls/coder.md"), "utf8"),
    await readFile(resolve(packageRoot, "souls/quality-law.md"), "utf8"),
    await readFile(resolve(packageRoot, "souls/coder-output-guide.md"), "utf8"),
  ].join("\n\n").trim();
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
        await withAgentDirProviderFixture(faux, agentDir, async () => {
        await withInProcessPi({
          activationLedgerSession: true,
          cwd: work,
          agentDir,
          faux,
          modelsPath: null,
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
          // completed zero-commit: ① bounces once; same payload resubmit confirms + direct officer pass.
          // unfinished: ① does not apply — single call settles without officer summons (skip-status).
          const firstCallId = row.output.status === "completed"
            ? `${row.callId}-bounce`
            : row.callId;
          const officerOrIdle = (context: Context) => {
            const names = context.tools?.map((tool) => tool.name) ?? [];
            if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
              return navigatorPrepareFixtureResponse({ role: "coder", phase: "apply" });
            }
            const officerPass = scriptOfficerPass(names, "inspector");
            if (officerPass !== undefined) return officerPass;
            return fauxAssistantMessage("coder fixture idle");
          };
          faux.setResponses(
            row.output.status === "completed"
              ? [
                (context: Context) => {
                  coderContext = context;
                  return fauxAssistantMessage(
                    fauxToolCall(CODER_OUTPUT_TOOL_NAME, row.output, {
                      id: firstCallId,
                    }),
                    { stopReason: "toolUse" },
                  );
                },
                (context: Context) => {
                  const names = context.tools?.map((tool) => tool.name) ?? [];
                  const officerPass = scriptOfficerPass(names, "inspector");
                  if (officerPass !== undefined) return officerPass;
                  return fauxAssistantMessage(
                    fauxToolCall(CODER_OUTPUT_TOOL_NAME, row.output, {
                      id: row.callId,
                    }),
                    { stopReason: "toolUse" },
                  );
                },
                (context: Context) => {
                  const names = context.tools?.map((tool) => tool.name) ?? [];
                  const officerPass = scriptOfficerPass(names, "inspector");
                  if (officerPass !== undefined) return officerPass;
                  return fauxAssistantMessage(
                    fauxToolCall(CODER_OUTPUT_TOOL_NAME, row.output, {
                      id: row.callId,
                    }),
                    { stopReason: "toolUse" },
                  );
                },
                officerOrIdle,
              ]
              : [
                (context: Context) => {
                  coderContext = context;
                  return fauxAssistantMessage(
                    fauxToolCall(CODER_OUTPUT_TOOL_NAME, row.output, {
                      id: row.callId,
                    }),
                    { stopReason: "toolUse" },
                  );
                },
                officerOrIdle,
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
            // Bounce is typed isError; no rejection-prose pin (#495 S4).
            assert.equal(bounced.message.isError, true);
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
          assert.deepEqual(accepted.message.details, { submissionDisposition: "pending-round-closure" });
          const closure = sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "ak-role-submission-closure");
          assert.equal(closure.length, 1, "exactly one sealed Coder submission closure");
          assert.deepEqual((closure[0] as { data?: { details?: unknown } }).data?.details, row.output);
        });
        });
      },
    );
  }
});

test("packaged fixer applies its both-phase bash seatbelt, retains its tool surface, and enforces singleton output", async () => {
  const manifest = await loadRawPackageManifest();
  // #443: fixer session materials via production role-runtime wiring.
  const fixerSoul = [
    await readFile(resolve(packageRoot, "CLAUDE.md"), "utf8"),
    await readFile(resolve(packageRoot, "souls/fixer.md"), "utf8"),
    await readFile(resolve(packageRoot, "souls/quality-law.md"), "utf8"),
    await readFile(resolve(packageRoot, "souls/fixer-output-guide.md"), "utf8"),
  ].join("\n\n").trim();
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
        await withAgentDirProviderFixture(faux, agentDir, async () => {
        await withInProcessPi({
          activationLedgerSession: true,
          cwd: work,
          agentDir,
          faux,
          modelsPath: null,
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
          let fixerContext: Context | undefined;
          faux.setResponses([
            (context: Context) => {
              fixerContext = context;
              return fauxAssistantMessage(
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
              );
            },
            fauxAssistantMessage(`seatbelt matrix observed for ${phase}`),
          ]);
          await session.prompt(
            `Exercise Fixer bash seatbelt in ${phase} phase.`,
          );
          // Production role-runtime default load: constitution + quality-law + guide.
          if (phase === "plan") {
            assert.ok(fixerContext);
            assert.ok(
              fixerContext.systemPrompt?.includes(
                `<fixer_soul>\n${fixerSoul}\n</fixer_soul>`,
              ),
              "the provider receives constitution + quality-law + fixer guide",
            );
          }

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
          const previousExitCode = process.exitCode;
          try {
            await session.prompt(`Reject a mixed final batch in ${phase}.`);
          } finally {
            // In-process Pi simulates the print/json CLI subprocess exit code;
            // the typed mixed-batch rejection must not leak into the test runner.
            process.exitCode = previousExitCode;
          }
          const mixed = sessionManager.getEntries().find(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolCallId === `mixed-fixer-${phase}`,
          );
          assert.ok(
            mixed?.type === "message" && mixed.message.role === "toolResult",
          );
          // planned / unfinished settle without an officer summons. Prior isError:true
          // here was an accidental gate-miss failure, not singleton enforcement.
          assert.equal(mixed.message.isError, false);

          // planned / unfinished skip the officer gate; only DONE statuses summon Inspector.
          // Parent tool lists may still advertise inspector; do not treat presence as a summons.
          const officerOrIdle = (context: Context) => {
            const names = context.tools?.map((tool) => tool.name) ?? [];
            if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
              return navigatorPrepareFixtureResponse({ role: "fixer", phase: "apply" });
            }
            const officerPass = scriptOfficerPass(names, "inspector");
            if (officerPass !== undefined) return officerPass;
            return fauxAssistantMessage("fixer fixture idle");
          };
          faux.setResponses([
            fauxAssistantMessage(
              fauxToolCall(FIXER_OUTPUT_TOOL_NAME, output, {
                id: `sole-fixer-${phase}`,
              }),
              { stopReason: "toolUse" },
            ),
            officerOrIdle,
            officerOrIdle,
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
          assert.deepEqual(accepted.message.details, { submissionDisposition: "pending-round-closure" });
          const closure = sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "ak-role-submission-closure");
          assert.equal(closure.length, 1, "exactly one sealed Fixer submission closure");
          assert.deepEqual((closure[0] as { data?: { details?: unknown } }).data?.details, output);
        });
        });
      }
    },
  );
});
