import assert from "node:assert/strict";
import test from "node:test";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import { parsePublicSeatArgv } from "../../src/public-cli/invocation.ts";

test("parseCoderArgv defaults to apply and preserves explicit plan|apply", () => {
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";

  assert.deepEqual(parsePublicSeatArgv("coder", ["Implement the slice."]), {
    phase: "apply",
    instruction: "Implement the slice.",
    attachmentPaths: [],
  });
  assert.deepEqual(parsePublicSeatArgv("coder", ["plan", "Propose first cut."]), {
    phase: "plan",
    instruction: "Propose first cut.",
    attachmentPaths: [],
  });
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
  assert.throws(() => parsePublicSeatArgv("coder", ["--unknown-flag"]), isUsage);
  assert.throws(() => parsePublicSeatArgv("coder", ["--project", "", "task"]), isUsage);
});

test("public Collector accepts PR/repository without an observer declaration", () => {
  assert.deepEqual(parsePublicSeatArgv("collector", ["--pr", "1168", "--repo", "acme/widgets"]), {
    prNumber: 1168,
    repo: "acme/widgets",
    instruction: "",
    attachmentPaths: [],
  });
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
    ["--issue", "1", "--unknown"],
    ["40"], // bare number is not a typed issue selector
  ] as const;
  for (const raw of rejected) {
    assert.throws(() => parsePublicSeatArgv("doctor", [...raw]), (error: unknown) => error instanceof CliUsageError && error.code === "AK_ROLE_USAGE", JSON.stringify(raw));
  }
});

test("parseFixerArgv defaults to apply and preserves explicit plan|apply plus prerequisites path", () => {
  const isUsage = (error: unknown): boolean =>
    error instanceof CliUsageError && error.code === "AK_ROLE_USAGE";

  assert.deepEqual(parsePublicSeatArgv("fixer", ["Repair the class."]), {
    phase: "apply",
    instruction: "Repair the class.",
    attachmentPaths: [],
  });
  assert.deepEqual(parsePublicSeatArgv("fixer", ["plan", "Propose the repair."]), {
    phase: "plan",
    instruction: "Propose the repair.",
    attachmentPaths: [],
  });
  assert.deepEqual(
    parsePublicSeatArgv("fixer", [
      "apply",
      "--prerequisites",
      "prereq.json",
      "--attach",
      "a.md",
      "--project",
      "/tmp/p",
      "Settle findings.",
    ]),
    {
      phase: "apply",
      instruction: "Settle findings.",
      attachmentPaths: ["a.md"],
      prerequisitesPath: "prereq.json",
      project: "/tmp/p",
    },
  );
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
  assert.throws(() => parsePublicSeatArgv("fixer", ["--unknown-flag"]), isUsage);
  assert.throws(() => parsePublicSeatArgv("fixer", ["--prerequisites"]), isUsage);
  assert.throws(() => parsePublicSeatArgv("fixer", ["--project", "", "task"]), isUsage);
});
