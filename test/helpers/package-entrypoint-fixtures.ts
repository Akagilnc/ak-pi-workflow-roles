/**
 * Shared helpers for package-entrypoint thematic split (#319 Batch 4 / R1).
 * Mechanical extraction from package-entrypoint.integration.test.ts — no behavior change.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  toolExecutionObservationRecordSchema,
  type ToolExecutionObservationRecord,
} from "../../src/role-runtime.ts";
export const RELEASE_SOUL_INVENTORY = [
  "souls/judge.md",
  "souls/fixer.md",
  "souls/coder.md",
  "souls/reviewer.md",
  "souls/collector.md",
  "souls/doctor.md",
  "souls/merger.md",
  "souls/navigator.md",
  "souls/gatekeeper.md",
  "souls/inspector.md",
  "souls/notary.md",
] as const;

import {
  packageRoot,
  type RawPackageManifest,
  resolvePackageEntrypoint,
  runPiSubprocess,
  machineLedgerHome,
  withActivationHome,
} from "./pi-test-harness.ts";

const siblingTool = defineTool({
  name: "integration_sibling",
  label: "Integration Sibling",
  description: "Offline sibling used to exercise Pi's parallel tool lifecycle",
  parameters: Type.Object({}),
  async execute() {
    await Promise.resolve();
    return {
      content: [{ type: "text" as const, text: "sibling completed" }],
      details: {},
    };
  },
});

function textOf(message: ToolResultMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function packageEntrypoint(manifest: RawPackageManifest): string {
  assert.ok(manifest.files?.includes("extensions"));
  assert.ok(manifest.files?.includes("souls"));
  // ADR 0052 / #105: Internal entrypoint is explicit-load only; not auto-registered.
  assert.deepEqual(manifest.pi?.extensions, []);
  assert.equal(manifest.bin?.["ak-role"], "dist/public-cli/main.js");
  return resolvePackageEntrypoint(manifest);
}


type PersistedEntry = { type?: string; timestamp?: string; customType?: string; data?: Record<string, any>; message?: Record<string, any> };

async function readLatestSession(directory: string): Promise<PersistedEntry[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl")).sort();
  assert.ok(files.length > 0, `expected a persisted session in ${directory}`);
  return (await readFile(join(directory, files.at(-1)!), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PersistedEntry);
}

type ObservedNavigatorSession = {
  directory: string;
  file: string;
  entries: PersistedEntry[];
};

/**
 * Independent book-key oracle for placement tracers.
 * Derives from git common-dir host basename directly — must not call production
 * resolveBookKeyFromGit (shared source would make expected/observed tautological).
 */
function independentBookKeyFromGit(cwd: string): string {
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  assert.ok(commonDir.length > 0, "git rev-parse --git-common-dir returned an empty path");
  const absoluteCommon = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
  const hostDirectory = basename(absoluteCommon) === ".git"
    ? dirname(absoluteCommon)
    : absoluteCommon;
  const bookKey = basename(hostDirectory);
  assert.ok(
    bookKey.length > 0 && bookKey !== "." && bookKey !== "/",
    `unable to derive independent book key from git common dir: ${absoluteCommon}`,
  );
  return bookKey;
}

/** Independent exact-placement oracle: `<book>/navigator/<sha256(subjectKey)[0:32]>`. */
function expectedNavigatorSessionDirectory(home: string, subjectKey: string, cwd: string): string {
  const digest = createHash("sha256").update(subjectKey).digest("hex").slice(0, 32);
  return join(machineLedgerHome(home), "books", independentBookKeyFromGit(cwd), "navigator", digest);
}

async function uniqueObservedNavigatorSession(
  home: string,
  subjectKey: string,
  cwd: string,
): Promise<ObservedNavigatorSession> {
  const directory = expectedNavigatorSessionDirectory(home, subjectKey, cwd);
  let files: string[];
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      assert.fail(`expected navigator session at exact placement ${directory}`);
    }
    throw error;
  }
  assert.ok(files.length > 0, `expected a persisted navigator session in ${directory}`);
  const file = join(directory, files.at(-1)!);
  const entries = (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PersistedEntry);
  return { directory, file, entries };
}


async function runOrdinaryNavigatorObservation(extensionPath: string) {
  return withActivationHome(
    { prefix: "ak-navigator-current-" },
    async ({ home, agentDir }) => {
      const issueRoot = resolve(home, ".ak/work/issues/28");
      await mkdir(issueRoot, { recursive: true });
      // Role session under ledger book (ADR 0048); Navigator subject still derives from issueRoot cwd.
      // #675 notary source-run requires <runId>@<role> leaf names.
      const sessionDirectory = resolve(
        home,
        ".ak-roles",
        "books",
        basename(home),
        "runs",
        "01a06ff1-0000-7000-8000-000000000001@judge",
        "session",
      );
      await mkdir(sessionDirectory, { recursive: true });
      // #518 A→B judge ruling: test 1's failure is a missing institutional seat
      // page (fixture-only), unrelated to parent seeding. Write the inherited
      // seats page at the run directory (dirname of the role session dir).
      await writeFile(resolve(issueRoot, "authority.md"), "owner authority for ordinary Navigator observation\n", "utf8");
      await writeFile(resolve(agentDir, "navigator-model.json"), JSON.stringify({ model: "ak-audit-failure/faux-1" }), "utf8");
      // Public navigator path reads seat table only (#675).
      const { savePublicCliConfig } = await import("../../src/public-cli/config.ts");
      const offlineSeat = { provider: "ak-audit-failure", model: "faux-1" };
      await savePublicCliConfig({
        seats: {
          navigator: offlineSeat,
          judge: offlineSeat,
          notary: offlineSeat,
          inspector: offlineSeat,
          auditor: offlineSeat,
        },
      }, home);
      const args = [
        "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
        "--session-dir", sessionDirectory,
        "-e", extensionPath,
        "-e", resolve(packageRoot, "test/fixtures/audit-failure-provider.ts"),
        "--ak-role", "judge", "--provider", "ak-audit-failure", "--model", "faux-1", "--mode", "json", "Judge.",
      ];
      const providerPath = resolve(packageRoot, "test/fixtures/audit-failure-provider.ts");
      // #675: nested public notary/auditor need retained run identity + nested faux provider.
      const runDirectory = dirname(sessionDirectory);
      await writeFile(
        join(runDirectory, "run-state.json"),
        `${JSON.stringify({
          runId: "01a06ff1-0000-7000-8000-000000000001",
          role: "judge",
          state: "running",
          bookKey: basename(home),
          projectRoot: issueRoot,
          sessionDirectory,
          sessionFile: join(sessionDirectory, "session.jsonl"),
          runDirectory,
          admittedRequestPath: join(runDirectory, "admitted-request.json"),
          principalWire: { kind: "pi", sessionFile: join(sessionDirectory, "session.jsonl") },
        }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(join(runDirectory, "admitted-request.json"), "{}\n", "utf8");
      const result = await runPiSubprocess(args, {
        cwd: issueRoot,
        env: {
          ...process.env,
          HOME: home,
          PI_CODING_AGENT_DIR: agentDir,
          AK_NAVIGATOR_OBSERVATION: "1",
          PI_OFFLINE: "1",
        },
      });
      const roleEntries = await readLatestSession(sessionDirectory);
      const attendance = roleEntries.find(
        (entry) => entry.type === "custom_message" && entry.customType === "ak-navigator-attendance",
      ) as { details?: { subjectKey?: string } } | undefined;
      const subjectKey = attendance?.details?.subjectKey;
      assert.equal(typeof subjectKey, "string", "ordinary role session must publish subjectKey");
      const navigatorEntries = (await uniqueObservedNavigatorSession(home, subjectKey!, issueRoot)).entries;
      return { result, roleEntries, navigatorEntries };
    },
  );
}

function parseToolExecutionObservations(stderr: string): ToolExecutionObservationRecord[] {
  return stderr.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (trimmed === "") return [];
    try {
      const value = JSON.parse(trimmed) as unknown;
      return Value.Check(toolExecutionObservationRecordSchema, value)
        ? [value as ToolExecutionObservationRecord]
        : [];
    } catch {
      return [];
    }
  });
}

export {
  siblingTool,
  textOf,
  packageEntrypoint,
  readLatestSession,
  independentBookKeyFromGit,
  expectedNavigatorSessionDirectory,
  uniqueObservedNavigatorSession,
  runOrdinaryNavigatorObservation,
  parseToolExecutionObservations,
};
export type { PersistedEntry, ObservedNavigatorSession };
