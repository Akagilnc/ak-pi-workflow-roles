/**
 * #319 Batch 4 (R1): thematic split from package-entrypoint.integration.test.ts.
 * Tool-execution observation face (no Navigator leak / no-role zero)
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
import { writeInstitutionalSeatTable, parentInheritedSeats } from "../helpers/institutional-seat-table.ts";

import {
  textOf,
  packageEntrypoint,
  readLatestSession,
  uniqueObservedNavigatorSession,
  parseToolExecutionObservations,
} from "../helpers/package-entrypoint-fixtures.ts";


test("installed composition emits admitted-role tool-execution JSONL on stderr for real bash output and never for Navigator prepare", async () => {
  assert.equal(TOOL_EXECUTION_UPDATE_HEARTBEAT, "output-driven");
  const manifest = await loadRawPackageManifest();
  await withActivationHome({ prefix: "ak-tool-observation-" }, async ({ home, agentDir }) => {
    const issueRoot = resolve(home, ".ak/work/issues/79");
    await mkdir(issueRoot, { recursive: true });
    const runDirectory = resolve(
      home,
      ".ak-roles",
      "books",
      basename(home),
      "runs",
      "judge-tool-observation",
    );
    const sessionDirectory = resolve(runDirectory, "session");
    await mkdir(sessionDirectory, { recursive: true });
    // #518 S3: direct-Pi judge activation reads seat selection from the run page.
    await writeInstitutionalSeatTable(
      runDirectory,
      parentInheritedSeats({ provider: "ak-tool-observation-bash", model: "faux-1", thinking: "off" }),
    );
    await writeFile(resolve(issueRoot, "authority.md"), "owner authority for tool observation\n", "utf8");
    await writeFile(
      resolve(agentDir, "navigator-model.json"),
      JSON.stringify({ model: "ak-tool-observation-bash/faux-1" }),
      "utf8",
    );
    const result = await runPiSubprocess([
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--session-dir", sessionDirectory,
      "-e", packageEntrypoint(manifest),
      "-e", resolve(packageRoot, "test/fixtures/tool-observation-bash-provider.ts"),
      "--ak-role", "judge",
      "--provider", "ak-tool-observation-bash",
      "--model", "faux-1",
      "--mode", "json",
      "Exercise bash observation.",
    ], {
      cwd: issueRoot,
      timeoutMs: 45_000,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
      },
    });
    assert.equal(result.localTimeout, false, `tool observation subprocess timed out: ${result.stderr}`);
    assert.equal(result.code, 0, `tool observation subprocess failed: ${result.stderr}\n${result.stdout}`);
    assert.equal(result.stdout.includes('"event":"tool_execution_'), false, "tool observation must never write JSONL onto stdout");

    const observations = parseToolExecutionObservations(result.stderr);
    assert.ok(observations.length >= 2, `expected start/end observation records, got ${JSON.stringify(observations)}`);
    for (const record of observations) {
      assert.equal(record.role, "judge");
      assert.notEqual(record.toolName, NAVIGATOR_PREPARE_TOOL_NAME, "Navigator prepare must not be attributed to the outer role");
    }

    const bashRecords = observations.filter((record) => record.toolCallId === "obs-bash-1" || record.toolName === "bash");
    assert.ok(bashRecords.some((record) => record.event === "tool_execution_start"));
    assert.ok(bashRecords.some((record) => record.event === "tool_execution_end" && record.isError === false));
    const bashUpdates = bashRecords.filter((record) => record.event === "tool_execution_update");
    assert.ok(
      bashUpdates.length >= 1,
      `non-empty bash child output must produce at least one throttled update heartbeat after skipping the empty entry callback; got ${JSON.stringify(bashRecords)}`,
    );

    const roleEntries = await readLatestSession(sessionDirectory);
    const attendance = roleEntries.find(
      (entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance",
    ) as { details?: { subjectKey?: string } } | undefined;
    const subjectKey = attendance?.details?.subjectKey;
    assert.equal(typeof subjectKey, "string", "tool-observation role session must publish subjectKey");
    const navigatorEntries = (await uniqueObservedNavigatorSession(home, subjectKey!, issueRoot)).entries;
    const navigatorPrepare = navigatorEntries.find(
      (entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === NAVIGATOR_PREPARE_TOOL_NAME,
    );
    assert.ok(navigatorPrepare, "Navigator private session must still run prepare");
    assert.equal(
      observations.some((record) => record.toolName === NAVIGATOR_PREPARE_TOOL_NAME),
      false,
      "private Navigator session tool calls must not emit on the outer observation face",
    );

    const bashResult = roleEntries.find(
      (entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === "obs-bash-1",
    );
    assert.ok(bashResult?.type === "message" && bashResult.message?.role === "toolResult");
    assert.equal(bashResult.message.isError, false);
    assert.match(textOf(bashResult.message as never), /chunk-one/);
    assert.match(textOf(bashResult.message as never), /chunk-two/);
  });
});

test("installed composition without --ak-role emits no tool-execution observation records", async () => {
  const manifest = await loadRawPackageManifest();
  // Role-less observation: no activation substrate (no git seed, no durable session).
  await withHermeticHome({ prefix: "ak-tool-observation-no-role-" }, async ({ home, agentDir }) => {
    const cwd = resolve(home, "workspace");
    await mkdir(cwd, { recursive: true });
    const result = await runPiSubprocess([
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session",
      "-e", packageEntrypoint(manifest),
      "-e", resolve(packageRoot, "test/fixtures/tool-observation-bash-provider.ts"),
      "--provider", "ak-tool-observation-bash",
      "--model", "faux-1",
      "--mode", "json",
      "-p",
      "No role activation.",
    ], {
      cwd,
      timeoutMs: 30_000,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
      },
    });
    assert.equal(result.localTimeout, false, `no-role subprocess timed out: ${result.stderr}`);
    assert.deepEqual(parseToolExecutionObservations(result.stderr), []);
  });
});
