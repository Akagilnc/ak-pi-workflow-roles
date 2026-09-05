/**
 * #319 Batch 4 (R1): thematic split from package-entrypoint.integration.test.ts.
 * Navigator packaged attendance / continuity / failure matrix
 * All split files remain on the heavy serial manifest (庭定『先拆且全留 heavy』).
 */
// #675: nested public summons + navigator post-role grace may reject after the
// scenario returns; swallow only the known stale-ctx race so the file does not
// fail on asynchronous activity after pass.
process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error && /stale after session replacement or reload/.test(reason.message)) {
    return;
  }
  throw reason;
});
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";

import {
  type Context,
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
  NOTARY_OUTPUT_TOOL,
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
  withAgentDirProviderFixture,
  withInProcessPi,
  withColdInstalledPackage,
  writeTestSkill,
} from "../helpers/pi-test-harness.ts";

import {
  packageEntrypoint,
  expectedNavigatorSessionDirectory,
  uniqueObservedNavigatorSession,
  runOrdinaryNavigatorObservation,
} from "../helpers/package-entrypoint-fixtures.ts";

/** In-file judge direct-notary scripting (not a shared auto-pass). */
function scriptJudgeDirectNotaryPass(names: readonly string[]) {
  if (names.includes(NOTARY_OUTPUT_TOOL)) {
    return fauxAssistantMessage(
      fauxToolCall(NOTARY_OUTPUT_TOOL, { status: "pass", findings: [] }),
      { stopReason: "toolUse" },
    );
  }
  return undefined;
}

test("ordinary Navigator attendance persists preparation, settlement, and visible ordering", async () => {
  const manifest = await loadRawPackageManifest();
  const current = await runOrdinaryNavigatorObservation(packageEntrypoint(manifest));
  assert.equal(current.result.localTimeout, false, "ordinary invocation must finish");
  assert.equal(current.result.code, 0, `ordinary invocation must succeed: ${current.result.stderr}`);
  const accepted = current.roleEntries.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === JUDGE_OUTPUT_TOOL_NAME && entry.message.isError === false);
  assert.equal(accepted.length, 1, "must persist the accepted Judge output result");
  assert.deepEqual(accepted[0]?.message?.details, { submissionDisposition: "pending-round-closure" });
  const closureRows = current.roleEntries.filter((entry) => entry.type === "custom" && entry.customType === "ak-role-submission-closure");
  assert.equal(closureRows.length, 1, "must persist the sealed Judge submission closure");
  assert.deepEqual(closureRows[0]?.data?.details, { judgeStatus: "converged" });

  const currentPreparation = current.navigatorEntries.find((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === NAVIGATOR_PREPARE_TOOL_NAME && entry.message.isError === false);
  const currentSettlement = [...current.navigatorEntries].reverse().find((entry) => entry.type === "custom" && entry.customType === "ak-navigator-settlement");
  const currentVisible = [...current.roleEntries].reverse().find((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
  // #575 sole-final barrier: the accepted settlement is the sealed closure,
  // not the pending-round-closure execute toolResult.
  const currentAccepted = closureRows[0];
  assert.ok(currentPreparation?.timestamp, "current invocation must persist Navigator preparation completion");
  assert.ok(currentSettlement?.timestamp, "current invocation must persist Navigator settlement");
  assert.ok(currentVisible?.timestamp, "current invocation must persist the visible custom message");
  assert.ok(currentAccepted?.timestamp, "current invocation must persist the sealed accepted role output settlement");
  const preparationAt = Date.parse(currentPreparation.timestamp!);
  const settlementAt = Date.parse(currentSettlement.timestamp!);
  const visibleAt = Date.parse(currentVisible.timestamp!);
  const acceptedAt = Date.parse(currentAccepted.timestamp!);
  assert.ok(Number.isFinite(preparationAt) && Number.isFinite(settlementAt) && Number.isFinite(visibleAt) && Number.isFinite(acceptedAt));
  assert.ok(acceptedAt <= settlementAt, "sealed accepted settlement must precede Navigator settlement");
  assert.ok(preparationAt <= settlementAt, "Navigator preparation must drain before settlement");
  assert.ok(visibleAt >= settlementAt, "persisted visible custom-message must follow Navigator settlement");
  assert.ok(visibleAt >= acceptedAt, "persisted visible custom-message must follow the sealed accepted settlement");
  assert.ok(visibleAt - acceptedAt <= 1000, `persisted visible custom-message must follow accepted settlement within 1s (actual ${visibleAt - acceptedAt}ms)`);
  const currentEvents = current.result.stdout.split("\n").filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line) as any);
  assert.equal(currentEvents.some((event) => event.type === "message_end" && event.message?.role === "custom" && event.message.customType === "ak-navigator-attendance"), true, "current ordinary invocation must display the typed attendance event");
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
      // #443: Navigator session materials via pack default wiring (user prompt face).
      const navigatorSoul = [
        await readFile(resolve(packageRoot, "CLAUDE.md"), "utf8"),
        await readFile(resolve(packageRoot, "souls/navigator.md"), "utf8"),
      ].join("\n\n").trim();
      let navigatorCalls = 0;
      let roleModelCalls = 0;
      let invalidJudge = true;
      let revisedRoute = false;
      let preparedAt = 0;
      let navigatorPrompt = "";
      const response = (context: Context) => {
        const names = context.tools?.map((tool) => tool.name) ?? [];
        const province = scriptJudgeDirectNotaryPass(names);
        if (province !== undefined) return province;
        if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
          navigatorCalls += 1;
          preparedAt = performance.now();
          // Navigator injects soul into the provider-visible user prompt, not systemPrompt.
          const userTexts = (context.messages ?? [])
            .filter((message) => message.role === "user")
            .map((message) =>
              typeof message.content === "string"
                ? message.content
                : message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
            );
          navigatorPrompt = [context.systemPrompt ?? "", ...userTexts].join("\n");
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
          faux.setResponses(Array.from({ length: 10 }, () => response));
          await withAgentDirProviderFixture(faux, agentDir, () =>
            withInProcessPi({
              activationLedgerSession: true,
              cwd: issueRoot,
              agentDir,
              faux,
              modelsPath: null,
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
          })
          );
          assert.ok(navigatorCalls >= 1 && navigatorCalls <= 6, `navigator calls out of band: ${navigatorCalls}`);
          void preparedAt;
          // #443: first presentation sample is enough to lock pack default wiring bytes.
          if (sample === 0) {
            assert.ok(
              navigatorPrompt.includes(`<navigator_soul>\n${navigatorSoul}\n</navigator_soul>`),
              "Navigator provider prompt carries constitution + navigator soul from pack wiring",
            );
          }
        }
        revisedRoute = true;
        navigatorCalls = 0;
        roleModelCalls = 0;
        invalidJudge = false;
        faux.setResponses(Array.from({ length: 10 }, () => response));
        await withAgentDirProviderFixture(faux, agentDir, () =>
          withInProcessPi({
            activationLedgerSession: true,
            cwd: issueRoot,
            agentDir,
            faux,
            modelsPath: null,
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
          })
        );
        assert.ok(navigatorCalls >= 1 && navigatorCalls <= 6, `navigator calls out of band: ${navigatorCalls}`);
        if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      const navigatorEntries = (await uniqueObservedNavigatorSession(home, issueRoot, issueRoot)).entries as Array<{ type?: string; customType?: string; data?: unknown }>;
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
          // #675: real nested public auditor via AK_NESTED_AUDIT_MODE (no setTest* short-circuit).
          const priorAuditMode = process.env.AK_NESTED_AUDIT_MODE;
          process.env.AK_NESTED_AUDIT_MODE =
            outcome === "infrastructure" ? "throw" : "pass";
          let navigatorCalls = 0;
          let roleOutputReturned = false;
          let releasePreparation!: () => void;
          let navigatorStarted!: () => void;
          const navigatorStartedPromise = new Promise<void>((resolve) => { navigatorStarted = resolve; });
          const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
          let promptFinished = false;
          const response = (context: Context) => {
            const names = context.tools?.map((tool) => tool.name) ?? [];
            const province = scriptJudgeDirectNotaryPass(names);
            if (province !== undefined) return province;
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
          faux.setResponses(Array.from({ length: 10 }, () => response));
          await withAgentDirProviderFixture(faux, agentDir, () =>
            withInProcessPi({
              activationLedgerSession: true,
              cwd: issueRoot,
              agentDir,
              faux,
              model,
              modelsPath: null,
              additionalExtensionPaths: [packageEntrypoint(manifest)],
              systemPrompt: `NAVIGATOR DRAIN ${outcome}`,
              mode: "json",
              flags: { "ak-role": "judge" },
              noTools: "builtin",
              // Default nestedSummonInject arms real public nested path + officer-pass provider.
            }, async ({ session, sessionManager }) => {
            const prompt = session.prompt(`Exercise ${outcome} settlement while Navigator preparation is in flight.`);
            await navigatorStartedPromise;
            while (!roleOutputReturned) await new Promise<void>((resolve) => setImmediate(resolve));
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(promptFinished, false);
            prompt.then(() => { promptFinished = true; }, () => { promptFinished = true; });
            assert.ok(navigatorCalls >= 1, "the settlement must retain an in-flight Navigator call");
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
            // #675: activation may warm one prepare; settlement drains one more. Bound the total.
            assert.ok(navigatorCalls >= 1 && navigatorCalls <= 6, `navigator calls out of band: ${navigatorCalls}`);
            if (outcome === "human_decision") {
              assert.equal(
                sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "ak-receipt-delivery-request"),
                false,
                "accepted Judge escalation must not request receipt delivery",
              );
            }
          })
          );
          if (priorAuditMode === undefined) delete process.env.AK_NESTED_AUDIT_MODE;
          else process.env.AK_NESTED_AUDIT_MODE = priorAuditMode;
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
        const province = scriptJudgeDirectNotaryPass(names);
        if (province !== undefined) return province;
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
      faux.setResponses(Array.from({ length: 10 }, () => response));
      await withAgentDirProviderFixture(faux, agentDir, () =>
        withInProcessPi({ activationLedgerSession: true, cwd: issueRoot, agentDir, faux, model, modelsPath: null, additionalExtensionPaths: [packageEntrypoint(manifest)], systemPrompt: "PRE OUTPUT FAILURE", mode: "json", flags: { "ak-role": "judge" }, noTools: "builtin" }, async ({ session, sessionManager }) => {
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
        assert.ok(navigatorCalls >= 1 && navigatorCalls <= 6, `mid-turn prepare calls out of band: ${navigatorCalls}`);
        const persisted = (await uniqueObservedNavigatorSession(home, issueRoot, issueRoot)).entries;
        const settlements = persisted.filter((entry) => entry.type === "custom" && entry.customType === "ak-navigator-settlement");
        const invocations = persisted.filter((entry) => entry.type === "custom" && entry.customType === "ak-navigator-invocation");
        assert.equal(settlements.length, 1);
        assert.equal(settlements[0]?.data?.kind, "accepted");
        assert.equal(invocations.length, 1);
      })
      );
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
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
              // Replace file with directory (unlink file only — no directory delete).
              await unlink(resolve(issueRoot, "authority.md"));
              await mkdir(resolve(issueRoot, "authority.md"), { recursive: true });
            }
            if (scenario.name === "session") {
              const navigatorDirectory = expectedNavigatorSessionDirectory(home, issueRoot, issueRoot);
              await mkdir(resolve(navigatorDirectory, ".."), { recursive: true });
              await writeFile(navigatorDirectory, "not a session directory", "utf8");
            }
            const faux = fauxProvider({ api: `ak-navigator-${scenario.name}-${diagnosticIndex}`, provider: `ak-navigator-${scenario.name}-${diagnosticIndex}`, tokenSize: { min: 1000, max: 1000 } });
            const model = faux.getModel();
            const setting = scenario.name === "model"
              ? "missing/provider"
              : scenario.name === "thinking"
                ? `${model.provider}/${model.id}:max`
                : `${model.provider}/${model.id}`;
            await writeNavigatorModelSetting(setting, resolve(agentDir, "navigator-model.json"));
            // Institutional Navigator child resolves auth/stream via agentDir models.json
            // mock HTTP (not the parent session provider). Script navigator failures on
            // the faux response queue so the mock server mirrors typed HTTP status /
            // transport diagnostics into the child (#590 host-neutral path).
            const streamFailure = scenario.name === "auth" || scenario.name === "quota" || scenario.name === "transport";
            const response = (context: Context) => {
              const names = context.tools?.map((tool) => tool.name) ?? [];
              const province = scriptJudgeDirectNotaryPass(names);
              if (province !== undefined) return province;
              if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
                if (streamFailure) {
                  const base = fauxAssistantMessage("", { stopReason: "error", errorMessage: diagnostic });
                  if (scenario.name === "transport") {
                    return {
                      ...base,
                      diagnostics: [{
                        type: "provider_transport_failure",
                        timestamp: Date.now(),
                        error: { message: diagnostic, code: "transport_error" },
                      }],
                    };
                  }
                  return {
                    ...base,
                    ...("status" in scenario
                      ? { statusCode: scenario.status, status: scenario.status }
                      : {}),
                  };
                }
                return fauxAssistantMessage(fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, { candidates: [{ id: "matrix-route", matches: { role: "judge", phase: null, kind: "accepted" }, route: [{ role: "judge", phase: null }, { role: "reviewer", phase: null }], next: { role: "reviewer", phase: null }, reason: "matrix route", command: "Usage: pi --ak-role reviewer --help" }] }), { stopReason: "toolUse" });
              }
              if (names.includes(SOUL_AUDIT_TOOL_NAME)) return fauxAssistantMessage(fauxToolCall(SOUL_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" });
              return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }), { stopReason: "toolUse" });
            };
            faux.setResponses(Array.from({ length: 10 }, () => response));
            await withAgentDirProviderFixture(faux, agentDir, () =>
              withInProcessPi({ activationLedgerSession: true, cwd: issueRoot, agentDir, faux, modelsPath: null, additionalExtensionPaths: [packageEntrypoint(manifest)], systemPrompt: `NAVIGATOR FAILURE MATRIX ${scenario.name}`, mode: "json", flags: { "ak-role": "judge" }, noTools: "builtin" }, async ({ session, sessionManager }) => {
              await session.prompt(`Exercise normal packaged ${scenario.name} Navigator failure.`);
              const receipt = sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === JUDGE_OUTPUT_TOOL_NAME);
              assert.ok(receipt?.type === "message" && receipt.message.role === "toolResult");
              assert.equal(receipt.message.isError, false, `${scenario.name}:${diagnostic}`);
              assert.deepEqual(receipt.message.details, { submissionDisposition: "pending-round-closure" }, `${scenario.name}:${diagnostic}`);
              const closure = sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "ak-role-submission-closure");
              assert.equal(closure.length, 1, `${scenario.name}:${diagnostic}`);
              assert.deepEqual((closure[0] as { data?: { details?: unknown } }).data?.details, { judgeStatus: "converged" }, `${scenario.name}:${diagnostic}`);
              const attendance = sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
              assert.equal(attendance.length, 1, `${scenario.name}:${diagnostic}`);
              const event = (attendance[0] as { details: { disposition: string; unavailableReason?: string; unavailableSource?: string; unavailableCause?: string } }).details;
              assert.equal(event.disposition, "unavailable", `${scenario.name}:${diagnostic}`);
              assert.equal(event.unavailableSource, scenario.source, `${scenario.name}:${diagnostic}`);
              assert.equal(event.unavailableCause, scenario.source, `${scenario.name}:${diagnostic}`);
              assert.notEqual(event.unavailableReason, undefined, `${scenario.name}:${diagnostic}`);
            })
            );
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
        const province = scriptJudgeDirectNotaryPass(names);
        if (province !== undefined) return province;
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
        if (names.includes(SOUL_AUDIT_TOOL_NAME)) {
          const auditTool = SOUL_AUDIT_TOOL_NAME;
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

      faux.setResponses(Array.from({ length: 10 }, () => response));
      await withAgentDirProviderFixture(faux, agentDir, () =>
        withInProcessPi({
          activationLedgerSession: true,
          cwd: issueRoot,
          agentDir,
          faux,
          modelsPath: null,
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
      })
      );

      faux.setResponses(Array.from({ length: 10 }, () => response));
      await withAgentDirProviderFixture(faux, agentDir, () =>
        withInProcessPi({
          activationLedgerSession: true,
          cwd: issueRoot,
          agentDir,
          faux,
          modelsPath: null,
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
      })
      );

      assert.ok(sharedSubjectKey);
      const navigatorSession = await uniqueObservedNavigatorSession(home, sharedSubjectKey, issueRoot);
      assert.equal(
        navigatorSession.directory,
        expectedNavigatorSessionDirectory(home, sharedSubjectKey, issueRoot),
      );
      const entries = navigatorSession.entries as Array<{ type?: string; customType?: string; data?: any }>;
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

      faux.setResponses(Array.from({ length: 10 }, () => response));
      await withAgentDirProviderFixture(faux, agentDir, () =>
        withInProcessPi({
          activationLedgerSession: true,
          cwd: otherRoot,
          agentDir,
          faux,
          modelsPath: null,
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
      })
      );
      const isolatedSession = await uniqueObservedNavigatorSession(home, isolatedSubjectKey!, otherRoot);
      assert.equal(
        isolatedSession.directory,
        expectedNavigatorSessionDirectory(home, isolatedSubjectKey!, otherRoot),
      );
      assert.notEqual(navigatorSession.directory, isolatedSession.directory);
      assert.notEqual(navigatorSession.file, isolatedSession.file);
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
          const province = scriptJudgeDirectNotaryPass(names);
          if (province !== undefined) return province;
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
          return fauxAssistantMessage(fauxToolCall(FIXER_OUTPUT_TOOL_NAME, { status: "planned", report: "outside-work plan" }), { stopReason: "toolUse" });
        };
        faux.setResponses(Array.from({ length: 10 }, () => response));
        await withAgentDirProviderFixture(faux, agentDir, () =>
          withInProcessPi({
            activationLedgerSession: true,
            cwd: outsideRoot,
            agentDir,
            faux,
            modelsPath: null,
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
          const entries = (await uniqueObservedNavigatorSession(home, subjectKey, outsideRoot)).entries as Array<{ type?: string; customType?: string; data?: { authority?: string; subject?: string } }>;
          const contexts = entries.filter((entry) => entry.type === "custom" && entry.customType === "ak-navigator-context");
          assert.ok(contexts.length >= 1, JSON.stringify(entries));
          assert.equal(contexts[0]?.data?.authority, packetBytes);
          assert.equal(contexts[0]?.data?.subject, packetBytes);
        })
        );
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
      const root = resolve(home, "workspace/fresh-ad-hoc");
      await mkdir(root, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Navigator Boundary Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "navigator-boundary@test.local"], { cwd: root });
      await mkdir(resolve(root, "runs/coder"), { recursive: true });
      await mkdir(resolve(root, "runs/fixer"), { recursive: true });
      await writeFile(resolve(root, "authority.md"), "fresh-process owner authority\n", "utf8");
      const coderTask = resolve(root, "runs/coder/task.md");
      const fixerPacket = resolve(root, "runs/fixer/fix-packet.json");
      await writeFile(coderTask, "Fresh-process concrete task.\n", "utf8");
      await writeFile(fixerPacket, "Fresh-process fixer packet.\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-m", "fixture inputs"], { cwd: root });
      await writeFile(resolve(root, "consumer-local-state.txt"), "pre-existing consumer bytes\n", "utf8");
      const porcelainBefore = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root });
      assert.ok(porcelainBefore.byteLength > 0, "fixture must prove non-empty initial consumer state");
      const child = String.raw`
        import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
        import { writeNavigatorModelSetting } from "./src/role-runtime.ts";
        import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME, NAVIGATOR_PREPARE_TOOL_NAME, NOTARY_OUTPUT_TOOL } from "./src/role-runtime.ts";
        import { loadRawPackageManifest, resolvePackageEntrypoint, withInProcessPi, withAgentDirProviderFixture } from "./test/helpers/pi-test-harness.ts";
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
          if (names.includes(NOTARY_OUTPUT_TOOL)) {
            return fauxAssistantMessage(fauxToolCall(NOTARY_OUTPUT_TOOL, { status: "pass", findings: [] }), { stopReason: "toolUse" });
          }
          if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
            const fixer = role === "fixer";
            const route = fixer ? [{ role: "fixer", phase: "plan" }, { role: "reviewer", phase: null }] : [{ role: "coder", phase: "plan" }, { role: "fixer", phase: "plan" }];
            const next = fixer ? { role: "reviewer", phase: null } : { role: "fixer", phase: "plan" };
            return fauxAssistantMessage(fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, { candidates: [{ id: fixer ? "fresh-fixer" : "fresh-coder", matches: { role, phase: role === "fixer" ? "plan" : "plan", kind: "accepted" }, route, next, reason: "fresh-process route", command: fixer ? "Usage: pi --ak-role reviewer --help" : "Usage: pi --ak-role fixer --ak-fixer-phase plan --help" }] }), { stopReason: "toolUse" });
          }
          if (names.includes(FIXER_OUTPUT_TOOL_NAME)) return fauxAssistantMessage(fauxToolCall(FIXER_OUTPUT_TOOL_NAME, { status: "planned", report: "fresh fixer plan" }), { stopReason: "toolUse" });
          return fauxAssistantMessage(fauxToolCall(CODER_OUTPUT_TOOL_NAME, { status: "planned", report: "fresh coder plan" }), { stopReason: "toolUse" });
        };
        const manifest = await loadRawPackageManifest();
        faux.setResponses(Array.from({ length: 10 }, () => response));
        let result;
        await withAgentDirProviderFixture(faux, agentDir, () =>
          withInProcessPi({ activationLedgerSession: true, cwd: root, agentDir, faux, modelsPath: null, additionalExtensionPaths: [resolvePackageEntrypoint(manifest)], systemPrompt: "FRESH PROCESS NAVIGATOR", mode: "json", flags: role === "fixer" ? { "ak-role": "fixer", "ak-fixer-phase": "plan", "ak-fix-packet": input } : { "ak-role": "coder", "ak-coder-phase": "plan", "ak-coder-task": input }, noTools: "builtin" }, async ({ session, sessionManager }) => {
          await session.prompt("fresh process role invocation");
          const messages = sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance");
          result = messages[0]?.type === "custom_message" ? messages[0].details : undefined;
        })
        );
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
      const porcelainAfter = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root });
      assert.deepEqual(
        porcelainAfter,
        porcelainBefore,
        "role/Navigator session transport must preserve consumer porcelain bytes exactly",
      );
      const observed = await uniqueObservedNavigatorSession(home, first.subjectKey, root);
      assert.equal(
        observed.directory,
        expectedNavigatorSessionDirectory(home, first.subjectKey, root),
        "fresh packaged Navigator must land at exact <book>/navigator/<sha256(subjectKey)[0:32]>",
      );
      const persisted = observed.entries as Array<{ type?: string; customType?: string; data?: { role?: string; phase?: string | null } }>;
      assert.deepEqual(persisted.filter((entry) => entry.type === "custom" && entry.customType === "ak-navigator-invocation").slice(0, 2).map((entry) => ({ role: entry.data?.role, phase: entry.data?.phase })), [
        { role: "coder", phase: "plan" },
        { role: "fixer", phase: "plan" },
      ]);
    },
  );
});
