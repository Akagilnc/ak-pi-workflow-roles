/**
 * #1166 — four audit seats share audited-run identity `<runId>@<席>` in startup
 * materials; first utterance stays the peer submission bytes; package adds no
 * directory path about the audited run. Navigator prompt stays caller bytes.
 *
 * Seam: prepareRoleEnvelope (shared startup-material assembly used by ak-role
 * hosts) + public activation flags / admitted source binding.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  AUDITED_RUN_IDENTITY_KIND,
  type AuditedRunIdentityMaterial,
} from "../../src/audited-run-identity.ts";
import type { RoleTurnActivation } from "../../src/host-contracts.ts";

const AUDITOR_DOSSIER_TOOL_NAME = "ak_get_run_dossier";
import {
  persistNavigatorWorkBase,
  navigatorWorkContextFile,
} from "../../src/navigator-work-base.ts";
import { renderSystemPromptOverride } from "../../src/prepared-role-turn.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { formatRunLeaf, parseRunLeaf } from "../../src/role-run-placement.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import {
  CANONICAL_SOURCE_ROLE,
  CANONICAL_SOURCE_RUN_ID,
  seedCanonicalSourceRun,
} from "../helpers/notary-fixtures.ts";
import { packageRoot, seedGitRepository } from "../helpers/pi-test-harness.ts";
import { seedCurrentSection } from "../helpers/run-dossier-fixture.ts";

const PEER_PATH = "/caller/already/had/this/path.md";
const OFFICER_PAYLOAD = {
  status: "continue",
  findings: [{ id: "N1", path: PEER_PATH }],
  reason: "peer body with a path must pass through unchanged",
} as const;

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
      typeof material === "object"
      && material !== null
      && (material as { kind?: unknown }).kind === AUDITED_RUN_IDENTITY_KIND
      && typeof (material as { identity?: unknown }).identity === "string",
  );
}

function packageAddedAuditedPaths(materials: readonly unknown[], parentRun: string): unknown[] {
  return materials.filter((material) => {
    if (typeof material !== "object" || material === null) return false;
    const text = JSON.stringify(material);
    return text.includes(parentRun) || text.includes("sourceRunPath") || text.includes("runDirectory");
  });
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
      typeof entry === "object"
      && entry !== null
      && (entry as { name?: unknown }).name === "AK_ACP_MCP_TOKEN"
      && typeof (entry as { value?: unknown }).value === "string"
    ) {
      return (entry as { value: string }).value;
    }
  }
  assert.fail("AK_ACP_MCP_TOKEN missing from prepared MCP env");
}

test("#1166 four audit seats: same identity material, verbatim first utterance, no path", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-1166-identity-"));
  const parentRun = await seedCanonicalSourceRun(home, packageRoot);
  const expectedIdentity = identityFromParent(parentRun);
  assert.equal(
    expectedIdentity,
    `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`,
  );
  const submission = JSON.stringify(OFFICER_PAYLOAD);
  const seats: ReadonlyArray<{
    readonly activation: RoleTurnActivation;
    readonly seedAdmittedSource?: boolean;
    readonly auditorEnv?: boolean;
  }> = [
    { activation: { role: "notary", sourceRun: parentRun } },
    { activation: { role: "inspector", sourceRun: parentRun } },
    { activation: { role: "auditor" }, auditorEnv: true },
    { activation: { role: "countersign" }, seedAdmittedSource: true },
  ];

  try {
    const seenIdentities: string[] = [];
    for (const seat of seats) {
      const runDirectory = join(home, seat.activation.role, "run");
      await mkdir(join(runDirectory, "session"), { recursive: true });
      if (seat.seedAdmittedSource) {
        seedCurrentSection(runDirectory, "admitted", {
          role: seat.activation.role,
          sourceRunPath: parentRun,
        });
      }
      const priorSubject = process.env.AK_ROLE_AUDITOR_SUBJECT;
      const priorSource = process.env.AK_ROLE_AUDITOR_SOURCE_RUN;
      if (seat.auditorEnv) {
        process.env.AK_ROLE_AUDITOR_SUBJECT = "judge";
        process.env.AK_ROLE_AUDITOR_SOURCE_RUN = parentRun;
      }
      let prepared;
      try {
        prepared = await prepareRoleEnvelope({
          request: {
            principal: fixturePrincipal(join(runDirectory, "session")),
            activation: seat.activation,
            methods: [],
            continuation: { kind: "initial", prompt: submission },
            cwd: packageRoot,
            home,
            agentDir: join(runDirectory, "agent"),
            runDirectory,
            stationChild: true,
          },
          dependencies: createRoleRuntimeDependencies(packageRoot),
          socketPath: join(home, `${seat.activation.role}.sock`),
        });
      } finally {
        if (seat.auditorEnv) {
          if (priorSubject === undefined) delete process.env.AK_ROLE_AUDITOR_SUBJECT;
          else process.env.AK_ROLE_AUDITOR_SUBJECT = priorSubject;
          if (priorSource === undefined) delete process.env.AK_ROLE_AUDITOR_SOURCE_RUN;
          else process.env.AK_ROLE_AUDITOR_SOURCE_RUN = priorSource;
        }
      }
      try {
        assert.equal(
          prepared.prompt,
          submission,
          `${seat.activation.role} first utterance must be peer submission bytes`,
        );
        assert.equal(
          prepared.prompt.includes(PEER_PATH),
          true,
          "path inside peer submission must still pass through",
        );

        const identities = auditedIdentityMaterials(prepared.systemPrompt.materials);
        assert.equal(
          identities.length,
          1,
          `${seat.activation.role} must carry exactly one audited-run identity material`,
        );
        assert.equal(identities[0]!.identity, expectedIdentity);
        seenIdentities.push(identities[0]!.identity);

        assert.equal(
          packageAddedAuditedPaths(prepared.systemPrompt.materials, parentRun).length,
          0,
          `${seat.activation.role} startup materials must not carry audited-run directory paths`,
        );
      } finally {
        await prepared.dispose?.();
      }
    }
    assert.deepEqual(
      seenIdentities,
      [expectedIdentity, expectedIdentity, expectedIdentity, expectedIdentity],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("#1166 auditor tools omit the path-returning dossier tool", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-1166-auditor-tool-"));
  const parentRun = await seedCanonicalSourceRun(home, packageRoot);
  const runDirectory = join(home, "auditor", "run");
  await mkdir(join(runDirectory, "session"), { recursive: true });
  const socketPath = join(home, "auditor.sock");
  const priorSubject = process.env.AK_ROLE_AUDITOR_SUBJECT;
  const priorSource = process.env.AK_ROLE_AUDITOR_SOURCE_RUN;
  process.env.AK_ROLE_AUDITOR_SUBJECT = "judge";
  process.env.AK_ROLE_AUDITOR_SOURCE_RUN = parentRun;
  try {
    const prepared = await prepareRoleEnvelope({
      request: {
        principal: fixturePrincipal(join(runDirectory, "session")),
        activation: { role: "auditor" },
        methods: [],
        continuation: { kind: "initial", prompt: JSON.stringify(OFFICER_PAYLOAD) },
        cwd: packageRoot,
        home,
        agentDir: join(runDirectory, "agent"),
        runDirectory,
        stationChild: true,
      },
      dependencies: createRoleRuntimeDependencies(packageRoot),
      socketPath,
    });
    try {
      const tools = await listMcpToolNames(socketPath, mcpRelayToken(prepared));
      assert.equal(tools.includes(AUDITOR_DOSSIER_TOOL_NAME), false);
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    if (priorSubject === undefined) delete process.env.AK_ROLE_AUDITOR_SUBJECT;
    else process.env.AK_ROLE_AUDITOR_SUBJECT = priorSubject;
    if (priorSource === undefined) delete process.env.AK_ROLE_AUDITOR_SOURCE_RUN;
    else process.env.AK_ROLE_AUDITOR_SOURCE_RUN = priorSource;
    await rm(home, { recursive: true, force: true });
  }
});

test("#1166 navigator prompt stays caller bytes; work subject stays in startup materials", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-1166-navigator-"));
  seedGitRepository(home);
  const nest = join(home, ".ak-roles", "books", "probe", "navigator", "a".repeat(32));
  await mkdir(nest, { recursive: true });
  const subject = "caller-subject-bytes";
  const authority = "caller-authority-bytes";
  const workContextPath = await persistNavigatorWorkBase(nest, { subject, authority });
  assert.ok(workContextPath !== undefined);
  assert.equal(workContextPath, navigatorWorkContextFile(nest));

  const callerPrompt = JSON.stringify({
    kind: "settlement",
    subjectKey: "probe#ad-hoc",
    status: "completed",
  });
  const runDirectory = join(home, "navigator-run");
  await mkdir(runDirectory, { recursive: true });
  const sessionFile = join(nest, "session.jsonl");

  const prepared = await prepareRoleEnvelope({
    request: {
      principal: fixturePrincipal(nest, sessionFile),
      activation: { role: "navigator" },
      methods: [],
      continuation: { kind: "initial", prompt: callerPrompt },
      cwd: home,
      home,
      agentDir: join(home, "agent"),
      runDirectory,
      stationChild: true,
    },
    dependencies: createRoleRuntimeDependencies(packageRoot),
    socketPath: join(home, "navigator.sock"),
    sessionFile,
  });
  try {
    assert.equal(prepared.prompt, callerPrompt);
    assert.equal(prepared.prompt.includes("workContextPath"), false);
    assert.equal(prepared.prompt.includes(workContextPath!), false);
    const modelInput = renderSystemPromptOverride(prepared.systemPrompt);
    assert.equal(modelInput.includes(subject), true);
    assert.equal(modelInput.includes(authority), true);
  } finally {
    await prepared.dispose?.();
    await rm(home, { recursive: true, force: true });
  }
});
