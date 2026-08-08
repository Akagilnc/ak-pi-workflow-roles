import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseReviewerArgv } from "../../src/public-cli/invocation.ts";
import { runPublicReviewer } from "../../src/public-cli/reviewer-run.ts";
import { packageRoot, runPiSubprocess, withHermeticHome } from "../helpers/pi-test-harness.ts";

const FROZEN_BYTES = "frozen authority bytes — only from this run\n";
const OUTSIDE_BYTES = "outside authority bytes\n";
const PROVIDER = resolve(packageRoot, "test/fixtures/reviewer-production-provider.ts");

async function runProductionPi(args: readonly string[], options: Parameters<typeof runPiSubprocess>[1]) {
  const result = await runPiSubprocess([...args], options);
  return { ...result, args: [...args] };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertNoProviderCalls(path: string): void {
  assert.equal(existsSync(path) ? readFileSync(path, "utf8") : "0\n", "0\n");
}

test(
  "public Reviewer production chain consumes only this run's frozen attachment",
  { timeout: 180_000 },
  async () => {
    await withHermeticHome({ prefix: "ak-reviewer-production-chain-" }, async ({ home, agentDir }) => {
      const attachmentSource = resolve(home, "authority.md");
      await writeFile(attachmentSource, FROZEN_BYTES, "utf8");
      const common = {
        home,
        agentDir,
        packageRoot,
        cwd: packageRoot,
        model: { provider: "ak-reviewer-production", model: "faux-1", thinking: "off" as const },
        extraPiArgs: ["-e", PROVIDER],
        timeoutMs: 120_000,
      };

      const output: string[] = [];
      const success = await runPublicReviewer(
        ["--project", packageRoot, "--base", "HEAD~1", "--attach", attachmentSource, "Review the fixed point."],
        {
          ...common,
          createRunId: () => "reviewer-production-success",
          piRunner: runProductionPi,
        },
        { stdout: (text) => output.push(text), stderr: () => {} },
        parseReviewerArgv,
      );
      assert.equal(success.exitCode, 0, output.join("\n"));
      assert.equal(success.terminal?.roleOutcome.kind, "accepted");
      assert.equal(success.terminal?.roleOutcome.status, "completed");
      const runDirectory = success.admitted!.runDirectory;
      assert.equal(await readFile(join(runDirectory, "provider-consumed.txt"), "utf8"), FROZEN_BYTES);
      assert.equal(JSON.stringify(success.terminal).includes(FROZEN_BYTES), false);
      assert.equal(JSON.stringify(success.terminal).includes("provenancePath"), false);

      const cases = [
        {
          name: "run-outside",
          mutate: (run: string, record: any) => {
            const outside = join(run, "..", "outside-authority.md");
            writeFileSync(outside, OUTSIDE_BYTES, "utf8");
            record.attachments[0].frozenPath = outside;
            record.attachments[0].byteLength = Buffer.byteLength(OUTSIDE_BYTES);
            record.attachments[0].sha256 = sha256(OUTSIDE_BYTES);
          },
        },
        {
          name: "provenance-path",
          mutate: (_run: string, record: any) => {
            record.attachments[0].frozenPath = attachmentSource;
            record.attachments[0].byteLength = Buffer.byteLength(FROZEN_BYTES);
            record.attachments[0].sha256 = sha256(FROZEN_BYTES);
          },
        },
        {
          name: "non-attachments",
          mutate: (_run: string, record: any) => {
            const taskPath = join(record.__runDirectory, "task.md");
            const bytes = readFileSync(taskPath);
            record.attachments[0].frozenPath = taskPath;
            record.attachments[0].byteLength = bytes.byteLength;
            record.attachments[0].sha256 = createHash("sha256").update(bytes).digest("hex");
          },
        },
        {
          name: "symlink",
          mutate: (run: string, record: any) => {
            const link = join(run, "attachments", "replacement.md");
            symlinkSync(join(run, "..", "outside-authority.md"), link);
            record.attachments[0].frozenPath = link;
            record.attachments[0].byteLength = Buffer.byteLength(OUTSIDE_BYTES);
            record.attachments[0].sha256 = sha256(OUTSIDE_BYTES);
          },
        },
        {
          name: "missing",
          mutate: (run: string, record: any) => {
            record.attachments[0].frozenPath = join(run, "attachments", "missing.md");
          },
        },
        {
          name: "length-mismatch",
          mutate: (_run: string, record: any) => { record.attachments[0].byteLength += 1; },
        },
        {
          name: "sha-mismatch",
          mutate: (_run: string, record: any) => { record.attachments[0].sha256 = "0".repeat(64); },
        },
      ];

      for (const entry of cases) {
        const callsPath = resolve(home, `${entry.name}-provider-calls.txt`);
        const result = await runPublicReviewer(
          ["--project", packageRoot, "--base", "HEAD~1", "--attach", attachmentSource, `Review ${entry.name}.`],
          {
            ...common,
            createRunId: () => `reviewer-production-${entry.name}`,
            piRunner: async (args, options) => {
              const run = options.env.AK_ROLE_RUN_DIR!;
              const requestPath = join(run, "admitted-request.json");
              const record = JSON.parse(readFileSync(requestPath, "utf8")) as any;
              record.__runDirectory = run;
              entry.mutate(run, record);
              delete record.__runDirectory;
              writeFileSync(requestPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
              return runProductionPi(args, {
                ...options,
                env: { ...options.env, AK_REVIEWER_PROVIDER_CALLS: callsPath },
              });
            },
          },
          { stdout: () => {}, stderr: () => {} },
          parseReviewerArgv,
        );
        assert.notEqual(result.exitCode, 0, `${entry.name} must fail before provider turn`);
        assertNoProviderCalls(callsPath);
      }
    });
  },
);
