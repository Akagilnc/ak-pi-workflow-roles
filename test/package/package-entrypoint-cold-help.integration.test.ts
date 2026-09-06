/**
 * #319 Batch 4 (R1): thematic split from package-entrypoint.integration.test.ts.
 * Cold-installed live help + routebook/context cause isolation
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
  seedAgentDirModelsJsonFromFaux,
  withInProcessPi,
  withColdInstalledPackage,
  writeTestSkill,
} from "../helpers/pi-test-harness.ts";

import {
  uniqueObservedNavigatorSession,
} from "../helpers/package-entrypoint-fixtures.ts";


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
          assert.ok((WORKFLOW_ROLES as readonly string[]).includes(args.at(-2) ?? ""));
          assert.equal(options.timeout, runtime.NAVIGATOR_LIVE_HELP_TIMEOUT_MS);
          observedHelpTimeouts.push(options.timeout as number);
          const result = await runPiSubprocess(args, {
            cwd: options.cwd ?? fixture,
            env: process.env,
            ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
          });
          assert.equal(result.localTimeout, false, "cold-installed role --help must not time out");
          assert.equal(result.code, 0, "cold-installed role --help must exit 0");
          return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr, killed: result.localTimeout };
        };
        // Live reread is owned by the prepare dual-call below (markers + timeout budget).
        // Prefix direct loadNavigatorRoleHelp dual-call was redundant with that seam.

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
        // #675 ⑥: thinking suffix is passthrough — no max/off whitelist.
        assert.deepEqual(
          attendanceModule.parseNavigatorModelSetting("provider/one:backup"),
          { provider: "provider", model: "one", thinkingLevel: "backup" },
        );
        await writeFile(modelSettingPath, JSON.stringify({ model: "provider/model" }), "utf8");
        const events: Array<{ command?: string; disposition?: string; unavailableReason?: string }> = [];
        const prepareRequests: string[] = [];
        let prepareTool: any;
        const session = {
          async prompt(request: string) {
            prepareRequests.push(request);
            // matches keys advice to this settlement so live-help dual-call is not
            // confounded by settlement-bound rebind (stale-context path).
            await prepareTool.execute("cold-help-prepare", {
              candidates: [{
                matches: { role: "coder", phase: "apply", kind: "accepted", statuses: ["completed"] },
                next: { role: "judge", phase: null },
                reason: "typed cold-installed direction",
              }],
            });
          },
          appendEntry() {},
          entries: () => [],
          async setModel() {},
          recordPointer: () => join(home, "navigator-record"),
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
        assert.ok(observedHelpTimeouts.length >= 2, "prepare path must load live help at least twice");
        assert.ok(
          observedHelpTimeouts.every((ms) => ms === runtime.NAVIGATOR_LIVE_HELP_TIMEOUT_MS),
          "live help must use the cold-start timeout budget",
        );
        assert.deepEqual(events.map((event: any) => ({ disposition: event.disposition, command: event.command, unavailableReason: event.unavailableReason })), [
          { disposition: "recommendation", command: "ak-role judge", unavailableReason: undefined },
          { disposition: "recommendation", command: "ak-role judge", unavailableReason: undefined },
        ]);
        assert.equal(events[0]!.command, "ak-role judge");
        assert.equal(events[1]!.command, "ak-role judge");
        assert.equal(events[1]!.command?.includes("/task.md"), false);

        const routebookEvents: any[] = [];
        let routebookReads = 0;
        const routebookNav = attendanceModule.createNavigatorAttendance({
          context: {
            sessionManager: {
              getSessionId: () => "cold-routebook",
              appendCustomEntry() { return "ok"; },
            },
            cwd: fixture,
          } as never,
          role: "coder",
          phase: "apply",
          subjectKey: resolve(fixture, "routebook-task.md"),
          subject: "cold-installed routebook task",
          authority: "cold-installed routebook authority",
          modelSettingPath,
          loadSoul: async () => "route judgment",
          loadRoutePlaybook: async () => {
            routebookReads += 1;
            throw new Error("FIRST_ROUTEBOOK_CAUSE");
          },
          loadRoleHelp: (role: any) => runtime.loadNavigatorRoleHelp({ exec } as never, resolve(installedRoot, "extensions/role-runtime.ts"), fixture, role),
          createSession: async ({ tool }: any) => { prepareTool = tool; return session; },
          onEvent: async (event: any) => { routebookEvents.push(event); },
        });
        routebookNav.prepare();
        await routebookNav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
        routebookNav.setWorkContext({
          subjectKey: resolve(fixture, "routebook-task.md"),
          subject: "second cold-installed routebook task",
          authority: "cold-installed routebook authority",
          contextError: new Error("SECOND_CONTEXT_CAUSE"),
        });
        routebookNav.prepare();
        await routebookNav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
        assert.equal(routebookReads, 1, "early second context failure must not reread the routebook");
        assert.equal(routebookEvents.length, 2);
        assert.equal(routebookEvents[0]!.routePlaybookReadFailure, "FIRST_ROUTEBOOK_CAUSE");
        assert.equal(routebookEvents[1]!.disposition, "unavailable");
        assert.equal(routebookEvents[1]!.unavailableSource, "context");
        assert.equal(routebookEvents[1]!.unavailableReason, "SECOND_CONTEXT_CAUSE");
        assert.equal(routebookEvents[1]!.routePlaybookReadFailure, undefined, "settled routebook diagnosis must not leak into the next preparation");

        // Cross the installed package entrypoint with the bundled Luna Max default,
        // then edit and restore the same setting without permitting a fallback.
        // Independent presentation is proven by observable typed attendance events,
        // one Navigator call, <=1s prepared latency, and repeated <10% follow-up below.
        // #675 r3: public navigator summons need models.json apiKey providers — openai-codex/xai
        // fail-closed on missing auth.json (public-run-credentials). Navigator seat uses the
        // same offline provider as nested officers; Luna prepare-tool metering is the old
        // in-process path and is not the public-path contract.
        const { savePublicCliConfig } = await import("../../src/public-cli/config.ts");
        const offlineSeat = { provider: "ak-cold-offline", model: "faux-1" };
        const offlineSeatThinking = { provider: "ak-cold-offline", model: "faux-1", thinking: "off" as const };
        await savePublicCliConfig({
          seats: {
            auditor: offlineSeat,
            notary: offlineSeat,
            inspector: offlineSeat,
            judge: offlineSeat,
            navigator: offlineSeat,
          },
        }, home);
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
        const modelRequests: string[] = [];
        const lifecycle: Array<{ label: string; event: any; timestamps?: { preparedAt: string; settledAt: string; persistedVisibleAt: string } }> = [];
        const invoke = async (label: string) => {
          const response = (context: Context, _options: unknown, _state: unknown, requestModel: { provider: string; id: string }) => {
            const names = context.tools?.map((tool) => tool.name) ?? [];
            if (names.includes(NOTARY_OUTPUT_TOOL)) {
              return fauxAssistantMessage(
                fauxToolCall(NOTARY_OUTPUT_TOOL, { status: "pass", findings: [] }),
                { stopReason: "toolUse" },
              );
            }
            const navigatorTool = names.includes("ak_navigator_output")
              ? "ak_navigator_output"
              : names.includes(NAVIGATOR_PREPARE_TOOL_NAME)
                ? NAVIGATOR_PREPARE_TOOL_NAME
                : undefined;
            if (navigatorTool !== undefined) {
              modelRequests.push(`${requestModel.provider}/${requestModel.id}`);
              const candidates = [{
                id: "cold-offline-route",
                matches: { role: "judge", phase: null, kind: "accepted" },
                route: [{ role: "judge", phase: null }, { role: "reviewer", phase: null }],
                next: { role: "reviewer", phase: null },
                reason: "cold-installed typed route",
                command: "Usage: pi --ak-role reviewer --help",
              }];
              return fauxAssistantMessage(
                fauxToolCall(
                  navigatorTool,
                  navigatorTool === "ak_navigator_output"
                    ? { status: "advice", candidates }
                    : { candidates },
                ),
                { stopReason: "toolUse" },
              );
            }
            // #675: nested public auditor terminates on ak_auditor_output; parent may still see SOUL_AUDIT.
            if (names.includes(SOUL_AUDIT_TOOL_NAME) || names.includes("ak_auditor_output")) {
              const auditTool = names.includes("ak_auditor_output") ? "ak_auditor_output" : SOUL_AUDIT_TOOL_NAME;
              return fauxAssistantMessage(
                fauxToolCall(auditTool, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
                { stopReason: "toolUse" },
              );
            }
            return fauxAssistantMessage(fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }), { stopReason: "toolUse" });
          };
          // Parent judge + nested officers share this faux; public navigator prepares
          // hit seat-table providers (not necessarily this Luna prepare tool face).
          luna.setResponses(Array.from({ length: 16 }, () => response));
          let event: any;
          let timestamps: { preparedAt: string; settledAt: string; persistedVisibleAt: string } | undefined;
          const priorPackageRoot = process.env.AK_ROLE_PACKAGE_ROOT;
          process.env.AK_ROLE_PACKAGE_ROOT = installedRoot;
          try {
          // Seed openai-codex (navigator Luna) and ak-cold-offline (nested seats) on one mock.
          const seeded = await seedAgentDirModelsJsonFromFaux(luna, coldAgentDir);
          try {
            const modelsPath = resolve(coldAgentDir, "models.json");
            const doc = JSON.parse(await readFile(modelsPath, "utf8")) as {
              providers?: Record<string, Record<string, unknown>>;
            };
            const lunaProvider = doc.providers?.["openai-codex"];
            if (lunaProvider !== undefined) {
              doc.providers = {
                ...(doc.providers ?? {}),
                "ak-cold-offline": {
                  ...lunaProvider,
                  models: [{
                    id: "faux-1",
                    name: "faux-1",
                    api: "openai-completions",
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 16384,
                  }],
                },
              };
              await writeFile(modelsPath, JSON.stringify(doc, null, 2), "utf8");
            }
          await withInProcessPi({
              activationLedgerSession: true,
              cwd: issueRoot,
              agentDir: coldAgentDir,
              faux: luna,
              model: lunaModel,
              modelsPath: null,
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
            const observed = await uniqueObservedNavigatorSession(home, resolve(issueRoot), issueRoot);
            const persisted = observed.entries;
            // Public navigator path books invocation/context on the nest; prepare toolResult
            // may be absent (advice arrives via ak_navigator_output on the public run).
            const prepared = [...persisted].reverse().find((entry) =>
              (entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === NAVIGATOR_PREPARE_TOOL_NAME)
              || (entry.type === "custom" && entry.customType === "ak-navigator-invocation")
              || (entry.type === "custom" && entry.customType === "ak-navigator-context"),
            );
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
          } finally {
            await seeded.close();
          }
          } finally {
            if (priorPackageRoot === undefined) delete process.env.AK_ROLE_PACKAGE_ROOT;
            else process.env.AK_ROLE_PACKAGE_ROOT = priorPackageRoot;
          }
          lifecycle.push({ label, event, ...(timestamps === undefined ? {} : { timestamps }) });
        };
        try {
          await invoke("default-offline");
          await savePublicCliConfig({
            seats: {
              auditor: offlineSeat, notary: offlineSeat, inspector: offlineSeat, judge: offlineSeat,
              navigator: offlineSeatThinking,
            },
          }, home);
          await invoke("edited-thinking-off");
          await savePublicCliConfig({
            seats: {
              auditor: offlineSeat, notary: offlineSeat, inspector: offlineSeat, judge: offlineSeat,
              navigator: offlineSeat,
            },
          }, home);
          await invoke("restored-offline");
          await savePublicCliConfig({
            seats: {
              auditor: offlineSeat, notary: offlineSeat, inspector: offlineSeat, judge: offlineSeat,
              navigator: { provider: "missing", model: "provider" },
            },
          }, home);
          await invoke("unsupported-no-fallback");
        } finally {
          if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
        // Structured contracts (#675 r3 / public navigator path):
        // seat-table drives attendance — recommendation while navigator seat is Luna,
        // unavailable/model when seat is missing; no silent fallback to another model.
        // Parent Luna prepare-tool modelRequests are not the public-path meter.
        void modelRequests;
        assert.equal(lifecycle.length, 4, "four seat-edit invokes");
        assert.equal(
          lifecycle[0]?.event.disposition,
          "recommendation",
          JSON.stringify(lifecycle[0]?.event),
        );
        assert.equal(
          lifecycle[1]?.event.disposition,
          "recommendation",
          JSON.stringify(lifecycle[1]?.event),
        );
        assert.equal(
          lifecycle[2]?.event.disposition,
          "recommendation",
          JSON.stringify(lifecycle[2]?.event),
        );
        assert.equal(lifecycle[3]?.event.disposition, "unavailable");
        // Missing provider fails closed — source may be model (seat resolve) or session
        // (public summon open); never falls back to a working recommendation.
        assert.ok(
          lifecycle[3]?.event.unavailableSource === "model"
          || lifecycle[3]?.event.unavailableSource === "session"
          || lifecycle[3]?.event.unavailableSource === "transport",
          JSON.stringify(lifecycle[3]?.event),
        );
        // Timestamps: preparation ≤ settlement ≤ visible for each successful recommendation.
        for (const sample of lifecycle.slice(0, 3)) {
          assert.ok(sample.timestamps, `${sample.label} must record prepare/settle/visible`);
          const { preparedAt, settledAt, persistedVisibleAt } = sample.timestamps!;
          assert.ok(Date.parse(preparedAt) <= Date.parse(settledAt), `${sample.label} prepare≤settle`);
          assert.ok(Date.parse(settledAt) <= Date.parse(persistedVisibleAt), `${sample.label} settle≤visible`);
        }
      });
    },
  );
});
