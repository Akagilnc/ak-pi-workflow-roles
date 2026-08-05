import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { COMPLIANCE_RESPONSE_ENTRY_TYPE } from "../../src/compliance-transport.ts";
import { validateRecordedDoctorOutput } from "../../src/doctor-contracts.ts";
import {
  ACCEPTED_ACTIVATION_EVENT,
  activationWaitingLedgerPath,
  type AcceptedActivationFact,
} from "../../src/role-runtime.ts";
import {
  packageRoot,
  runPiSubprocess,
  withColdInstalledPackage,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";

test("fresh Pi process loads the installed Doctor extension and completes one audited output", async () => {
  await withHermeticHome(
    { prefix: "ak-doctor-fresh-process-" },
    async ({ home, agentDir }) => {
      await withColdInstalledPackage(home, async ({ fixture, installedRoot }) => {
        const runsPath = resolve(fixture, ".ak-roles/books/demo-book/issues/58/runs");
        await mkdir(resolve(runsPath, "case/session"), { recursive: true });
        await writeFile(
          resolve(runsPath, "case/session/retained.jsonl"),
          `${JSON.stringify({
            type: "session",
            version: 3,
            id: "doctor-case",
            timestamp: "2026-08-03T00:00:00.000Z",
            cwd: fixture,
          })}\n`,
        );

        const installedEntrypoint = resolve(
          installedRoot,
          "extensions/role-runtime.ts",
        );
        // Durable role session under the machine ledger book (ADR 0048); not under the consumer fixture.
        const bookKey = "consumer"; // cloneSharedColdInstall dest basename under home/consumer
        const sessionDir = resolve(
          home,
          ".ak-roles",
          "books",
          bookKey,
          "runs",
          "doctor-fresh",
          "session",
        );
        // Production activation requires a git cwd (ADR 0048); seed the consumer fixture.
        // With a git root present, Doctor case identity becomes repo-relative (stableRunsIdentity).
        execFileSync("git", ["init", "-b", "main"], { cwd: fixture, stdio: "ignore" });
        const caseIdentityPath = ".ak-roles/books/demo-book/issues/58/runs";
        assert.notEqual(installedRoot, packageRoot);
        const result = await runPiSubprocess(
          [
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--session-dir",
            sessionDir,
            "-e",
            installedEntrypoint,
            "-e",
            resolve(packageRoot, "test/fixtures/doctor-fresh-process-provider.ts"),
            "--ak-role",
            "doctor",
            "--ak-doctor-case",
            runsPath,
            "--provider",
            "ak-doctor-fresh",
            "--model",
            "faux-1",
            "--mode",
            "json",
            "Doctor.",
          ],
          {
            cwd: fixture,
            // Full-suite evidence: isolated ~1.4s; contended green ~8–9s; contended red timed out at 15s (duration_ms 16346).
            timeoutMs: 30_000,
            env: {
              ...process.env,
              HOME: home,
              PI_CODING_AGENT_DIR: agentDir,
              PI_OFFLINE: "1",
              AK_CORRELATION_ID: "doctor-fresh-corr",
              AK_DOCTOR_FRESH_CASE_PATH: caseIdentityPath,
              AK_DOCTOR_FRESH_ISSUE: "58",
            },
          },
        );

        assert.equal(result.timedOut, false, result.stderr);
        assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stderr, /DOCTOR_FRESH_PROVIDER_CALLS=2/);

        const events = result.stdout
          .split("\n")
          .filter((line) => line.trim().startsWith("{"))
          .map((line) => JSON.parse(line) as any);
        const sessionFiles = (await readdir(sessionDir))
          .filter((name) => name.endsWith(".jsonl"));
        assert.equal(sessionFiles.length, 1);
        const sessionRows = (await readFile(
          resolve(sessionDir, sessionFiles[0]!),
          "utf8",
        )).split("\n").filter(Boolean).map((line) => JSON.parse(line) as any);
        const recordedToolCalls = sessionRows
          .filter((row) => row.type === "message" && row.message?.role === "assistant")
          .flatMap((row) => row.message.content.filter((part: any) => part.type === "toolCall"));
        assert.equal(recordedToolCalls.length, 1);
        const retainedAuditRows = sessionRows.filter(
          (row) => row.type === "custom" && row.customType === COMPLIANCE_RESPONSE_ENTRY_TYPE,
        );
        assert.equal(retainedAuditRows.length, 1);
        const retainedAudit = retainedAuditRows[0].data.response;
        assert.equal(retainedAudit.role, "assistant");
        assert.equal(retainedAudit.stopReason, "toolUse");
        assert.equal(
          recordedToolCalls.filter((part: any) => part.name === "ak_doctor_output").length,
          1,
        );
        const auditCalls = retainedAudit.content.filter(
          (part: any) => part.type === "toolCall" && part.name === "ak_doctor_audit_decision",
        );
        assert.equal(auditCalls.length, 1);
        assert.deepEqual(auditCalls[0].arguments, {
          status: "pass",
          violations: [],
          conflicts: [],
          decisionGate: null,
        });

        const outputResults = events.filter(
          (event) =>
            event.type === "message_end" &&
            event.message?.role === "toolResult" &&
            event.message.toolName === "ak_doctor_output",
        );
        assert.equal(outputResults.length, 1);
        assert.equal(outputResults[0].message.isError, false);
        const output = validateRecordedDoctorOutput(outputResults[0].message.details);
        assert.equal(output.status, "completed");
        assert.deepEqual(output.case, { issueNumber: 58, runsPath: caseIdentityPath });
        assert.deepEqual(output.findings, []);
        assert.ok(output.cost);

        // Envelope activation fact (outside locator-focused tests): points at the durable Pi session.
        const ledgerPath = activationWaitingLedgerPath(resolve(home, ".ak-roles"), bookKey);
        const factLines = (await readFile(ledgerPath, "utf8")).trim().split("\n");
        assert.equal(factLines.length, 1, `expected one activation fact at ${ledgerPath}`);
        const fact = JSON.parse(factLines[0]!) as AcceptedActivationFact;
        assert.equal(fact.event, ACCEPTED_ACTIVATION_EVENT);
        assert.equal(fact.role, "doctor");
        assert.equal(fact.bookKey, bookKey);
        assert.deepEqual(fact.correlation, { kind: "caller", id: "doctor-fresh-corr" });
        assert.equal(fact.session.kind, "session-file");
        if (fact.session.kind !== "session-file") throw new Error("expected session-file pointer");
        assert.equal(fact.session.path, realpathSync(resolve(sessionDir, sessionFiles[0]!)));
        // Retained case session bytes still under the admitted ledger-home runsPath.
        assert.equal(
          (await readFile(resolve(runsPath, "case/session/retained.jsonl"), "utf8")).includes("doctor-case"),
          true,
        );
      });
    },
  );
});
