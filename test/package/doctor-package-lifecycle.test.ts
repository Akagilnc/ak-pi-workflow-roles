/**
 * #319 Batch 2 (M2): Doctor-unique deep chain only
 * (fresh Pi process + installed extension → one audited output).
 * All-role cold smoke lives in public-cli-cold-matrix.test.ts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { validateRecordedDoctorOutput } from "../../src/doctor-contracts.ts";
import { readSitianRecords, resolveSitianRecordPath } from "../../src/sitian-facade.ts";
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
        const runDirectory = resolve(
          home,
          ".ak-roles",
          "books",
          bookKey,
          "runs",
          "doctor-fresh",
        );
        const sessionDir = resolve(runDirectory, "session");
        // #518 S3: institutional consumers read seat selection from the run page.
        // Direct-Pi doctor activation bypasses public-CLI admission, so seed the page.
        const { writeInstitutionalSeatTable, parentInheritedSeats } = await import(
          "../helpers/institutional-seat-table.ts"
        );
        await mkdir(runDirectory, { recursive: true });
        await writeInstitutionalSeatTable(
          runDirectory,
          parentInheritedSeats({ provider: "ak-doctor-fresh", model: "faux-1", thinking: "off" }),
        );
        // Production activation requires a git cwd (ADR 0048); seed the consumer fixture.
        // With a git root present, Doctor case identity becomes repo-relative (stableRunsIdentity).
        execFileSync("git", ["init", "-b", "main"], { cwd: fixture, stdio: "ignore" });
        const caseIdentityPath = ".ak-roles/books/demo-book/issues/58/runs";
        assert.notEqual(installedRoot, packageRoot);
        // #443: capture provider-visible systemPrompt from the installed entrypoint run.
        const promptCapturePath = resolve(home, "doctor-system-prompt.txt");
        const doctorSoul = [
          await readFile(resolve(installedRoot, "CLAUDE.md"), "utf8"),
          await readFile(resolve(installedRoot, "souls/doctor.md"), "utf8"),
        ].join("\n\n").trim();
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
            // #567: this file is on HEAVYWEIGHT_MANIFEST (concurrency=2) so suite contention is scheduled, not absorbed by a wider wait.
            // #675: nested public auditor adds a second real spawn under load.
            timeoutMs: 60_000,
            env: {
              ...process.env,
              HOME: home,
              PI_CODING_AGENT_DIR: agentDir,
              PI_OFFLINE: "1",
              // #675: nested public auditor reuses the doctor faux provider extension.
              AK_ROLE_NESTED_EXTRA_PI_ARGS: JSON.stringify([
                "-e",
                resolve(packageRoot, "test/fixtures/doctor-fresh-process-provider.ts"),
              ]),
              AK_CORRELATION_ID: "doctor-fresh-corr",
              AK_DOCTOR_FRESH_CASE_PATH: caseIdentityPath,
              AK_DOCTOR_FRESH_ISSUE: "58",
              AK_DOCTOR_FRESH_CAPTURE_SYSTEM_PROMPT: promptCapturePath,
            },
          },
        );

        assert.equal(result.localTimeout, false, result.stderr);
        assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
        const capturedPrompt = await readFile(promptCapturePath, "utf8");
        assert.ok(
          capturedPrompt.includes(`<doctor_soul>\n${doctorSoul}\n</doctor_soul>`),
          "installed Doctor provider prompt carries constitution + doctor soul",
        );

        const events = result.stdout
          .split("\n")
          .filter((line) => line.trim().startsWith("{"))
          .map((line) => JSON.parse(line) as any);
        const sessionFiles = (await readdir(sessionDir))
          .filter((name) => name.endsWith(".jsonl"));
        assert.equal(sessionFiles.length, 1);
        const sessionFile = resolve(sessionDir, sessionFiles[0]!);
        const sessionRows = (await readFile(sessionFile, "utf8"))
          .split("\n").filter(Boolean).map((line) => JSON.parse(line) as any);
        const recordedToolCalls = sessionRows
          .filter((row) => row.type === "message" && row.message?.role === "assistant")
          .flatMap((row) => row.message.content.filter((part: any) => part.type === "toolCall"));
        assert.equal(recordedToolCalls.length, 1);
        assert.equal(
          recordedToolCalls.filter((part: any) => part.name === "ak_doctor_output").length,
          1,
        );
        // #675: public auditor is its own run; offline tracers force audit pass without
        // parent-side sitian retention of a nested assistant response.

        const outputResults = events.filter(
          (event) =>
            event.type === "message_end" &&
            event.message?.role === "toolResult" &&
            event.message.toolName === "ak_doctor_output",
        );
        assert.equal(outputResults.length, 1);
        assert.equal(outputResults[0].message.isError, false);
        // #575 sole-final barrier: execute projects a pending-round-closure candidate;
        // the audited decisive facts seal onto the typed closure.
        assert.deepEqual(outputResults[0].message.details, { submissionDisposition: "pending-round-closure" });
        const closureRows = sessionRows.filter(
          (row) => row.type === "custom" && row.customType === "ak-role-submission-closure",
        );
        assert.equal(closureRows.length, 1, "single typed closure after Doctor output");
        const output = validateRecordedDoctorOutput(closureRows[0]?.data?.details);
        assert.equal(output.status, "completed");
        assert.deepEqual(output.case, { issueNumber: 58, runsPath: caseIdentityPath });
        assert.deepEqual(output.findings, []);
        assert.ok(output.cost);

        // Envelope activation fact (outside locator-focused tests): points at the durable Pi session.
        // #675: nested public auditor may also append an activation fact on the same book.
        const ledgerPath = activationWaitingLedgerPath(resolve(home, ".ak-roles"), bookKey);
        const facts = (await readFile(ledgerPath, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as AcceptedActivationFact)
          .filter((entry) => entry.role === "doctor");
        assert.equal(facts.length, 1, `expected one doctor activation fact at ${ledgerPath}`);
        const fact = facts[0]!;
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
