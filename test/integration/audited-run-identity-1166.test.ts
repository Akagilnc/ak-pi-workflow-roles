/**
 * #1166 — four audit seats share audited-run identity `<runId>@<席>` in startup
 * materials; first utterance stays the peer submission bytes from this-round ledger;
 * package adds no audited-run directory path. Navigator prompt stays caller bytes.
 *
 * Seam: public `ak-role` + in-repo fake host (same createMinimalHost shape for
 * judge / coder / secretariat parents). prepareRoleEnvelope only reads the live
 * RoleTurnRequest the gate built — never invents continuation.prompt.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  AUDITED_RUN_IDENTITY_KIND,
  type AuditedRunIdentityMaterial,
} from "../../src/audited-run-identity.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import type {
  RoleTurnHost,
  RoleTurnRequest,
} from "../../src/host-contracts.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { savePublicCliConfig, setPersistentSeatConfig } from "../../src/public-cli/config.ts";
import { readableGateItem } from "../../src/readable-gate-item.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { formatRunLeaf, parseRunLeaf } from "../../src/role-run-placement.ts";
import { WorkerUnfinishedReasonReminderError } from "../../src/submission-errors.ts";
import { isRecord } from "../../src/unknown-value.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { listMcpToolNames, mcpRelayToken } from "../helpers/mcp-relay-list-tools.ts";
import {
  CANONICAL_SOURCE_RUN_ID,
  CANONICAL_SOURCE_ROLE,
  seedCanonicalSourceRun,
} from "../helpers/notary-fixtures.ts";
import { packageRoot, seedGitRepository } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { readCurrentSection } from "../helpers/run-dossier-fixture.ts";
import {
  createMinimalHost,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  withNestedTrueUnboundDiarist,
} from "../helpers/role-turn-host-fixture.ts";
import {
  recordNonSealedSubmission,
  sealAcceptedSubmission,
} from "../helpers/submission-ledger-fixture.ts";

const AUDITOR_DOSSIER_TOOL_NAME = "ak_get_run_dossier";
const PEER_PATH = "/caller/already/had/this/path.md";
const CREDENTIALS = { "openai-codex": true, xai: true } as const;

type OfficerRole = "notary" | "auditor" | "inspector" | "countersign";
type ParentRole = "judge" | "coder" | "secretariat";

function identityFromParent(parentRun: string): string {
  const leaf = parseRunLeaf(basename(parentRun));
  assert.ok(leaf !== undefined, "seeded parent must be runId@role");
  return formatRunLeaf(leaf.runId, leaf.role);
}

function auditedIdentityMaterials(
  materials: readonly unknown[],
): AuditedRunIdentityMaterial[] {
  return materials.filter(
    (material): material is AuditedRunIdentityMaterial =>
      isRecord(material)
      && material.kind === AUDITED_RUN_IDENTITY_KIND
      && typeof material.identity === "string",
  );
}

/** Package path handoffs about the audited run — structured field presence, not wire text. */
function packageAuditedPathMaterials(materials: readonly unknown[]): unknown[] {
  return materials.filter((material) => {
    if (!isRecord(material)) return false;
    if (material.kind === AUDITED_RUN_IDENTITY_KIND) return false;
    return typeof material.sourceRunPath === "string"
      || typeof material.runDirectory === "string";
  });
}

/** Prepare from a live public-entry RoleTurnRequest — prompt already set by gate/direct. */
async function inspectLiveRequest(
  request: RoleTurnRequest,
  packageRootPath: string,
): Promise<{
  readonly prompt: string;
  readonly identities: AuditedRunIdentityMaterial[];
  readonly pathMaterials: unknown[];
  readonly toolNames?: string[];
}> {
  const socketDir = await mkdtemp(join(tmpdir(), "ak-1166-live-"));
  const socketPath = join(socketDir, "mcp.sock");
  const priorSubject = process.env.AK_ROLE_AUDITOR_SUBJECT;
  const priorSource = process.env.AK_ROLE_AUDITOR_SOURCE_RUN;
  if (request.activation.role === "auditor") {
    const admitted = readCurrentSection(request.runDirectory, "admitted");
    const subject =
      typeof admitted.auditorSubject === "string" && admitted.auditorSubject.trim() !== ""
        ? admitted.auditorSubject
        : "judge";
    process.env.AK_ROLE_AUDITOR_SUBJECT = subject;
    if (typeof admitted.sourceRunPath === "string" && admitted.sourceRunPath.trim() !== "") {
      process.env.AK_ROLE_AUDITOR_SOURCE_RUN = admitted.sourceRunPath;
    }
  }
  try {
    const prepared = await prepareRoleEnvelope({
      request,
      dependencies: createRoleRuntimeDependencies(packageRootPath),
      socketPath,
      sessionFile: piDurablePrincipalAuthority.decode(request.principal).sessionFile,
      principalAuthority: piDurablePrincipalAuthority,
    });
    try {
      const identities = auditedIdentityMaterials(prepared.systemPrompt.materials);
      const pathMaterials = packageAuditedPathMaterials(prepared.systemPrompt.materials);
      let toolNames: string[] | undefined;
      if (request.activation.role === "auditor") {
        toolNames = await listMcpToolNames(socketPath, mcpRelayToken(prepared));
      }
      return {
        prompt: prepared.prompt,
        identities,
        pathMaterials,
        ...(toolNames === undefined ? {} : { toolNames }),
      };
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    if (request.activation.role === "auditor") {
      if (priorSubject === undefined) delete process.env.AK_ROLE_AUDITOR_SUBJECT;
      else process.env.AK_ROLE_AUDITOR_SUBJECT = priorSubject;
      if (priorSource === undefined) delete process.env.AK_ROLE_AUDITOR_SOURCE_RUN;
      else process.env.AK_ROLE_AUDITOR_SOURCE_RUN = priorSource;
    }
  }
}

async function configureOfficerSeats(home: string, roles: readonly string[]): Promise<void> {
  let config = { seats: {} };
  const seat = { provider: "test", model: "caller-seat", thinking: "high" } as const;
  for (const role of roles) {
    config = setPersistentSeatConfig(config, role as never, seat);
  }
  await savePublicCliConfig(config, home);
}

function officerSealHost(role: OfficerRole): RoleTurnHost {
  const toolName =
    role === "notary" ? NOTARY_OUTPUT_TOOL_NAME
    : role === "auditor" ? AUDITOR_OUTPUT_TOOL_NAME
    : role === "inspector" ? INSPECTOR_OUTPUT_TOOL_NAME
    : COUNTERSIGN_OUTPUT_TOOL_NAME;
  return roleTurnHostFromLegacyPiRunner({
    packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner: scriptedTerminatingToolSession({
      role,
      toolName,
      details: { status: "converged", ticketNumber: 1166 },
    }),
  });
}

/**
 * One fake-host shape for judge / coder / secretariat parents: seal the parent
 * ledger submission; nested officers hit the same host (public gate seam).
 */
function parentGateHost(input: {
  readonly home: string;
  readonly runId: string;
  readonly parentRole: ParentRole;
  readonly details: unknown;
  readonly capture: RoleTurnRequest[];
  readonly captureRoles: ReadonlySet<OfficerRole>;
}): RoleTurnHost {
  const inner = createMinimalHost(async (request) => {
    const role = request.activation.role;
    if (
      role === "notary"
      || role === "auditor"
      || role === "inspector"
      || role === "countersign"
    ) {
      if (input.captureRoles.has(role)) input.capture.push(request);
      return officerSealHost(role).executeTurn(request);
    }
    const { sessionDirectory, sessionFile } =
      piDurablePrincipalAuthority.decode(request.principal);
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(sessionFile, "", "utf8");
    await sealAcceptedSubmission({
      cwd: request.cwd,
      home: input.home,
      runId: input.runId,
      runDirectory: request.runDirectory,
      role: input.parentRole,
      details: input.details,
      toolCallId: `${input.parentRole}-1166`,
      ...(request.courtAttemptId === undefined
        ? {}
        : { courtAttemptId: request.courtAttemptId }),
    });
    return { code: 0, stderr: "", timedOut: false };
  });
  return withNestedTrueUnboundDiarist(inner, { primaryRole: input.parentRole });
}

test("#1166 public gate: four seats share identity; first utterance is ledger submission", async () => {
  await withTempRoot("ak-1166-gate-four-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await configureOfficerSeats(home, [
      "notary", "auditor", "inspector", "countersign", "diarist", "judge", "secretariat",
    ]);

    const seen: Array<{ role: string; identity: string; prompt: string }> = [];

    const cases: Array<{
      parentRole: ParentRole;
      argv: string[];
      runId: string;
      details: unknown;
      captureRoles: OfficerRole[];
      expectedIdentity?: string;
      identitySuffix?: RegExp;
    }> = [
      {
        parentRole: "judge",
        argv: ["judge", "--model", "test/caller-seat:high", "--project", project, "adjudicate"],
        runId: "01a0116600007000800000000000j001",
        details: {
          status: "converged" as const,
          ticketNumber: 1166,
          findings: [{ id: "N1", path: PEER_PATH }],
          reason: "peer body with a path must pass through unchanged",
        },
        captureRoles: ["notary", "auditor"],
        expectedIdentity: "01a0116600007000800000000000j001@judge",
      },
      {
        parentRole: "coder",
        argv: ["coder", "--model", "test/caller-seat:high", "--project", project, "implement"],
        runId: "01a0116600007000800000000000c001",
        details: {
          status: "completed" as const,
          ticketNumber: 1166,
          report: "done",
          findings: [{ id: "C1", path: PEER_PATH }],
        },
        captureRoles: ["inspector"],
        expectedIdentity: "01a0116600007000800000000000c001@coder",
      },
      {
        parentRole: "secretariat",
        argv: [
          "secretariat",
          "--model",
          "test/caller-seat:high",
          "--project",
          project,
          "整理票面",
        ],
        runId: "01a0116600007000800000000000s001",
        details: {
          secretariatStatus: "converged" as const,
          ticketNumber: 1166,
          findings: [{ id: "S1", path: PEER_PATH }],
        },
        captureRoles: ["countersign"],
        identitySuffix: /@secretariat$/,
      },
    ];

    for (const gate of cases) {
      const capture: RoleTurnRequest[] = [];
      const expectedPromptForGate = readableGateItem(gate.details);
      const result = await runAkRole(gate.argv, {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => gate.runId,
        io: captureIo().io,
        credentials: CREDENTIALS,
        roleTurnHost: parentGateHost({
          home,
          runId: gate.runId,
          parentRole: gate.parentRole,
          details: gate.details,
          capture,
          captureRoles: new Set(gate.captureRoles),
        }),
      });
      assert.equal(result.exitCode, 0, `${gate.parentRole} public entry must exit 0`);
      assert.equal(
        capture.length,
        gate.captureRoles.length,
        `${gate.parentRole} gate must summon ${gate.captureRoles.join(",")}`,
      );
      for (const request of capture) {
        const inspected = await inspectLiveRequest(request, packageRoot);
        assert.equal(inspected.prompt, expectedPromptForGate);
        assert.equal(inspected.identities.length, 1);
        assert.equal(inspected.identities[0]!.kind, AUDITED_RUN_IDENTITY_KIND);
        if (gate.expectedIdentity !== undefined) {
          assert.deepEqual(inspected.identities[0], {
            kind: AUDITED_RUN_IDENTITY_KIND,
            identity: gate.expectedIdentity,
          });
        } else {
          assert.match(inspected.identities[0]!.identity, gate.identitySuffix!);
        }
        assert.equal(inspected.pathMaterials.length, 0);
        seen.push({
          role: request.activation.role,
          identity: inspected.identities[0]!.identity,
          prompt: inspected.prompt,
        });
      }
    }

    assert.deepEqual(
      seen.map((row) => row.role).sort(),
      ["auditor", "countersign", "inspector", "notary"],
    );
    for (const row of seen) {
      assert.match(row.identity, /^[^/@]+@[^/@]+$/);
    }
  });
});

test("#1166 same parent re-submits: officer first utterance is the new ledger copy", async () => {
  await withTempRoot("ak-1166-resubmit-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await configureOfficerSeats(home, ["notary", "auditor"]);

    const first = {
      status: "converged" as const,
      ticketNumber: 1166,
      note: "first-copy",
      findings: [{ id: "A", path: PEER_PATH }],
    };
    const second = {
      status: "converged" as const,
      ticketNumber: 1166,
      note: "second-copy-after-resubmit",
      findings: [{ id: "B", path: PEER_PATH }],
    };
    assert.notEqual(readableGateItem(first), readableGateItem(second));

    const runId = "01a0116600007000800000000000r001";
    const notaryPrompts: string[] = [];
    let parentSeals = 0;

    const host = createMinimalHost(async (request) => {
      if (request.activation.role === "notary" || request.activation.role === "auditor") {
        if (request.activation.role === "notary") {
          notaryPrompts.push(request.continuation.prompt);
        }
        const details = notaryPrompts.length <= 1
          ? { status: "continue", violations: ["rewrite"], ticketNumber: 1166 }
          : { status: "converged", ticketNumber: 1166 };
        return roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: scriptedTerminatingToolSession({
            role: request.activation.role,
            toolName: request.activation.role === "notary"
              ? NOTARY_OUTPUT_TOOL_NAME
              : AUDITOR_OUTPUT_TOOL_NAME,
            details,
          }),
        }).executeTurn(request);
      }
      parentSeals += 1;
      const body = parentSeals === 1 ? first : second;
      const { sessionDirectory, sessionFile } =
        piDurablePrincipalAuthority.decode(request.principal);
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            toolName: JUDGE_OUTPUT_TOOL_NAME,
            isError: false,
            details: body,
          },
        })}\n`,
        "utf8",
      );
      await sealAcceptedSubmission({
        cwd: request.cwd,
        home,
        runId,
        runDirectory: request.runDirectory,
        role: "judge",
        details: body,
        toolCallId: `judge-resubmit-${parentSeals}`,
        ...(request.courtAttemptId === undefined
          ? {}
          : { courtAttemptId: request.courtAttemptId }),
      });
      return { code: 0, stderr: "", timedOut: false };
    });

    const firstIo = captureIo();
    const firstResult = await runAkRole(
      ["judge", "--model", "test/caller-seat:high", "--project", project, "round one"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => runId,
        io: firstIo.io,
        credentials: CREDENTIALS,
        roleTurnHost: host,
      },
    );
    assert.equal(firstResult.exitCode, 0, firstIo.stderr.join(""));
    assert.ok(notaryPrompts.length >= 1);
    assert.equal(notaryPrompts[0], readableGateItem(first));

    if (notaryPrompts.length < 2) {
      const resumeIo = captureIo();
      const resumed = await runAkRole(
        ["resume", "--model", "test/caller-seat:high", runId, "rewrite after bounce"],
        {
          packageRoot,
          home,
          cwd: project,
          io: resumeIo.io,
          credentials: CREDENTIALS,
          roleTurnHost: host,
        },
      );
      assert.equal(resumed.exitCode, 0, resumeIo.stderr.join(""));
    }

    assert.ok(notaryPrompts.length >= 2, "same parent must re-summon notary");
    assert.equal(notaryPrompts.at(-1), readableGateItem(second));
    assert.notEqual(notaryPrompts[0], notaryPrompts.at(-1));
  });
});

test("#1166 direct notary/auditor public entry: same identity; first utterance is ledger peer body", async () => {
  await withTempRoot("ak-1166-direct-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await configureOfficerSeats(home, ["notary", "auditor"]);
    const parentRun = await seedCanonicalSourceRun(home, project);
    const expectedIdentity = identityFromParent(parentRun);
    assert.equal(
      expectedIdentity,
      `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`,
    );
    const previous = {
      status: "converged",
      report: "ledger-peer-previous",
      path: "/peer/previous/path.md",
    };
    const current = {
      status: "converged",
      report: "ledger-peer-CURRENT",
      path: "/peer/current/path.md",
    };
    await sealAcceptedSubmission({
      cwd: project,
      home,
      runId: CANONICAL_SOURCE_RUN_ID,
      runDirectory: parentRun,
      role: "judge",
      details: previous,
      toolCallId: "direct-peer-previous",
    });
    // Latest ledger row may be correctable-rejection — still the current manuscript (J10).
    await recordNonSealedSubmission({
      cwd: project,
      home,
      runId: CANONICAL_SOURCE_RUN_ID,
      runDirectory: parentRun,
      role: "judge",
      details: current,
      toolCallId: "direct-peer-current",
      executeError: new WorkerUnfinishedReasonReminderError(),
    });
    const expectedPrompt = readableGateItem(current);

    for (const seat of [
      {
        role: "notary" as const,
        argv: ["notary", "--model", "test/caller-seat:high", "--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
        runId: "01a0116600007000800000000000dn01",
      },
      {
        role: "auditor" as const,
        argv: [
          "auditor",
          "--model",
          "test/caller-seat:high",
          "--subject",
          "judge",
          "--source-run",
          `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`,
        ],
        runId: "01a0116600007000800000000000da01",
      },
    ]) {
      let inspected: Awaited<ReturnType<typeof inspectLiveRequest>> | undefined;
      const result = await runAkRole(seat.argv, {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => seat.runId,
        io: captureIo().io,
        credentials: CREDENTIALS,
        roleTurnHost: createMinimalHost(async (request) => {
          assert.equal(request.activation.role, seat.role);
          // Observe startup while the turn is live, before ticket binding moves it.
          inspected = await inspectLiveRequest(request, packageRoot);
          return officerSealHost(seat.role).executeTurn(request);
        }),
      });
      assert.equal(result.exitCode, 0);
      assert.ok(inspected);
      assert.deepEqual(inspected.identities[0], {
        kind: AUDITED_RUN_IDENTITY_KIND,
        identity: expectedIdentity,
      });
      assert.equal(inspected.pathMaterials.length, 0);
      assert.equal(inspected.prompt, expectedPrompt);
      if (seat.role === "auditor") {
        assert.equal(inspected.toolNames?.includes(AUDITOR_DOSSIER_TOOL_NAME), false);
      }
    }
  });
});
