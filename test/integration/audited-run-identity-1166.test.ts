/**
 * #1166 — four audit seats share audited-run identity `<runId>@<席>` in startup
 * materials; first utterance stays the peer submission bytes from this-round ledger;
 * package adds no audited-run directory path. Navigator prompt stays caller bytes.
 *
 * Seam (票面): public `ak-role` + in-repo fake host. Observe RoleTurnRequest that
 * gate / direct entry actually built; prepareRoleEnvelope only reads that request
 * (never invents continuation.prompt).
 */
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  AUDITED_RUN_IDENTITY_KIND,
  type AuditedRunIdentityMaterial,
} from "../../src/audited-run-identity.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { DIARIST_OUTPUT_TOOL_NAME } from "../../src/diarist-contracts.ts";
import type {
  RoleTurnHost,
  RoleTurnRequest,
} from "../../src/host-contracts.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import { createNavigatorAttendance } from "../../src/navigator-attendance.ts";
import {
  persistNavigatorWorkBase,
  navigatorWorkContextFile,
  readNavigatorWorkBase,
} from "../../src/navigator-work-base.ts";
import { createNativeNavigatorSessionFactory } from "../../src/navigator-public-session.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole, type NamedRoleTurnHostAdapter } from "../../src/public-cli/cli.ts";
import { savePublicCliConfig, setPersistentSeatConfig } from "../../src/public-cli/config.ts";
import { readableGateItem } from "../../src/readable-gate-item.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { formatRunLeaf, parseRunLeaf } from "../../src/role-run-placement.ts";
import { isRecord } from "../../src/unknown-value.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import {
  CANONICAL_SOURCE_RUN_ID,
  CANONICAL_SOURCE_ROLE,
  seedCanonicalSourceRun,
} from "../helpers/notary-fixtures.ts";
import { packageRoot, seedGitRepository } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { readCurrentSection } from "../helpers/run-dossier-fixture.ts";
import {
  argvFlagValue,
  createMinimalHost,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  type LegacyFauxPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";

const AUDITOR_DOSSIER_TOOL_NAME = "ak_get_run_dossier";
const PEER_PATH = "/caller/already/had/this/path.md";
const CREDENTIALS = { "openai-codex": true, xai: true } as const;

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

function adapter(name: string, host: RoleTurnHost): NamedRoleTurnHostAdapter {
  return { name, create: () => ({ ok: true as const, host }) };
}

async function listMcpToolNames(socketPath: string, token: string): Promise<string[]> {
  const result = await new Promise<{ tools?: Array<{ name?: string }> }>((resolve, reject) => {
    const conn = createConnection(socketPath);
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("error", reject);
    conn.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, end)) as {
          result?: { tools?: Array<{ name?: string }> };
          error?: unknown;
        };
        if (message.error !== undefined) {
          reject(new Error(JSON.stringify(message.error)));
          return;
        }
        resolve(message.result ?? {});
      } catch (error) {
        reject(error);
      } finally {
        conn.end();
      }
    });
    conn.write(`${JSON.stringify({ id: 1, token, method: "tools/list" })}\n`);
  });
  return (result.tools ?? [])
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string");
}

function mcpRelayToken(prepared: {
  readonly mcpServers: readonly Readonly<Record<string, unknown>>[];
}): string {
  const server = prepared.mcpServers[0];
  assert.ok(server !== undefined, "prepared turn must expose MCP server");
  const env = server.env;
  assert.ok(Array.isArray(env), "mcp server env must be an array");
  for (const entry of env) {
    if (
      isRecord(entry)
      && entry.name === "AK_ACP_MCP_TOKEN"
      && typeof entry.value === "string"
    ) {
      return entry.value;
    }
  }
  assert.fail("AK_ACP_MCP_TOKEN missing from prepared MCP env");
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
  // Auditor soul + identity resolve from env during envelope activate (same as
  // instruction-seat-run withAuditorSoulEnv). Re-arm from admitted page when present.
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

function officerSealHost(
  role: "notary" | "auditor" | "inspector" | "countersign",
): RoleTurnHost {
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
      details: { status: "converged" },
    }),
  });
}

test("#1166 public gate: four seats share identity; first utterance is ledger submission", async () => {
  await withTempRoot("ak-1166-gate-four-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await configureOfficerSeats(home, [
      "notary", "auditor", "inspector", "countersign", "diarist", "judge",
    ]);

    const peerBody = {
      status: "converged" as const,
      findings: [{ id: "N1", path: PEER_PATH }],
      reason: "peer body with a path must pass through unchanged",
    };
    const expectedPrompt = readableGateItem(peerBody);
    const seen: Array<{ role: string; identity: string; prompt: string }> = [];

    // —— 大理寺 → 符宝郎 + 审刑院 ——
    const judgeRunId = "01a0116600007000800000000000j001";
    const judgeOfficers: RoleTurnRequest[] = [];
    const judgeResult = await runAkRole(
      ["judge", "--model", "test/caller-seat:high", "--project", project, "adjudicate"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => judgeRunId,
        io: captureIo().io,
        credentials: CREDENTIALS,
        roleTurnHost: createMinimalHost(async (request) => {
          if (request.activation.role === "notary" || request.activation.role === "auditor") {
            judgeOfficers.push(request);
            return officerSealHost(request.activation.role).executeTurn(request);
          }
          const { sessionDirectory, sessionFile } =
            piDurablePrincipalAuthority.decode(request.principal);
          await mkdir(sessionDirectory, { recursive: true });
          await writeFile(sessionFile, "", "utf8");
          await sealAcceptedSubmission({
            cwd: request.cwd,
            home,
            runId: judgeRunId,
            runDirectory: request.runDirectory,
            role: "judge",
            details: peerBody,
            toolCallId: "judge-1166",
            ...(request.courtAttemptId === undefined
              ? {}
              : { courtAttemptId: request.courtAttemptId }),
          });
          return { code: 0, stderr: "", timedOut: false };
        }),
      },
    );
    assert.equal(judgeResult.exitCode, 0);
    assert.equal(judgeOfficers.length, 2, "gate must summon notary and auditor");
    const expectedIdentity = `${judgeRunId}@judge`;
    for (const request of judgeOfficers) {
      const inspected = await inspectLiveRequest(request, packageRoot);
      assert.equal(inspected.prompt, expectedPrompt);
      assert.equal(inspected.identities.length, 1);
      assert.deepEqual(inspected.identities[0], {
        kind: AUDITED_RUN_IDENTITY_KIND,
        identity: expectedIdentity,
      });
      assert.equal(inspected.pathMaterials.length, 0);
      seen.push({
        role: request.activation.role,
        identity: inspected.identities[0]!.identity,
        prompt: inspected.prompt,
      });
    }

    // —— 修内司 → 台院 ——
    const coderRunId = "01a0116600007000800000000000c001";
    const coderOfficers: RoleTurnRequest[] = [];
    const coderBody = {
      status: "completed" as const,
      report: "done",
      findings: [{ id: "C1", path: PEER_PATH }],
    };
    const coderPrompt = readableGateItem(coderBody);
    const coderResult = await runAkRole(
      ["coder", "--model", "test/caller-seat:high", "--project", project, "implement"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => coderRunId,
        io: captureIo().io,
        credentials: CREDENTIALS,
        roleTurnHost: createMinimalHost(async (request) => {
          if (request.activation.role === "inspector") {
            coderOfficers.push(request);
            return officerSealHost("inspector").executeTurn(request);
          }
          const { sessionDirectory, sessionFile } =
            piDurablePrincipalAuthority.decode(request.principal);
          await mkdir(sessionDirectory, { recursive: true });
          await writeFile(sessionFile, "", "utf8");
          await sealAcceptedSubmission({
            cwd: request.cwd,
            home,
            runId: coderRunId,
            runDirectory: request.runDirectory,
            role: "coder",
            details: coderBody,
            toolCallId: "coder-1166",
            ...(request.courtAttemptId === undefined
              ? {}
              : { courtAttemptId: request.courtAttemptId }),
          });
          return { code: 0, stderr: "", timedOut: false };
        }),
      },
    );
    assert.equal(coderResult.exitCode, 0);
    assert.equal(coderOfficers.length, 1, "gate must summon inspector");
    {
      const request = coderOfficers[0]!;
      const inspected = await inspectLiveRequest(request, packageRoot);
      assert.equal(inspected.prompt, coderPrompt);
      assert.deepEqual(inspected.identities[0], {
        kind: AUDITED_RUN_IDENTITY_KIND,
        identity: `${coderRunId}@coder`,
      });
      assert.equal(inspected.pathMaterials.length, 0);
      seen.push({
        role: "inspector",
        identity: inspected.identities[0]!.identity,
        prompt: inspected.prompt,
      });
    }

    // —— 中书省 → 给事中（公开入口 + 仓内假宿主，复用 secretariat 真闸接缝） ——
    const secretariatBody = {
      secretariatStatus: "converged" as const,
      ticketNumber: 1166,
      findings: [{ id: "S1", path: PEER_PATH }],
    };
    const secretariatPrompt = readableGateItem(secretariatBody);
    const countersignRequests: RoleTurnRequest[] = [];
    const gateCalls: Array<{ kind: string }> = [];
    const host = secretariatGateHost({
      home,
      countersignRequests,
      gateCalls,
      secretariatDetails: secretariatBody,
    });
    const secResult = await runAkRole(
      [
        "secretariat",
        "--model",
        "test/caller-seat:high",
        "--project",
        project,
        "整理票面",
      ],
      {
        home,
        packageRoot,
        cwd: project,
        io: captureIo().io,
        createRunId: () => "01a0116600007000800000000000s001",
        roleTurnHost: host,
        hostAdapters: [adapter("pi", host)],
      },
    );
    assert.equal(secResult.exitCode, 0);
    assert.ok(countersignRequests.length >= 1, "gate must summon countersign");
    assert.ok(gateCalls.some((c) => c.kind === "secretariat_verdict"));
    {
      const request = countersignRequests[0]!;
      const inspected = await inspectLiveRequest(request, packageRoot);
      assert.equal(inspected.prompt, secretariatPrompt);
      assert.equal(inspected.identities.length, 1);
      assert.equal(inspected.identities[0]!.kind, AUDITED_RUN_IDENTITY_KIND);
      assert.match(inspected.identities[0]!.identity, /@secretariat$/);
      assert.equal(inspected.pathMaterials.length, 0);
      seen.push({
        role: "countersign",
        identity: inspected.identities[0]!.identity,
        prompt: inspected.prompt,
      });
    }

    assert.deepEqual(
      seen.map((row) => row.role).sort(),
      ["auditor", "countersign", "inspector", "notary"],
    );
    // Four seats: identity form is always runId@role (same shape).
    for (const row of seen) {
      assert.match(row.identity, /^[^/@]+@[^/@]+$/);
      assert.equal(row.identity.includes("/"), false);
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
      note: "first-copy",
      findings: [{ id: "A", path: PEER_PATH }],
    };
    const second = {
      status: "converged" as const,
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
        // First round: bounce so parent re-submits; second: pass.
        const details = notaryPrompts.length <= 1
          ? { status: "continue", violations: ["rewrite"] }
          : { status: "converged" };
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

    // First seal → bounce → package resumes parent for rewrite → second seal.
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
      // Explicit resume when auto-rework did not already drive a second parent seal.
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

test("#1166 direct notary/auditor public entry: same identity material, no path", async () => {
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
      let captured: RoleTurnRequest | undefined;
      const result = await runAkRole(seat.argv, {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => seat.runId,
        io: captureIo().io,
        credentials: CREDENTIALS,
        roleTurnHost: createMinimalHost(async (request) => {
          assert.equal(request.activation.role, seat.role);
          captured = request;
          return officerSealHost(seat.role).executeTurn(request);
        }),
      });
      assert.equal(result.exitCode, 0);
      assert.ok(captured);
      const inspected = await inspectLiveRequest(captured, packageRoot);
      assert.deepEqual(inspected.identities[0], {
        kind: AUDITED_RUN_IDENTITY_KIND,
        identity: expectedIdentity,
      });
      assert.equal(inspected.pathMaterials.length, 0);
      // Direct entry: package must not author dispatch prose into the officer prompt.
      assert.equal(inspected.prompt.includes("卷宗指针"), false);
      if (seat.role === "auditor") {
        assert.equal(inspected.toolNames?.includes(AUDITOR_DOSSIER_TOOL_NAME), false);
      }
    }
  });
});

test("#1166 navigator public summon: caller prompt bytes; work base structured; no path inject", async () => {
  await withTempRoot("ak-1166-navigator-", async (root) => {
    seedGitRepository(root);
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "test", model: "caller-seat" } } })}\n`,
    );

    const subject = "caller-subject-bytes";
    const authority = "caller-authority-bytes";
    const subjectKey = `${join(root, ".ak/work")}#ad-hoc`;
    const parentRun = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "parent@coder");
    await mkdir(join(parentRun, "session"), { recursive: true });

    const nest = join(root, ".ak-roles", "books", "probe", "navigator", "a".repeat(32));
    await mkdir(nest, { recursive: true });
    const workContextPath = await persistNavigatorWorkBase(nest, { subject, authority });
    assert.ok(workContextPath !== undefined);
    assert.equal(workContextPath, navigatorWorkContextFile(nest));
    assert.deepEqual(await readNavigatorWorkBase(workContextPath!), { subject, authority });

    const summons: string[] = [];
    const nav = createNavigatorAttendance({
      context: {
        cwd: root,
        home: root,
        runDirectory: parentRun,
      } as never,
      role: "coder",
      phase: "apply",
      subjectKey,
      subject,
      authority,
      createSession: createNativeNavigatorSessionFactory({
        summonPublicRole: async (options) => {
          summons.push(options.argv[0] ?? "");
          return {
            exitCode: 0,
            runDirectory: join(
              root,
              ".ak-roles",
              "books",
              "probe",
              "unbound",
              "runs",
              "01a01166nav000700080000000001@navigator",
            ),
            terminal: {
              roleOutcome: { kind: "accepted", payloads: [{ prose: "下一步" }] },
            },
          } as never;
        },
        hostRunResumable: async () => false,
      }),
      onEvent: () => {},
    });

    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.ok(summons.length >= 1);
    const delivered = summons[0]!;
    for (const argv of summons) {
      assert.equal(argv.includes(authority), false);
      assert.equal(argv.includes(subject), false);
      assert.equal(argv.includes("workContextPath"), false);
      assert.equal(argv.includes(workContextPath!), false);
      const fed = JSON.parse(argv) as { workContextPath?: string; subjectKey?: string };
      assert.equal(fed.subjectKey, subjectKey);
      assert.equal(fed.workContextPath, undefined);
    }

    const runDirectory = join(
      root,
      ".ak-roles",
      "books",
      "probe",
      "unbound",
      "runs",
      "01a01166navprep0700080000000001@navigator",
    );
    await mkdir(join(runDirectory, "session"), { recursive: true });
    const sessionFile = join(nest, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "nav",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: root,
      })}\n`,
      "utf8",
    );
    const prepared = await prepareRoleEnvelope({
      request: {
        principal: fixturePrincipal(nest, sessionFile),
        activation: { role: "navigator" },
        methods: [],
        continuation: { kind: "initial", prompt: delivered },
        cwd: root,
        home: root,
        agentDir: join(root, "agent"),
        runDirectory,
        stationChild: true,
      },
      dependencies: createRoleRuntimeDependencies(packageRoot),
      socketPath: join(root, "navigator-1166.sock"),
      sessionFile,
    });
    try {
      assert.equal(prepared.prompt, delivered);
      assert.equal(prepared.prompt.includes("workContextPath"), false);
      assert.equal(prepared.prompt.includes(workContextPath!), false);
      const expectedBlock =
        `<work_subject>\n${subject}\n</work_subject>\n\n`
        + `<controlling_authority>\n${authority}\n</controlling_authority>`;
      assert.equal(prepared.systemPrompt.body.includes(expectedBlock), true);
      assert.equal(packageAuditedPathMaterials(prepared.systemPrompt.materials).length, 0);
    } finally {
      await prepared.dispose?.();
    }
    await nav.dispose();
  });
});

/**
 * Slim secretariat public-entry host: real envelope + nested countersign capture.
 * Same seam as public-cli-secretariat-run (prepareRoleEnvelope + ingestStructuredOutput);
 * not a parallel gate.
 */
function secretariatGateHost(input: {
  readonly home: string;
  readonly countersignRequests: RoleTurnRequest[];
  readonly gateCalls: Array<{ kind: string }>;
  readonly secretariatDetails: Record<string, unknown>;
}): RoleTurnHost {
  const parentDiaristHost = roleTurnHostFromLegacyPiRunner({
    packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner: async (args, options) => {
      const role = argvFlagValue(args, "--ak-role");
      if (role === "diarist") {
        return scriptedTerminatingToolSession({
          role: "diarist",
          toolName: DIARIST_OUTPUT_TOOL_NAME,
          details: {
            status: "completed",
            ticketNumber: 1166,
            sessions: [] as const,
          },
        })(args, options);
      }
      throw new Error(`unexpected diarist-host role: ${role}`);
    },
  });

  const nestPi: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      input.gateCalls.push({ kind: "countersign_verdict" });
      return scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "converged" },
      })(args, options);
    }
    if (role === "countersign") {
      return scriptedTerminatingToolSession({
        role: "countersign",
        toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
        details: { status: "converged", note: "署" },
      })(args, options);
    }
    throw new Error(`unexpected nested role: ${role}`);
  };
  const nested = roleTurnHostFromLegacyPiRunner({
    packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner: nestPi,
  });
  const nestedTracked: RoleTurnHost = {
    executeTurn(request) {
      if (request.activation.role === "countersign") {
        input.countersignRequests.push(request);
        input.gateCalls.push({ kind: "secretariat_verdict" });
      }
      return nested.executeTurn(request);
    },
  };
  const nestAdapters = [adapter("pi", nestedTracked)];

  return {
    async executeTurn(request: RoleTurnRequest) {
      if (request.activation.role === "diarist") {
        return parentDiaristHost.executeTurn(request);
      }
      if (request.activation.role !== "secretariat") {
        return nestedTracked.executeTurn(request);
      }
      const socketDir = await mkdtemp(join(tmpdir(), "ak-1166-sec-"));
      const coords = piDurablePrincipalAuthority.decode(request.principal);
      const prepared = await prepareRoleEnvelope({
        request: { ...request, host: "codex" },
        dependencies: {
          ...createRoleRuntimeDependencies(packageRoot),
          hostAdapters: nestAdapters,
        },
        socketPath: join(socketDir, "mcp.sock"),
        listTerminatingToolOnMcp: false,
        sessionFile: coords.sessionFile,
      });
      try {
        await prepared.ingestStructuredOutput(input.secretariatDetails);
        await prepared.closeRound();
        return { code: 0, stderr: "", timedOut: false };
      } finally {
        await prepared.dispose?.();
      }
    },
  };
}
