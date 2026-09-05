import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import test, { afterEach } from "node:test";
import { pathToFileURL } from "node:url";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionError } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  ACCEPTED_ACTIVATION_EVENT,
  ActivationGitRepositoryRequiredError,
  ActivationLedgerError,
  activationWaitingLedgerPath,
  appendAcceptedActivationFact,
  buildAcceptedActivationFact,
  durableSessionPointer,
  resolveActivationLedgerHome,
  resolveBookKeyFromGit,
  type AcceptedActivationFact,
  type ToolExecutionObservationRecord,
} from "../../src/role-runtime.ts";
import { activationTraceRecordSchema, type ActivationTraceRecord } from "../../src/activation-trace.ts";
import { createPiRoleRuntimeExtension } from "../../src/pi/adapter.ts";
import { createRoleRuntimeExtension } from "../../src/role-runtime.ts";
import {
  buildDispatchStubFact,
  reconcileInvocation,
} from "../../src/activation-reconciliation.ts";
import { PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";
import { TERMINATING_TOOL_NAMES } from "../../src/package-contracts/terminating-tools.ts";
import {
  createFakeGitHubTransport,
  samplePull,
  sampleUser,
} from "../helpers/fake-github-transport.ts";
import {
  activationBookKeyFor,
  machineLedgerHome,
  packageRoot,
  persistActivationSessionFile,
  readAcceptedActivationFacts,
  runNodeSubprocess,
  runPiSubprocess,
  withActivationHome,
  withHermeticHome,
  withInProcessPi,
} from "../helpers/pi-test-harness.ts";

import { DOCTOR_EVIDENCE_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { createNavigatorPrepareTool, NAVIGATOR_PREPARE_TOOL_NAME } from "../../src/navigator-attendance.ts";

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function mergerMaterial(text: string) {
  const bytes = Buffer.from(text, "utf8");
  return { bytesBase64: bytes.toString("base64"), sha256: sha256Hex(bytes) };
}
const emptyDoctorCost = {
  invocations: { count: 0, sources: [] as string[] },
  legs: { count: 0, sources: [] as string[] },
  modelApiTurns: { count: 0, sources: [] as string[] },
  outputTokens: { count: 0, sources: [] as string[] },
  toolCalls: { count: 0, sources: [] as string[] },
  retries: { count: 0, sources: [] as string[], evidence: "literal run-dir naming" as const },
  statuses: [] as Array<{ source: string; status: string }>,
  commits: [] as Array<{ source: string; commit: string }>,
  sessions: [] as Array<{ source: string; completion: "incomplete" }>,
  outputBytes: {
    count: 0,
    sources: [] as string[],
    payload: "raw JSONL bytes" as const,
    providerWireBytes: "unavailable" as const,
  },
};

const originalExitCode = process.exitCode;
afterEach(() => { process.exitCode = originalExitCode; });

/** Role load stubs already owned by production RoleRuntimeDependencies — not ledger hooks. */
function admissionDepsForRole(role: string, fixtureRoot: string): Parameters<typeof createRoleRuntimeExtension>[0] {
  const law = async () => "LAW";
  const oid = (ch: string) => ch.repeat(40);
  const base = {
    loadJudgeSoul: law,
    auditSoulCompliance: async () => ({ status: "pass" as const }),
    activationClock: () => "2025-06-01T12:00:00.000Z",
    activationTraceWriter: () => {},
  };
  switch (role) {
    case "judge":
      return base;
    case "fixer":
      return { ...base, loadFixerSoul: law, loadFixPacket: async () => "Repair the findings.\n" };
    case "coder":
      return { ...base, loadCoderSoul: law, loadCoderTask: async () => "Build it.\n" };
    case "reviewer":
      return {
        ...base,
        loadReviewerSoul: law,
        createReviewerPinnedGitReader: async () => {
          const pin = {
            repositoryRoot: fixtureRoot,
            objectFormat: "sha1" as const,
            targetHead: oid("9"),
            refs: { "refs/heads/main": { objectId: oid("9"), peeledCommitId: oid("9") } },
          };
          // Pinned-target Spec path for unique production discovery (two-axis fixture).
          return {
            pin,
            snapshot: async () => pin,
            resolve: async () => oid("8"),
            range: async () => ({
              base: oid("8"),
              target: oid("9"),
              diffCommand: `git diff ${oid("8")}...${oid("9")}`,
              diffSha256: "2".repeat(64),
              commits: [oid("9")],
            }),
            featureTokens: async () => Object.freeze(["feature-login"]),
            listSpecCandidatePaths: async () => Object.freeze(["docs/feature-login.md"]),
            originRepository: async () => undefined,
            commitMessagesNewestFirst: async () => Object.freeze([]),
            readPinnedText: async () => undefined,
          };
        },
        loadCanonicalSkillBinding: async (name) => {
          const raw = "# skill\n";
          return {
            name,
            snapshot: {
              raw,
              path: "/skill",
              baseDir: "/",
              body: raw,
              snapshotIdentity: Object.freeze({ text: raw }),
            },
            invocation: (original: string) => `/skill:${name} ${original}`,
            captureExpansion: () => undefined,
          };
        },
        // Activation stage owns fixed two-axis dispatch (issue #236 lifecycle).
        runReviewerDispatch: async (execution) => {
          const pin = {
            repositoryRoot: fixtureRoot,
            objectFormat: "sha1" as const,
            targetHead: oid("9"),
            refs: { "refs/heads/main": { objectId: oid("9"), peeledCommitId: oid("9") } },
          };
          const usage = {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          const standardsLeg = execution.legs.find((leg) => leg.axis === "standards");
          const specLeg = execution.legs.find((leg) => leg.axis === "spec");
          if (standardsLeg === undefined || specLeg === undefined) {
            throw new Error("fixture expects fixed two-axis dispatch");
          }
          const success = (prompt: string) => Object.freeze({
            status: "successful" as const,
            report: "ok",
            usage,
            target: pin,
            prompt,
            workspaceDisposition: "deleted" as const,
          });
          return Object.freeze({
            identity: execution.identity,
            target: pin,
            legs: Object.freeze({
              standards: success(standardsLeg.prompt),
              spec: success(specLeg.prompt),
            }),
          });
        },
      };
    case "collector":
      return {
        ...base,
        loadCollectorSoul: law,
        createCollectorTransport: () => createFakeGitHubTransport({
          user: sampleUser(),
          pullRequest: samplePull(),
          reviews: [],
          issueComments: [],
          reviewComments: [],
        }),
      };
    case "doctor":
      return {
        ...base,
        loadDoctorSoul: law,
        loadDoctorCase: async () => ({
          version: 1 as const,
          identity: { issueNumber: 1, runsPath: "/lawful/case" },
          cost: emptyDoctorCost,
          evidence: [],
        }),
        auditDoctorCompliance: async () => ({ status: "pass" as const }),
      };
    case "merger": {
      const mergerInput = {
        version: 1 as const,
        attemptId: "attempt-1",
        targetObjectId: oid("a"),
        sourceObjectId: oid("b"),
        expectedConflictPaths: ["conflict.txt"],
        resolutionScope: ["conflict.txt"],
        authorizedChecks: [{ name: "test", argv: ["npm", "test"] }],
        materials: {
          task: mergerMaterial("task"),
          authority: mergerMaterial("authority"),
          targetIntent: mergerMaterial("target intent"),
          sourceIntent: mergerMaterial("source intent"),
        },
      };
      return {
        ...base,
        loadMergerSoul: law,
        loadMergerInput: async () => mergerInput,
        createMergerGitState: () => ({
          activeMerge: async () => ({
            targetObjectId: oid("a"),
            sourceObjectId: oid("b"),
            unmergedPaths: ["conflict.txt"],
            automaticMergeTreeId: oid("c"),
          }),
          completedMerge: async () => { throw new Error("unused"); },
        }),
      };
    }
    case "notary":
      return {
        ...base,
        loadNotarySoul: law,
        loadNotarySourceRun: async (path: string) => ({
          runDirectory: path,
          runId: "01a034f1-75bf-71a6-bcf5-d1299145b1a5",
          role: "judge",
        }),
      };
    case "countersign":
      return { ...base, loadCountersignSoul: law };
    case "gleaner-left":
      return { ...base, loadGleanerLeftSoul: law };
    case "inspector":
      return { ...base, loadInspectorSoul: law };
    case "gatekeeper":
      return { ...base, loadGatekeeperSoul: law };
    case "navigator":
      return { ...base, loadNavigatorSoul: law };
    default:
      throw new Error(`unexpected packaged role: ${role}`);
  }
}

function admissionFlagsForRole(role: string, fixtureRoot: string): Record<string, unknown> {
  switch (role) {
    case "judge":
      return {};
    case "fixer":
      return { "ak-fixer-phase": "plan", "ak-fix-packet": "/lawful/packet.md" };
    case "coder":
      return { "ak-coder-phase": "plan", "ak-coder-task": "/lawful/task.md" };
    case "reviewer":
      return {
        "ak-review-base": "main~1",
      };
    case "collector":
      return {
        "ak-collector-repo": "acme/widgets",
        "ak-collector-pr": "1",
      };
    case "doctor":
      return { "ak-doctor-case": "/lawful/case" };
    case "merger":
      return { "ak-merger-input": "/lawful/merger.json" };
    case "notary":
      return { "ak-notary-source-run": "/lawful/01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge" };
    case "gleaner-left":
      return { "ak-gleaner-left-base": "HEAD" };
    default:
      return {};
  }
}

test("packaged terminating tools expose the provider-open registration inventory", async () => {
  // ADR 0057 / #676 D: prove real registration boundary — unique open terminating tool,
  // field declarations + semantic descriptions survive host adapter. Do NOT freeze a
  // hand-copied parallel field roster (exact set assertions wash legitimate new fields).
  assert.deepEqual(
    new Set(PACKAGED_ROLE_REGISTRY.map(({ outputTool }) => outputTool)),
    new Set(TERMINATING_TOOL_NAMES),
    "packaged roles and canonical terminating tools must describe the same inventory",
  );

  type Schema = {
    type?: unknown;
    anyOf?: Schema[];
    oneOf?: unknown;
    required?: unknown;
    additionalProperties?: unknown;
    description?: unknown;
    properties?: Record<string, Schema & { description?: unknown; items?: Schema }>;
    items?: Schema;
  };

  await withActivationHome({ prefix: "ak-terminating-inventory-" }, async ({ home, agentDir }) => {
    const fixtureRoot = join(home, "inventory-fixtures");
    mkdirSync(fixtureRoot, { recursive: true });
    const faux = fauxProvider({ api: "ak-terminating-inventory", provider: "ak-terminating-inventory" });

    for (const entry of PACKAGED_ROLE_REGISTRY) {
      process.exitCode = undefined;
      const flags = Object.fromEntries(Object.entries({
        "ak-role": entry.role,
        ...admissionFlagsForRole(entry.role, fixtureRoot),
      }).map(([name, value]) => [name, String(value)]));
      let registrationApi: ExtensionAPI | undefined;
      const productionFactory = createPiRoleRuntimeExtension(admissionDepsForRole(entry.role, fixtureRoot));
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: home,
        agentDir,
        faux,
        modelsPath: null,
        noExtensions: true,
        systemPrompt: `INVENTORY ${entry.role}`,
        mode: "print",
        flags,
        extensionFactories: [(pi) => {
          registrationApi = pi;
          productionFactory(pi);
        }],
      }, async () => {
        assert.ok(registrationApi, `${entry.role} production factory API`);
        const registrations = registrationApi.getAllTools().filter(({ name }) => name === entry.outputTool);
        assert.equal(registrations.length, 1, `${entry.role}/${entry.outputTool} registration count`);
        const parameters = registrations[0]!.parameters as Schema;
        const label = `${entry.role}/${entry.outputTool}`;
        assert.equal(parameters.type, "object", `${label} Object root`);
        assert.equal(parameters.anyOf, undefined, `${label} has no root anyOf`);
        assert.equal(parameters.oneOf, undefined, `${label} has no root oneOf`);
        assert.deepEqual(parameters.required, [], `${label} provider required fields`);
        assert.equal(parameters.additionalProperties, true, `${label} provider-open root`);
        const properties = parameters.properties ?? {};
        // Shared infra declaration must survive registration (schema true source).
        assert.ok(
          Object.hasOwn(properties, "infrastructureFailure"),
          `${label} retains infrastructureFailure declaration`,
        );
        // #676 D/C / ADR 0057: nested diagnostic declaration survives the registration boundary.
        // Compare registered result against the composed schema true source — not a hand roster.
        const registeredInfra = properties.infrastructureFailure as Schema | undefined;
        assert.ok(
          registeredInfra?.properties && Object.hasOwn(registeredInfra.properties, "diagnostic"),
          `${label}.infrastructureFailure.diagnostic nested declaration retained across registration`,
        );
        for (const [field, declaration] of Object.entries(properties)) {
          assert.ok(
            typeof declaration.description === "string" && declaration.description.trim().length > 0,
            `${label}.${field} semantic description retained`,
          );
        }

        if (entry.role === "fixer") {
          assert.ok(properties.blocker?.anyOf, `${label}.blocker retains its legal union`);
          const classResultsBranches = properties.classResults?.anyOf;
          assert.ok(classResultsBranches, `${label}.classResults retains its property-level legal union`);
          assert.ok(
            classResultsBranches.some((branch) => branch.items?.anyOf),
            `${label}.classResults mixed branch items retain their legal union`,
          );
        } else if (entry.role === "doctor") {
          assert.ok(properties.findings?.items?.anyOf, `${label}.findings item retains its legal union`);
        } else if (entry.role === "collector") {
          // #676 D/C: nested findings item declarations (evidenceId/category/summary) survive
          // registration without locking a parallel field roster or wording.
          assert.ok(Object.hasOwn(properties, "findings"), `${label}.findings declaration retained`);
          assert.ok(
            Object.hasOwn(properties, "unfinishedReasons"),
            `${label}.unfinishedReasons declaration retained`,
          );
          const findingsDecl = properties.findings as Schema | undefined;
          const itemProps = findingsDecl?.items?.properties;
          assert.ok(itemProps && Object.hasOwn(itemProps, "evidenceId"), `${label}.findings.items.evidenceId nested declaration`);
          assert.ok(itemProps && Object.hasOwn(itemProps, "category"), `${label}.findings.items.category nested declaration`);
          assert.ok(itemProps && Object.hasOwn(itemProps, "summary"), `${label}.findings.items.summary nested declaration`);
        }
      });
    }
  });
});

test("remaining support tools expose their actual registration inventory", async () => {
  const cases = [
    { role: "doctor", name: DOCTOR_EVIDENCE_TOOL_NAME, fields: ["evidenceId", "offset", "limit"] },
    // #495 S1: candidates field guidance lives on the prepare schema (not an acceptance gate).
    { role: "navigator", name: NAVIGATOR_PREPARE_TOOL_NAME, fields: ["candidates"] },
  ] as const;
  type Schema = {
    type?: unknown;
    anyOf?: unknown;
    oneOf?: unknown;
    properties?: Record<string, { description?: unknown }>;
  };

  await withActivationHome({ prefix: "ak-support-inventory-" }, async ({ home, agentDir }) => {
    const fixtureRoot = join(home, "support-inventory-fixtures");
    mkdirSync(fixtureRoot, { recursive: true });
    const faux = fauxProvider({ api: "ak-support-inventory", provider: "ak-support-inventory" });

    for (const entry of cases) {
      process.exitCode = undefined;
      let registrationApi: ExtensionAPI | undefined;
      const flags = entry.role === "navigator" ? {} : Object.fromEntries(Object.entries({
        "ak-role": entry.role,
        ...admissionFlagsForRole(entry.role, fixtureRoot),
      }).map(([name, value]) => [name, String(value)]));
      const extensionFactories = entry.role === "navigator"
        ? []
        : [(pi: ExtensionAPI) => {
            registrationApi = pi;
            createPiRoleRuntimeExtension(admissionDepsForRole(entry.role, fixtureRoot))(pi);
          }];

      await withInProcessPi({
        activationLedgerSession: entry.role !== "navigator",
        cwd: home,
        agentDir,
        faux,
        modelsPath: null,
        noExtensions: true,
        ...(entry.role === "navigator" ? {
          noTools: "builtin" as const,
          customTools: [createNavigatorPrepareTool(() => {})],
        } : {}),
        systemPrompt: `SUPPORT INVENTORY ${entry.role}`,
        mode: "print",
        flags,
        extensionFactories,
      }, async ({ session }) => {
        const registrations = entry.role === "navigator"
          ? session.agent.state.tools.filter(({ name }) => name === entry.name)
          : (assert.ok(registrationApi, `${entry.role} actual session API`), registrationApi.getAllTools().filter(({ name }) => name === entry.name));
        assert.equal(registrations.length, 1, `${entry.role}/${entry.name} registration count`);
        const parameters = registrations[0]!.parameters as Schema;
        const label = `${entry.role}/${entry.name}`;
        assert.equal(parameters.type, "object", `${label} Object root`);
        assert.equal(parameters.anyOf, undefined, `${label} has no root anyOf`);
        assert.equal(parameters.oneOf, undefined, `${label} has no root oneOf`);
        assert.deepEqual(Object.keys(parameters.properties ?? {}).sort(), [...entry.fields].sort(), `${label} semantic fields`);
        for (const [field, declaration] of Object.entries(parameters.properties ?? {})) {
          assert.ok(typeof declaration.description === "string" && declaration.description.trim().length > 0, `${label}.${field} semantic description`);
        }
        if (entry.role === "navigator") assert.equal(faux.state.callCount, 0, `${label} model calls`);
      });
    }
  });
});

test("every registered role writes exactly one accepted-activation fact after admission", async () => {
  assert.ok(PACKAGED_ROLE_REGISTRY.some((entry) => entry.role === "collector"), "Collector must remain in the #52 registry gate");
  // #52 registry activation seam via shared withInProcessPi owner (not a local registry harness).
  await withActivationHome({ prefix: "ak-act-admit-" }, async ({ home, agentDir }) => {
    const fixtureRoot = join(home, "admit-fixtures");
    mkdirSync(fixtureRoot, { recursive: true });
    const bookKey = activationBookKeyFor(home);
    const previousCorr = process.env.AK_CORRELATION_ID;
    const faux = fauxProvider({ api: "ak-act-admit", provider: "ak-act-admit" });

    try {
      for (const entry of PACKAGED_ROLE_REGISTRY) {
        process.exitCode = undefined;
        process.env.AK_CORRELATION_ID = `corr-${entry.role}`;
        const roleFlags = Object.fromEntries(
          Object.entries({
            "ak-role": entry.role,
            ...admissionFlagsForRole(entry.role, fixtureRoot),
          }).map(([key, value]) => [key, String(value)]),
        );
        await withInProcessPi({
          activationLedgerSession: true,
          cwd: home,
          agentDir,
          faux,
          modelsPath: null,
          noExtensions: true,
          systemPrompt: `ADMIT ${entry.role}`,
          mode: "print",
          flags: roleFlags,
          extensionFactories: [createPiRoleRuntimeExtension(admissionDepsForRole(entry.role, fixtureRoot))],
        }, async ({ sessionManager }) => {
          const sessionFile = sessionManager.getSessionFile();
          assert.ok(typeof sessionFile === "string" && sessionFile.length > 0);
          const facts = readAcceptedActivationFacts(home, bookKey);
          const roleFacts = facts.filter((fact) => fact.role === entry.role);
          assert.equal(roleFacts.length, 1, `${entry.role} admitted fact count`);
          assert.deepEqual(roleFacts[0], {
            event: ACCEPTED_ACTIVATION_EVENT,
            role: entry.role,
            observedAt: "2025-06-01T12:00:00.000Z",
            bookKey,
            session: { kind: "session-file", path: realpathSync(sessionFile) },
            correlation: { kind: "caller", id: `corr-${entry.role}` },
          });

          // One normal admitted fact is enough to prove the real-leg matched tracer
          // without a third harness (canonical fact already produced above).
          if (entry.role === "judge") {
            const admitted = roleFacts[0]!;
            const correlationId = `corr-${entry.role}`;
            const outcome = reconcileInvocation({
              dispatch: buildDispatchStubFact({
                correlation: { kind: "caller", id: correlationId },
                bookKey,
                observedAt: "2025-06-01T11:59:59.000Z",
                dispatch: { kind: "process", pid: 1 },
              }),
              activation: admitted,
            });
            assert.deepEqual(outcome, {
              kind: "matched",
              correlationId,
              bookKey,
            });
          }
        });
      }

      // Missing correlation identity uses the production env channel (typed absent).
      delete process.env.AK_CORRELATION_ID;
      process.exitCode = undefined;
      const beforeAbsent = readAcceptedActivationFacts(home, bookKey).length;
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: home,
        agentDir,
        faux,
        modelsPath: null,
        noExtensions: true,
        systemPrompt: "ADMIT ABSENT",
        mode: "print",
        flags: { "ak-role": "judge" },
        extensionFactories: [createPiRoleRuntimeExtension(admissionDepsForRole("judge", fixtureRoot))],
      }, async () => {
        const afterAbsent = readAcceptedActivationFacts(home, bookKey);
        assert.equal(afterAbsent.length, beforeAbsent + 1);
        assert.deepEqual(afterAbsent.at(-1)?.correlation, { kind: "absent" });
      });

      // Envelope barrier opens only after admitted fact write (real ExtensionRunner).
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: home,
        agentDir,
        faux,
        modelsPath: null,
        noExtensions: true,
        systemPrompt: "ADMIT BARRIER",
        mode: "print",
        flags: { "ak-role": "judge" },
        extensionFactories: [createPiRoleRuntimeExtension(admissionDepsForRole("judge", fixtureRoot))],
      }, async ({ session }) => {
        await session.extensionRunner.emitBeforeAgentStart("go", undefined, "BASE", { cwd: home });
      });
    } finally {
      if (previousCorr === undefined) delete process.env.AK_CORRELATION_ID;
      else process.env.AK_CORRELATION_ID = previousCorr;
    }
  });
});

test("unselected role and unsupported role leave zero accepted-activation facts", async () => {
  await withActivationHome({ prefix: "ak-act-unsel-" }, async ({ home, agentDir }) => {
    const faux = fauxProvider({ api: "ak-act-unsel", provider: "ak-act-unsel" });
    process.exitCode = undefined;
    await withInProcessPi({
      activationLedgerSession: true,
      cwd: home,
      agentDir,
      faux,
      modelsPath: null,
      noExtensions: true,
      systemPrompt: "UNSELECTED",
      mode: "print",
      flags: {},
      extensionFactories: [createPiRoleRuntimeExtension({
        loadJudgeSoul: async () => "LAW",
        auditSoulCompliance: async () => ({ status: "pass" }),
      })],
    }, async () => {
      assert.equal(readAcceptedActivationFacts(home, activationBookKeyFor(home)).length, 0);
    });

    process.exitCode = undefined;
    await assert.rejects(async () => withInProcessPi({
      activationLedgerSession: true,
      cwd: home,
      agentDir,
      faux,
      modelsPath: null,
      noExtensions: true,
      systemPrompt: "UNSUPPORTED",
      mode: "print",
      flags: { "ak-role": "router" },
      extensionFactories: [createPiRoleRuntimeExtension({
        loadJudgeSoul: async () => "LAW",
        auditSoulCompliance: async () => ({ status: "pass" }),
      })],
    }, async () => {
      throw new Error("unsupported role must not complete bindExtensions");
    }));
    assert.equal(readAcceptedActivationFacts(home, activationBookKeyFor(home)).length, 0);
  });
});

test("every registered whole-activation rejection terminates nonzero with a named cause before a model turn", async () => {
  // Ordinary integration owner: real ExtensionRunner via withInProcessPi (not a handler-capture seam).
  await withActivationHome({ prefix: "ak-act-reject-" }, async ({ home, agentDir }) => {
    const faux = fauxProvider({ api: "ak-act-reject", provider: "ak-act-reject" });
    for (const entry of PACKAGED_ROLE_REGISTRY) {
      process.exitCode = undefined;
      const traces: ActivationTraceRecord[] = [];
      const rejection = new TypeError(`${entry.role} activation rejected`);
      const reject = async (): Promise<never> => { throw rejection; };
      const flags: Record<string, string> = {
        "ak-role": entry.role,
        // Envelope-owned Reviewer transport must be present so soul rejection is the observed cause.
        "ak-review-base": "main~1",
        "ak-doctor-case": "/lawful/case",
        "ak-merger-input": "/lawful/merger.json",
        "ak-notary-source-run": "/lawful/01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge",
        "ak-gleaner-left-base": "HEAD",
      };
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: home,
        agentDir,
        faux,
        modelsPath: null,
        noExtensions: true,
        systemPrompt: `REJECT ${entry.role}`,
        mode: "print",
        flags,
        extensionFactories: [createPiRoleRuntimeExtension({
          loadJudgeSoul: reject,
          loadFixerSoul: reject,
          loadCoderSoul: reject,
          loadReviewerSoul: reject,
          loadCollectorSoul: reject,
          loadDoctorSoul: reject,
          loadNotarySoul: reject,
          loadCountersignSoul: reject,
          loadGleanerLeftSoul: reject,
          loadInspectorSoul: reject,
          loadGatekeeperSoul: reject,
          loadNavigatorSoul: reject,
          loadMergerSoul: reject,
          createMergerGitState: () => ({ activeMerge: reject, completedMerge: reject }),
          auditSoulCompliance: async () => ({ status: "pass" }),
          activationClock: () => "2025-01-01T00:00:00.000Z",
          activationTraceWriter: (record) => { traces.push(record); },
        })],
      }, async ({ session }) => {
        // session_start rejection is swallowed by ExtensionRunner.emit after failInfrastructure.
        assert.equal(process.exitCode, 1, `${entry.role} must terminate nonzero on rejection`);
        assert.equal(
          readAcceptedActivationFacts(home, activationBookKeyFor(home)).length,
          0,
          `${entry.role} wrote an accepted-activation fact on rejection`,
        );
        const failed = traces.find((trace) => trace.status === "failed");
        assert.ok(failed && failed.status === "failed", `${entry.role} missing failed activation trace`);
        assert.equal(failed.cause.identity, "TypeError");
        assert.equal(failed.cause.name, "TypeError");
        assert.equal(failed.cause.message, `${entry.role} activation rejected`);
        if (typeof failed.cause.evidenceId !== "string") throw new Error("missing activation evidence id");
        assert.match(failed.cause.evidenceId, /^activation-cause-/);

        // Barrier through the real ExtensionRunner before any provider turn.
        // emitBeforeAgentStart swallows handler throws after failInfrastructure; observe abort + exit + extension error.
        const extensionErrors: ExtensionError[] = [];
        session.extensionRunner.onError((error) => { extensionErrors.push(error); });
        let aborts = 0;
        await session.bindExtensions({
          mode: "print",
          abortHandler: () => { aborts += 1; },
        });
        process.exitCode = undefined;
        aborts = 0;
        extensionErrors.length = 0;
        await session.extensionRunner.emitBeforeAgentStart("go", undefined, "BASE", { cwd: home });
        assert.equal(aborts, 1, `${entry.role} barrier must abort`);
        assert.equal(process.exitCode, 1, `${entry.role} barrier must set nonzero exit`);
        assert.ok(
          extensionErrors.some((error) => (
            error.event === "before_agent_start"
            && error.error.includes("activation did not complete")
          )),
          `${entry.role} barrier must surface ActivationBarrierError via extension error; got ${JSON.stringify(extensionErrors)}`,
        );
        // This suite never prompts the session after rejection — barrier owns the before_agent_start seam.
        assert.equal(session.agent.state.messages.length, 0, `${entry.role} must not dispatch a model turn`);
      });
    }
  });
});

test("book key follows git common-dir host basename across worktrees, rename, and basename collision", () => {
  const root = mkdtempSync(join(tmpdir(), "ak-book-topo-"));
  try {
    const main = join(root, "project-alpha");
    mkdirSync(main);
    execFileSync("git", ["init", "-b", "main"], { cwd: main, stdio: "ignore" });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
      cwd: main,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    const worktree = join(root, "project-alpha-wt");
    execFileSync("git", ["worktree", "add", worktree], { cwd: main, stdio: "ignore" });
    assert.equal(resolveBookKeyFromGit(main), "project-alpha");
    assert.equal(resolveBookKeyFromGit(worktree), "project-alpha");

    const renamed = join(root, "project-beta");
    renameSync(main, renamed);
    assert.equal(resolveBookKeyFromGit(renamed), "project-beta");

    const twin = join(root, "collision", "project-beta");
    mkdirSync(join(root, "collision"), { recursive: true });
    mkdirSync(twin);
    execFileSync("git", ["init", "-b", "main"], { cwd: twin, stdio: "ignore" });
    assert.equal(resolveBookKeyFromGit(twin), "project-beta");
    assert.equal(resolveBookKeyFromGit(renamed), resolveBookKeyFromGit(twin));

    // Non-git cwd must loudly reject even when GIT_DIR points at another repository.
    const nonGit = join(root, "not-a-repo");
    mkdirSync(nonGit);
    const previousGitDir = process.env.GIT_DIR;
    const previousGitCommon = process.env.GIT_COMMON_DIR;
    const previousGitWorkTree = process.env.GIT_WORK_TREE;
    try {
      process.env.GIT_DIR = join(renamed, ".git");
      process.env.GIT_COMMON_DIR = join(renamed, ".git");
      process.env.GIT_WORK_TREE = renamed;
      assert.throws(
        () => resolveBookKeyFromGit(nonGit),
        (error: unknown) => {
          assert.ok(error instanceof ActivationGitRepositoryRequiredError);
          assert.equal(error.code, "AK_ACTIVATION_GIT_REPOSITORY_REQUIRED");
          assert.ok(error.cause !== undefined, "original git cause must be retained");
          return true;
        },
      );
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
      if (previousGitCommon === undefined) delete process.env.GIT_COMMON_DIR;
      else process.env.GIT_COMMON_DIR = previousGitCommon;
      if (previousGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = previousGitWorkTree;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git spawn infrastructure failures retain identity and do not masquerade as non-git", () => {
  const root = mkdtempSync(join(tmpdir(), "ak-book-infra-"));
  try {
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    // Empty PATH makes spawn of `git` fail with ENOENT — infrastructure, not non-git cwd.
    const emptyBin = join(root, "empty-bin");
    mkdirSync(emptyBin);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = emptyBin;
      assert.throws(
        () => resolveBookKeyFromGit(cwd),
        (error: unknown) => {
          assert.equal(
            error instanceof ActivationGitRepositoryRequiredError,
            false,
            "ENOENT must not become ActivationGitRepositoryRequiredError",
          );
          assert.ok(error !== null && typeof error === "object" && "code" in error);
          assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
          return true;
        },
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    // Control: a real git child that exits nonzero remains the typed non-git error.
    assert.throws(
      () => resolveBookKeyFromGit(cwd),
      (error: unknown) => {
        assert.ok(error instanceof ActivationGitRepositoryRequiredError);
        assert.equal(error.code, "AK_ACTIVATION_GIT_REPOSITORY_REQUIRED");
        assert.ok(error.cause !== undefined);
        const cause = error.cause as { status?: unknown };
        assert.equal(typeof cause.status, "number");
        assert.notEqual(cause.status, 0);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mixed concurrent O_APPEND producers keep intact records with exact cardinality", async () => {
  // Shared-ledger contract: package append and a foreign O_APPEND producer must not
  // overwrite one another. No private lock / positional rewrite / truncate ownership.
  const root = mkdtempSync(join(tmpdir(), "ak-ledger-mixed-"));
  try {
    const ledgerHome = join(root, "home");
    const bookKey = "mixed-book";
    const ledgerPath = activationWaitingLedgerPath(ledgerHome, bookKey);
    const packageWorker = join(root, "package-worker.mjs");
    const foreignWorker = join(root, "foreign-worker.mjs");
    writeFileSync(packageWorker, `
import { appendAcceptedActivationFact, buildAcceptedActivationFact } from ${JSON.stringify(pathToFileURL(resolve(packageRoot, "src/activation-ledger.ts")).href)};
const index = Number(process.argv[2]);
const ledgerPath = process.argv[3];
const ledgerHome = process.argv[4];
appendAcceptedActivationFact(ledgerPath, buildAcceptedActivationFact({
  role: "judge",
  observedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
  bookKey: "mixed-book",
  session: { kind: "session-file", path: "/s/pkg-" + index + ".jsonl" },
  correlation: { kind: "caller", id: "pkg-" + index },
}), { ledgerHome });
`);
    writeFileSync(foreignWorker, `
import { constants, closeSync, openSync, writeSync } from "node:fs";
const index = Number(process.argv[2]);
const ledgerPath = process.argv[3];
const line = Buffer.from(JSON.stringify({ producer: "foreign", id: "foreign-" + index }) + "\\n", "utf8");
const fd = openSync(ledgerPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o644);
try {
  const written = writeSync(fd, line, 0, line.length, null);
  if (written !== line.length) throw new Error("foreign short write " + written + "/" + line.length);
} finally {
  closeSync(fd);
}
`);
    // Ensure parent tree exists so foreign O_APPEND open does not race mkdir.
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const packageCount = 8;
    const foreignCount = 8;
    const children = await Promise.all([
      ...Array.from({ length: packageCount }, (_, index) =>
        runNodeSubprocess(
          ["--import", "tsx", packageWorker, String(index), ledgerPath, ledgerHome],
          { cwd: packageRoot, timeoutMs: 15_000 },
        )),
      ...Array.from({ length: foreignCount }, (_, index) =>
        runNodeSubprocess(
          ["--import", "tsx", foreignWorker, String(index), ledgerPath],
          { cwd: packageRoot, timeoutMs: 15_000 },
        )),
    ]);
    for (const child of children) {
      assert.equal(child.code, 0, child.stderr);
    }
    const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, packageCount + foreignCount);
    const packageIds: string[] = [];
    const foreignIds: string[] = [];
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.event === ACCEPTED_ACTIVATION_EVENT) {
        const fact = row as unknown as AcceptedActivationFact;
        assert.equal(fact.bookKey, bookKey);
        assert.equal(fact.correlation.kind, "caller");
        if (fact.correlation.kind === "caller") packageIds.push(fact.correlation.id);
        continue;
      }
      assert.equal(row.producer, "foreign");
      assert.equal(typeof row.id, "string");
      foreignIds.push(row.id as string);
    }
    assert.deepEqual(packageIds.sort(), Array.from({ length: packageCount }, (_, i) => `pkg-${i}`).sort());
    assert.deepEqual(foreignIds.sort(), Array.from({ length: foreignCount }, (_, i) => `foreign-${i}`).sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent first-time ledger directory creation across books stays race-safe", async () => {
  // Fresh home: workers race on creating shared ledgerHome/books components plus distinct books.
  const root = mkdtempSync(join(tmpdir(), "ak-ledger-mkdir-race-"));
  try {
    const ledgerHome = join(root, "home");
    const worker = join(root, "mkdir-race-worker.mjs");
    writeFileSync(worker, `
import { appendAcceptedActivationToBook, buildAcceptedActivationFact } from ${JSON.stringify(pathToFileURL(resolve(packageRoot, "src/activation-ledger.ts")).href)};
const index = Number(process.argv[2]);
const ledgerHome = process.argv[3];
const bookKey = "book-" + index;
appendAcceptedActivationToBook({
  ledgerHome,
  fact: buildAcceptedActivationFact({
    role: "judge",
    observedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
    bookKey,
    session: { kind: "session-file", path: "/s/" + index + ".jsonl" },
    correlation: { kind: "caller", id: "mkdir-" + index },
  }),
});
`);
    const workerCount = 16;
    // Native type stripping keeps this filesystem race under the child deadline even
    // when the full suite is concurrently compiling elsewhere; one tsx service per
    // worker made loader contention, rather than ledger creation, decide the result.
    const children = await Promise.all(Array.from({ length: workerCount }, (_, index) =>
      runNodeSubprocess(
        ["--experimental-strip-types", worker, String(index), ledgerHome],
        { cwd: packageRoot, timeoutMs: 15_000 },
      )));
    for (const child of children) {
      assert.equal(child.code, 0, child.stderr);
    }
    for (let index = 0; index < workerCount; index += 1) {
      const bookKey = `book-${index}`;
      const lines = readFileSync(activationWaitingLedgerPath(ledgerHome, bookKey), "utf8")
        .split("\n")
        .filter(Boolean);
      assert.equal(lines.length, 1, `${bookKey} must keep exactly one accepted fact`);
      const row = JSON.parse(lines[0]!) as AcceptedActivationFact;
      assert.equal(row.event, ACCEPTED_ACTIVATION_EVENT);
      assert.equal(row.bookKey, bookKey);
      assert.deepEqual(row.correlation, { kind: "caller", id: `mkdir-${index}` });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Symlink escape matrix (#420 整改并一)：四条同根同形「ledger append 拒绝符号链接
// 逃逸且不写出界」——root home 链、跨簿 waiting.jsonl、跨簿目录、books 组件——
// 收成一条四向量表。ADR 0065 的 principal 不做卷宗放置检查断言随迁保留。
test("ledger append rejects every symlink escape vector without writing outside", async () => {
  // Vector 1: pre-existing root symlink escape.
  await withActivationHome({ prefix: "ak-act-root-symlink-" }, async ({ home }) => {
    const bookKey = activationBookKeyFor(home);
    const ledgerHome = machineLedgerHome(home);
    const outside = join(home, "consumer-repo-ledger");
    mkdirSync(outside, { recursive: true });
    // Configured machine home itself is a symlink into a consumer path.
    symlinkSync(outside, ledgerHome);

    assert.throws(
      () => appendAcceptedActivationFact(
        join(ledgerHome, "books", bookKey, "waiting.jsonl"),
        buildAcceptedActivationFact({
          role: "judge",
          observedAt: "2025-01-01T00:00:00.000Z",
          bookKey,
          session: { kind: "session-file", path: join(home, "s.jsonl") },
          correlation: { kind: "absent" },
        }),
        { ledgerHome },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ActivationLedgerError);
        assert.equal(error.code, "AK_ACTIVATION_LEDGER");
        return true;
      },
    );
    assert.equal(existsSync(join(outside, "books", bookKey, "waiting.jsonl")), false);
    assert.equal(existsSync(join(outside, "books")), false);
  });

  // Vector 2: cross-book waiting.jsonl symlink.
  await withActivationHome({ prefix: "ak-act-cross-book-symlink-" }, async ({ home }) => {
    const sourceBook = activationBookKeyFor(home);
    const targetBook = `${sourceBook}-other`;
    const ledgerHome = machineLedgerHome(home);
    const sourceLedger = join(ledgerHome, "books", sourceBook, "waiting.jsonl");
    const targetLedger = join(ledgerHome, "books", targetBook, "waiting.jsonl");
    mkdirSync(dirname(sourceLedger), { recursive: true });
    mkdirSync(dirname(targetLedger), { recursive: true });
    writeFileSync(targetLedger, "");
    // Waiting path for the computed book redirects into another book still inside the home.
    symlinkSync(targetLedger, sourceLedger);

    assert.throws(
      () => appendAcceptedActivationFact(
        sourceLedger,
        buildAcceptedActivationFact({
          role: "judge",
          observedAt: "2025-01-01T00:00:00.000Z",
          bookKey: sourceBook,
          session: { kind: "session-file", path: join(home, "s.jsonl") },
          correlation: { kind: "absent" },
        }),
        { ledgerHome },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ActivationLedgerError);
        assert.equal(error.code, "AK_ACTIVATION_LEDGER");
        return true;
      },
    );
    assert.equal(readFileSync(targetLedger, "utf8"), "");
  });

  // Vector 3: cross-book directory symlink.
  await withActivationHome({ prefix: "ak-act-cross-book-dir-symlink-" }, async ({ home }) => {
    const sourceBook = activationBookKeyFor(home);
    const targetBook = `${sourceBook}-other`;
    const ledgerHome = machineLedgerHome(home);
    const booksDir = join(ledgerHome, "books");
    const sourceDir = join(booksDir, sourceBook);
    const targetDir = join(booksDir, targetBook);
    const targetLedger = join(targetDir, "waiting.jsonl");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetLedger, "");
    // Computed basename book partition aliases another book still inside the home.
    symlinkSync(targetDir, sourceDir);

    assert.throws(
      () => appendAcceptedActivationFact(
        join(sourceDir, "waiting.jsonl"),
        buildAcceptedActivationFact({
          role: "judge",
          observedAt: "2025-01-01T00:00:00.000Z",
          bookKey: sourceBook,
          session: { kind: "session-file", path: join(home, "s.jsonl") },
          correlation: { kind: "absent" },
        }),
        { ledgerHome },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ActivationLedgerError);
        assert.equal(error.code, "AK_ACTIVATION_LEDGER");
        return true;
      },
    );
    assert.equal(readFileSync(targetLedger, "utf8"), "");
  });

  // Vector 4: books component symlink escaping the machine home + ADR 0065
  // principal-admits half (activation no longer polices record placement).
  await withActivationHome({ prefix: "ak-act-symlink-" }, async ({ home }) => {
    const bookKey = activationBookKeyFor(home);
    const ledgerHome = machineLedgerHome(home);
    const outside = join(home, "outside-ledger");
    mkdirSync(outside, { recursive: true });

    // Pre-existing books component symlink that escapes the machine home.
    mkdirSync(ledgerHome, { recursive: true });
    symlinkSync(outside, join(ledgerHome, "books"));
    assert.throws(
      () => appendAcceptedActivationFact(
        join(ledgerHome, "books", bookKey, "waiting.jsonl"),
        buildAcceptedActivationFact({
          role: "judge",
          observedAt: "2025-01-01T00:00:00.000Z",
          bookKey,
          session: { kind: "session-file", path: join(home, "s.jsonl") },
          correlation: { kind: "absent" },
        }),
        { ledgerHome },
      ),
      (error: unknown) => error instanceof Error,
    );
    assert.equal(existsSync(join(outside, bookKey, "waiting.jsonl")), false);

    // Session path lexically under book but final realpath escapes.
    // ADR 0065 / #221: activation no longer polices record placement — admit the
    // existing regular-file principal; archivist createRecordSession owns that lock.
    rmSync(join(ledgerHome, "books"), { force: true });
    const sessionFile = persistActivationSessionFile({ home, bookKey, cwd: home });
    const realSession = resolve(sessionFile);
    // Replace runs dir with symlink to consumer path holding a decoy file.
    const bookDir = join(ledgerHome, "books", bookKey);
    const runsDir = join(bookDir, "runs");
    const decoyDir = join(home, "decoy-runs", "activation", "default");
    mkdirSync(dirname(decoyDir), { recursive: true });
    // Move real tree aside then link.
    rmSync(runsDir, { recursive: true, force: true });
    mkdirSync(decoyDir, { recursive: true });
    const decoyFile = join(decoyDir, "session.jsonl");
    writeFileSync(decoyFile, `${JSON.stringify({ type: "session", version: 3, id: "decoy", timestamp: "2025-01-01T00:00:00.000Z", cwd: home })}\n`);
    symlinkSync(join(home, "decoy-runs"), runsDir);
    const pointer = durableSessionPointer(
      { getSessionFile: () => join(runsDir, "activation", "default", "session.jsonl") },
    );
    assert.equal(pointer.kind, "session-file");
    assert.equal(pointer.path, realpathSync(decoyFile));
    assert.notEqual(realSession, decoyFile);
  });
});

test("incident 2026-08-02: malformed Fixer prerequisites fail the real Pi subprocess before provider dispatch", async () => {
  // Real CLI subprocess via existing harness; no audit-leg revival — call-count fixture only.
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  await withHermeticHome({ prefix: "ak-fixer-activation-incident-" }, async ({ home, agentDir }) => {
    const instructions = resolve(home, "instructions.md");
    const prerequisites = resolve(home, "prerequisites.json");
    await writeFile(instructions, "Apply the assigned repair.\n");
    await writeFile(prerequisites, JSON.stringify({ prerequisites: [] }));
    const sessionDirectory = resolve(
      home, ".ak-roles", "books", resolveBookKeyFromGit(packageRoot), "runs", "fixer-act", "session",
    );
    await mkdir(sessionDirectory, { recursive: true });
    const result = await runPiSubprocess([
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--session-dir", sessionDirectory,
      "-e", resolve(packageRoot, "extensions/role-runtime.ts"),
      "-e", resolve(packageRoot, "test/fixtures/coder-success-provider.ts"),
      "--ak-role", "fixer", "--ak-fixer-phase", "apply",
      "--ak-fix-packet", instructions,
      "--ak-fixer-prerequisites", prerequisites,
      "--provider", "ak-coder-offline", "--model", "faux-1", "-p", "Apply.",
    ], {
      cwd: packageRoot,
      timeoutMs: 15_000,
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
    });
    assert.equal(result.localTimeout, false, "malformed prerequisites subprocess did not time out");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /CODER_SUCCESS_PROVIDER_CALLS=0/);
    const traces = result.stderr.split("\n").flatMap((line) => {
      try {
        const value = JSON.parse(line) as ActivationTraceRecord;
        return Value.Check(activationTraceRecordSchema, value) ? [value] : [];
      } catch { return []; }
    });
    assert.deepEqual(traces.map(({ role, stageId, status }) => ({ role, stageId, status })), [
      { role: "fixer", stageId: "load-and-install", status: "failed" },
    ]);
    const failed = traces.find((trace) => trace.status === "failed");
    assert.ok(failed && failed.status === "failed", "missing failed activation trace");
    assert.equal(failed.role, "fixer");
    assert.equal(failed.stageId, "load-and-install");
    assert.equal(failed.cause.identity, "AK_INVALID_FIX_PACKET");
    assert.equal(failed.cause.name, "FixerPacketValidationError");
    assert.match(failed.cause.message, /Fixer prerequisites/);
    if (typeof failed.cause.evidenceId !== "string") throw new Error("missing activation evidence id");
    assert.match(failed.cause.evidenceId, /^activation-cause-/);
  });
});



test("observation writer failure aborts through real ExtensionRunner emit with original cause", async () => {
  await withActivationHome({ prefix: "ak-tool-obs-fail-" }, async ({ home, agentDir }) => {
    const faux = fauxProvider({ api: "ak-tool-obs-fail", provider: "ak-tool-obs-fail" });
    const writerError = new Error("stderr unavailable");
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let aborts = 0;
    const extensionErrors: ExtensionError[] = [];
    try {
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: home,
        agentDir,
        faux,
        modelsPath: null,
        noExtensions: true,
        systemPrompt: "JUDGE",
        mode: "print",
        flags: { "ak-role": "judge" },
        extensionFactories: [createPiRoleRuntimeExtension({
          loadJudgeSoul: async () => "LAW",
          auditSoulCompliance: async () => ({ status: "pass" }),
          activationClock: () => "2025-01-01T00:00:00.000Z",
          activationTraceWriter: () => {},
          toolExecutionObservationWriter: () => { throw writerError; },
        })],
      }, async ({ session }) => {
        session.extensionRunner.onError((error) => { extensionErrors.push(error); });
        // Rebind abort so the infrastructure path is observable without depending on agent internals.
        await session.bindExtensions({
          mode: "print",
          abortHandler: () => { aborts += 1; },
        });
        // emit() swallows handler throws after emitError — termination must still have run.
        await session.extensionRunner.emit({
          type: "tool_execution_start",
          toolCallId: "obs-fail-1",
          toolName: "bash",
          args: {},
        });
        assert.equal(aborts, 1, "observation failure must call ExtensionContext.abort");
        assert.equal(process.exitCode, 1, "print mode observation failure must set nonzero exitCode");
        assert.ok(
          extensionErrors.some((error) => error.event === "tool_execution_start" && error.error.includes("stderr unavailable")),
          `ExtensionRunner must retain the original cause via extension error; got ${JSON.stringify(extensionErrors)}`,
        );

        // Same termination for update and end seams.
        aborts = 0;
        process.exitCode = undefined;
        extensionErrors.length = 0;
        await session.extensionRunner.emit({
          type: "tool_execution_update",
          toolCallId: "obs-fail-1",
          toolName: "bash",
          args: {},
          partialResult: { content: [{ type: "text", text: "chunk" }] },
        });
        assert.equal(aborts, 1);
        assert.equal(process.exitCode, 1);
        assert.ok(extensionErrors.some((error) => error.event === "tool_execution_update" && error.error.includes("stderr unavailable")));

        aborts = 0;
        process.exitCode = undefined;
        extensionErrors.length = 0;
        await session.extensionRunner.emit({
          type: "tool_execution_end",
          toolCallId: "obs-fail-1",
          toolName: "bash",
          isError: false,
          result: { content: [], details: {} },
        });
        assert.equal(aborts, 1);
        assert.equal(process.exitCode, 1);
        assert.ok(extensionErrors.some((error) => error.event === "tool_execution_end" && error.error.includes("stderr unavailable")));
      });
    } finally {
      process.exitCode = priorExitCode;
    }
  });
});

test("shared envelope owns Reviewer skill expansion capture on before_agent_start", async () => {
  await withActivationHome({ prefix: "ak-reviewer-envelope-expansion-" }, async ({ home, agentDir }) => {
    const fixtureRoot = join(home, "reviewer-expansion-fixtures");
    mkdirSync(fixtureRoot, { recursive: true });
    const faux = fauxProvider({ api: "ak-reviewer-envelope-expansion", provider: "ak-reviewer-envelope-expansion" });
    const raw = "# code-review skill\n";
    const skillPath = "/skill/code-review/SKILL.md";
    const skillBody = raw;
    // Stable request token for expansion capture match — not a presentation-prose pin (#495 S4).
    const originalRequest = "main~1";
    const expectedContent = `References are relative to /skill/code-review.\n\n${skillBody}`;
    const lawfulExpansion =
      `<skill name="code-review" location="${skillPath}">\n${expectedContent}\n</skill>\n\n${originalRequest}`;

    const deps = admissionDepsForRole("reviewer", fixtureRoot);
    deps.loadCanonicalSkillBinding = async (name) => {
      assert.equal(name, "code-review");
      return {
        name: "code-review" as const,
        snapshot: {
          raw,
          path: skillPath,
          baseDir: "/skill/code-review",
          body: skillBody,
          snapshotIdentity: Object.freeze({ text: raw }),
        },
        invocation: (request: string) => `/skill:code-review ${request}`,
        captureExpansion: (evidence, request: string) => {
          if (
            evidence?.name !== "code-review"
            || evidence.location !== skillPath
            || evidence.content !== expectedContent
            || evidence.userMessage !== originalRequest
            || request !== originalRequest
          ) return undefined;
          return Object.freeze({ ...evidence, name: "code-review" as const });
        },
      };
    };
    deps.loadReviewerSoul = async () => "REVIEWER ENVELOPE LAW";

    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: home,
        agentDir,
        faux,
        modelsPath: null,
        noExtensions: true,
        systemPrompt: "REVIEWER EXPANSION",
        mode: "print",
        flags: {
          "ak-role": "reviewer",
          "ak-review-base": "main~1",
        },
        extensionFactories: [createPiRoleRuntimeExtension(deps)],
      }, async ({ session }) => {
        // Envelope owns input transform for package code-review invocation.
        const inputResult = await session.extensionRunner.emitInput(originalRequest, undefined, "interactive");
        assert.equal(inputResult.action, "transform");
        if (inputResult.action !== "transform") throw new Error("expected transform");
        assert.equal(inputResult.text, `/skill:code-review ${originalRequest}`);

        const promptResult = await session.extensionRunner.emitBeforeAgentStart(
          lawfulExpansion,
          undefined,
          "BASE",
          { cwd: home },
        );
        assert.ok(promptResult?.systemPrompt, "envelope must assemble parent system prompt");
        assert.match(promptResult.systemPrompt, /<reviewer_soul>\nREVIEWER ENVELOPE LAW\n<\/reviewer_soul>/);
        // #495 S2 / ADR 0073: Verification-Boundary machine copy deleted; soul owns cadence.
        assert.equal(
          promptResult.systemPrompt.includes("<reviewer_verification_boundary>"),
          false,
        );
        // skipped-missing disposition carrier absent when Spec launched (fixture two-axis dispatch).
        assert.equal(
          promptResult.systemPrompt.includes("<reviewer_spec_disposition>"),
          false,
        );
      });

      // Separate admission: expansion mismatch aborts through real ExtensionRunner.
      process.exitCode = undefined;
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: home,
        agentDir,
        faux,
        modelsPath: null,
        noExtensions: true,
        systemPrompt: "REVIEWER EXPANSION FAIL",
        mode: "print",
        flags: {
          "ak-role": "reviewer",
          "ak-review-base": "main~1",
        },
        extensionFactories: [createPiRoleRuntimeExtension(deps)],
      }, async ({ session }) => {
        await session.extensionRunner.emitInput(originalRequest, undefined, "interactive");
        // Do not re-bindExtensions here: that re-emits session_start and is a different seam.
        // Observe the envelope-owned before_agent_start fail-closed path via extension errors + exit.
        const extensionErrors: ExtensionError[] = [];
        session.extensionRunner.onError((error) => { extensionErrors.push(error); });
        process.exitCode = undefined;
        await session.extensionRunner.emitBeforeAgentStart(
          "not a canonical code-review expansion",
          undefined,
          "BASE",
          { cwd: home },
        );
        assert.equal(process.exitCode, 1, "expansion mismatch must set nonzero exit");
        assert.ok(
          extensionErrors.some((error) => (
            error.event === "before_agent_start"
            && error.error.includes("Canonical code-review Skill expansion did not match the captured request")
          )),
          `envelope must surface expansion mismatch via extension error; got ${JSON.stringify(extensionErrors)}`,
        );
      });
    } finally {
      process.exitCode = priorExitCode;
    }
  });
});
