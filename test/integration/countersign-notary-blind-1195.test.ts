/**
 * #1195 — ticket-court blind review: countersign → notary does not preload the
 * countersign body into the notary first utterance. Identity still binds via
 * audited-run material. Non-countersign notary sources keep peer-body delivery.
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
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { savePublicCliConfig, setPersistentSeatConfig } from "../../src/public-cli/config.ts";
import { readableGateItem } from "../../src/readable-gate-item.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { formatRunLeaf, parseRunLeaf } from "../../src/role-run-placement.ts";
import { isRecord } from "../../src/unknown-value.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import {
  CANONICAL_SOURCE_RUN_ID,
  CANONICAL_SOURCE_ROLE,
  seedCanonicalSourceRun,
} from "../helpers/notary-fixtures.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import {
  createMinimalHost,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  withNestedTrueUnboundDiarist,
} from "../helpers/role-turn-host-fixture.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";

const CREDENTIALS = { "openai-codex": true, xai: true } as const;

async function configureSeats(home: string, roles: readonly string[]): Promise<void> {
  let config = { seats: {} };
  const seat = { provider: "test", model: "caller-seat", thinking: "high" } as const;
  for (const role of roles) {
    config = setPersistentSeatConfig(config, role as never, seat);
  }
  await savePublicCliConfig(config, home);
}

function auditedIdentities(materials: readonly unknown[]): AuditedRunIdentityMaterial[] {
  return materials.filter(
    (material): material is AuditedRunIdentityMaterial =>
      isRecord(material)
      && material.kind === AUDITED_RUN_IDENTITY_KIND
      && typeof material.identity === "string",
  );
}

async function inspectLiveRequest(
  request: RoleTurnRequest,
  packageRootPath: string,
): Promise<{ readonly prompt: string; readonly identities: AuditedRunIdentityMaterial[] }> {
  const socketPath = join(await mkdtemp(join(tmpdir(), "ak-1195-")), "mcp.sock");
  const prepared = await prepareRoleEnvelope({
    request,
    dependencies: createRoleRuntimeDependencies(packageRootPath),
    socketPath,
    sessionFile: piDurablePrincipalAuthority.decode(request.principal).sessionFile,
    principalAuthority: piDurablePrincipalAuthority,
  });
  try {
    return {
      prompt: prepared.prompt,
      identities: auditedIdentities(prepared.systemPrompt.materials),
    };
  } finally {
    await prepared.dispose?.();
  }
}

test("#1195 countersign gate → notary: first utterance omits countersign body; identity binds", async () => {
  await withTempRoot("ak-1195-blind-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await configureSeats(home, ["notary", "countersign", "diarist"]);

    const countersignBody = {
      status: "converged" as const,
      ticketNumber: 1195,
      note: "MUST-NOT-PRELOAD-INTO-NOTARY",
      clauses: [
        {
          clause: "blind input seam",
          ownerUuid: "67679846-d549-4b9f-993a-2f79820d62be",
          derivation: "Q2(a) not first look",
        },
      ],
    };
    const forbidden = readableGateItem(countersignBody);
    const parentRunId = "01a0119500007000800000000000c001";
    const capture: RoleTurnRequest[] = [];

    const inner = createMinimalHost(async (request) => {
      if (request.activation.role === "notary") {
        capture.push(request);
        return roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: scriptedTerminatingToolSession({
            role: "notary",
            toolName: NOTARY_OUTPUT_TOOL_NAME,
            details: {
              status: "converged",
              ticketNumber: 1195,
              clauses: [
                {
                  clause: "notary independent row",
                  ownerUuid: "67679846-d549-4b9f-993a-2f79820d62be",
                  derivation: "independent table",
                },
              ],
            },
          }),
        }).executeTurn(request);
      }
      const { sessionDirectory, sessionFile } =
        piDurablePrincipalAuthority.decode(request.principal);
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(sessionFile, "", "utf8");
      await sealAcceptedSubmission({
        cwd: request.cwd,
        home,
        runId: parentRunId,
        runDirectory: request.runDirectory,
        role: "countersign",
        details: countersignBody,
        toolCallId: "countersign-1195-seal",
        ...(request.courtAttemptId === undefined
          ? {}
          : { courtAttemptId: request.courtAttemptId }),
      });
      return { code: 0, stderr: "", timedOut: false };
    });
    const host = withNestedTrueUnboundDiarist(inner, { primaryRole: "countersign" });

    const { io, stderr } = captureIo();
    const result = await runAkRole(
      ["countersign", "--model", "test/caller-seat:high", "--project", project, "裁：本票五问。"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => parentRunId,
        io,
        credentials: CREDENTIALS,
        roleTurnHost: host,
      },
    );
    assert.equal(result.exitCode, 0, stderr.join(""));
    assert.equal(capture.length, 1, "notary must have been summoned once");
    const inspected = await inspectLiveRequest(capture[0]!, packageRoot);
    assert.equal(inspected.prompt.includes("MUST-NOT-PRELOAD-INTO-NOTARY"), false);
    assert.notEqual(inspected.prompt, forbidden);
    assert.equal(inspected.identities.length, 1);
    assert.equal(
      inspected.identities[0]!.identity,
      formatRunLeaf(parentRunId, "countersign"),
    );
  });
});

test("#1195 direct notary on judge source still receives ledger peer body", async () => {
  await withTempRoot("ak-1195-judge-peer-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await configureSeats(home, ["notary"]);
    const parentRun = await seedCanonicalSourceRun(home, project);
    const peer = {
      status: "converged",
      report: "judge-peer-still-delivered",
    };
    await sealAcceptedSubmission({
      cwd: project,
      home,
      runId: CANONICAL_SOURCE_RUN_ID,
      runDirectory: parentRun,
      role: CANONICAL_SOURCE_ROLE,
      details: peer,
      toolCallId: "judge-peer-1195",
    });
    const expected = readableGateItem(peer);
    let prompt: string | undefined;
    const result = await runAkRole(
      [
        "notary",
        "--model",
        "test/caller-seat:high",
        "--source-run",
        `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`,
      ],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "01a0119500007000800000000000n001",
        io: captureIo().io,
        credentials: CREDENTIALS,
        roleTurnHost: createMinimalHost(async (request) => {
          assert.equal(request.activation.role, "notary");
          prompt = (await inspectLiveRequest(request, packageRoot)).prompt;
          return roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: scriptedTerminatingToolSession({
              role: "notary",
              toolName: NOTARY_OUTPUT_TOOL_NAME,
              details: { status: "converged", ticketNumber: 1195, clauses: [] },
            }),
          }).executeTurn(request);
        }),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(prompt, expected);
    const leaf = parseRunLeaf(basename(parentRun));
    assert.ok(leaf);
    assert.equal(formatRunLeaf(leaf.runId, leaf.role), `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`);
  });
});
