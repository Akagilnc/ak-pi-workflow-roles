/**
 * #1192 contract two — direct `ak-role navigator` is a table lookup:
 * real public entry → real settlement, no host, no model, no session.
 * Oracles: typed terminal payloads and run records, never advice wording.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { NAVIGATOR_ADVICE_MAX_CHARS, NAVIGATOR_ROUTE_TABLE } from "../../src/navigator-route-table.ts";
import { issuePiDurablePrincipalCoordinates } from "../../src/pi/durable-principal.ts";
import { publicCliConfigPath } from "../../src/public-cli/config.ts";
import { readPageSync } from "../../src/run-dossier.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { captureIo, seedGitProject, withTempHome } from "../helpers/failure-settlement-kit.ts";
import { objectPayloads } from "../helpers/terminal-payload.ts";

const RUN_ID = "01a0navi00-0000-7000-8000-000000001192";

const hostMustNotRun = {
  async executeTurn(): Promise<never> {
    throw new Error("navigator lookup must not start a host session");
  },
};

async function callNavigator(
  argv: readonly string[],
  seats?: Record<string, { provider: string; model: string; host: string }>,
) {
  return withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    // Fixture home only — never the real seat table.
    if (seats !== undefined) {
      await mkdir(dirname(publicCliConfigPath(home)), { recursive: true });
      await writeFile(publicCliConfigPath(home), JSON.stringify({ seats }));
    }
    const { io } = captureIo();
    const result = await runAkRole(["navigator", "--project", project, ...argv], {
      home,
      packageRoot,
      cwd: project,
      io,
      createRunId: () => RUN_ID,
      roleTurnHost: hostMustNotRun,
    });
    const coords = issuePiDurablePrincipalCoordinates({ cwd: project, runId: RUN_ID, role: "navigator", home });
    const invocation = readPageSync(dirname(coords.sessionDirectory), "invocation");
    return { result, coords, invocation };
  });
}

function onlyPayload(result: Awaited<ReturnType<typeof callNavigator>>["result"]): Record<string, unknown> {
  assert.equal(result.exitCode, 0);
  assert.equal(result.terminal?.roleOutcome.kind, "accepted");
  const payloads = objectPayloads(result.terminal!.roleOutcome);
  assert.equal(payloads.length, 1);
  return payloads[0]!;
}

test("no argument: whole table, recorded as a lookup with no host session", async () => {
  const { result, coords } = await callNavigator([]);
  assert.deepEqual(onlyPayload(result), { byRole: NAVIGATOR_ROUTE_TABLE });
  assert.equal(existsSync(coords.sessionFile), false);
});

test("--role: only that seat's status rows", async () => {
  const { result } = await callNavigator(["--role", "coder"]);
  assert.deepEqual(onlyPayload(result), { byStatus: NAVIGATOR_ROUTE_TABLE.coder });
});

test("--role of a seat with no rows: empty rows, not an invented line", async () => {
  const { result } = await callNavigator(["--role", "collector"]);
  assert.deepEqual(onlyPayload(result), { byStatus: {} });
});

test("README instruction prose with --model/--host/--thinking: not parsed, not rejected, no model", async () => {
  const { result } = await callNavigator([
    "--model", "xai/grok-4.5", "--host", "codex", "--thinking", "high",
    "刚完成 coder apply 收敛，下一步？",
  ]);
  assert.deepEqual(onlyPayload(result), { byRole: NAVIGATOR_ROUTE_TABLE });
});

test("seat table whose model and host do not match (real shape xai/grok-4.5 on codex): still the table", async () => {
  const { result } = await callNavigator([], {
    navigator: { provider: "xai", model: "grok-4.5", host: "codex" },
  });
  assert.deepEqual(onlyPayload(result), { byRole: NAVIGATOR_ROUTE_TABLE });
});

test("--role outside the seat registry: structural usage error, nothing admitted", async () => {
  const { result } = await callNavigator(["--role", "nobody"]);
  assert.equal(result.exitCode, 2);
  assert.equal(result.terminal, undefined);
});

test("every table row is one short line", () => {
  for (const [role, rows] of Object.entries(NAVIGATOR_ROUTE_TABLE)) {
    for (const [status, advice] of Object.entries(rows)) {
      assert.ok(
        advice.trim() !== "" && Array.from(advice).length <= NAVIGATOR_ADVICE_MAX_CHARS,
        `${role}/${status}`,
      );
    }
  }
});

test("the run record names the lookup, not a real host", async () => {
  const { invocation } = await callNavigator([]);
  assert.equal(invocation?.host, "lookup");
});
