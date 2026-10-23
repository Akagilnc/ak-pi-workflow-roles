import assert from "node:assert/strict";
import { test } from "vitest";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import { parsePublicSeatArgv } from "../../src/public-cli/invocation.ts";

// Phase default/plan, unknown flags, empty --project and --project= are carried by
// public runAkRole cases (public-cli-coder, public-cli-fixer, public-cli-failure-settlement).
test("public seat argv keeps explicit phase, file flags and joined instruction; rejects blank project and missing file-flag value", () => {
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";

  assert.deepEqual(
    parsePublicSeatArgv("coder", [
      "apply",
      "--attach",
      "a.md",
      "--project",
      "/tmp/p",
      "Do the work.",
    ]),
    {
      phase: "apply",
      instruction: "Do the work.",
      attachmentPaths: ["a.md"],
      project: "/tmp/p",
    },
  );
  assert.equal(parsePublicSeatArgv("coder", ["opaque", "instruction"]).instruction, "opaque instruction");
  assert.throws(() => parsePublicSeatArgv("coder", ["--project", "   ", "task"]), isUsage);
  assert.throws(() => parsePublicSeatArgv("coder", ["--attach"]), isUsage);
});

// --pr binding is carried by public-cli-collector "#676 J2 explicit --pr is unique bound at admission".
test("public Collector keeps --repo without an observer declaration", () => {
  assert.equal(parsePublicSeatArgv("collector", ["--pr", "1168", "--repo", "acme/widgets"]).repo, "acme/widgets");
});

test("parseDoctorArgv requires positive issue; accepts optional runs and rejects malformed grammar", () => {
  assert.deepEqual(parsePublicSeatArgv("doctor", ["--issue", "40", "note"]), {
    issueNumber: 40,
    instruction: "note",
    attachmentPaths: [],
  });
  assert.deepEqual(
    parsePublicSeatArgv("doctor", [
      "--issue",
      "7",
      "--runs",
      ".ak-roles/books/demo/7/runs",
      "--project",
      "/tmp/p",
      "--attach",
      "/tmp/a.md",
    ]),
    {
      issueNumber: 7,
      runs: ".ak-roles/books/demo/7/runs",
      project: "/tmp/p",
      attachmentPaths: ["/tmp/a.md"],
      instruction: "",
    },
  );

  const rejected = [
    [],
    ["--issue"],
    ["--issue", "0"],
    ["--issue", "01"],
    ["--issue", "-3"],
    ["--issue", "1a"],
    ["--issue", "1.5"],
    ["--issue", "1", "--runs"],
    ["--issue", "1", "--runs", ""],
    ["40"], // bare number is not a typed issue selector
  ] as const;
  for (const raw of rejected) {
    assert.throws(() => parsePublicSeatArgv("doctor", [...raw]), (error: unknown) => error instanceof CliUsageError && error.code === "AK_ROLE_USAGE", JSON.stringify(raw));
  }
});

// Fixer phase and a provided --prerequisites path are carried by public-cli-fixer runAkRole cases.
test("parseFixerArgv keeps an empty --prerequisites path opaque and rejects a missing one", () => {
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";

  // #1168: empty prerequisites path is opaque (same as --attach), only missing arg is usage.
  assert.deepEqual(
    parsePublicSeatArgv("fixer", ["--prerequisites", "", "Repair."]),
    {
      phase: "apply",
      instruction: "Repair.",
      attachmentPaths: [],
      prerequisitesPath: "",
    },
  );
  assert.throws(() => parsePublicSeatArgv("fixer", ["--prerequisites"]), isUsage);
});
