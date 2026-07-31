import assert from "node:assert/strict";
import test from "node:test";
import { parseRecorderConfigStructure } from "../src/recorder/config.ts";
import { RecorderError, safeDiagnostic } from "../src/recorder/errors.ts";

const hash40 = "a".repeat(40),
  hash64 = "b".repeat(64);
function baseline(): any {
  return {
    version: 1,
    archive: {
      repositoryRoot: "/repo",
      root: ".ak/dockets",
      docketId: "issues/23/apply/x",
    },
    execution: {
      cwd: "/tmp",
      environment: { inherit: true, overrides: {}, unset: [] },
      stdin: "inherit",
    },
    declarations: {
      gitReferences: [
        {
          id: "authority",
          repositoryRoot: "/repo",
          commit: hash40,
          path: "authority.md",
          blobOid: hash40,
          sha256: hash64,
          kind: "authority",
        },
        {
          id: "task",
          repositoryRoot: "/repo",
          commit: hash40,
          path: "task.md",
          blobOid: hash40,
          sha256: hash64,
          kind: "task",
        },
      ],
      externalInputs: [],
      exhibits: [],
    },
    provenance: { package: null, model: null, target: null },
  };
}
function failure(value: unknown): RecorderError {
  try {
    parseRecorderConfigStructure(
      typeof value === "string" ? value : JSON.stringify(value),
    );
  } catch (error) {
    assert.ok(error instanceof RecorderError);
    return error;
  }
  assert.fail("expected failure");
}

test("production config boundary emits exact safe location matrix", () => {
  const cases: Array<[string, (x: any) => void, Array<string | number>]> = [
    ["version", (x) => (x.version = 2), ["version"]],
    ["archive shape", (x) => (x.archive.extra = true), ["archive"]],
    [
      "repository root",
      (x) => (x.archive.repositoryRoot = "relative"),
      ["archive", "repositoryRoot"],
    ],
    ["archive path", (x) => (x.archive.root = "../x"), ["archive", "root"]],
    ["cwd", (x) => (x.execution.cwd = "relative"), ["execution", "cwd"]],
    ["stdin", (x) => (x.execution.stdin = "pipe"), ["execution", "stdin"]],
    [
      "inherit",
      (x) => (x.execution.environment.inherit = 1),
      ["execution", "environment", "inherit"],
    ],
    [
      "override value",
      (x) => (x.execution.environment.overrides = { ATTACKER_KEY: 1 }),
      ["execution", "environment", "overrides"],
    ],
    [
      "override name empty",
      (x) => (x.execution.environment.overrides = { "": "v" }),
      ["execution", "environment", "overrides"],
    ],
    [
      "override name NUL",
      (x) => (x.execution.environment.overrides = { ["A\0B"]: "v" }),
      ["execution", "environment", "overrides"],
    ],
    [
      "override name equals",
      (x) => (x.execution.environment.overrides = { "A=B": "v" }),
      ["execution", "environment", "overrides"],
    ],
    [
      "override value NUL",
      (x) => (x.execution.environment.overrides = { SAFE: "v\0x" }),
      ["execution", "environment", "overrides"],
    ],
    [
      "unset entry",
      (x) => (x.execution.environment.unset = [1]),
      ["execution", "environment", "unset", 0],
    ],
    [
      "unset name NUL",
      (x) => (x.execution.environment.unset = ["A\0B"]),
      ["execution", "environment", "unset", 0],
    ],
    [
      "unset name equals",
      (x) => (x.execution.environment.unset = ["A=B"]),
      ["execution", "environment", "unset", 0],
    ],
    [
      "unset duplicate",
      (x) => (x.execution.environment.unset = ["A", "A"]),
      ["execution", "environment", "unset", 1],
    ],
    [
      "git item",
      (x) => (x.declarations.gitReferences[1].extra = true),
      ["declarations", "gitReferences", 1],
    ],
    [
      "id",
      (x) => (x.declarations.gitReferences[1].id = "bad/id"),
      ["declarations", "gitReferences", 1, "id"],
    ],
    [
      "commit",
      (x) => (x.declarations.gitReferences[1].commit = "bad"),
      ["declarations", "gitReferences", 1, "commit"],
    ],
    [
      "blob",
      (x) => (x.declarations.gitReferences[1].blobOid = "bad"),
      ["declarations", "gitReferences", 1, "blobOid"],
    ],
    [
      "digest",
      (x) => (x.declarations.gitReferences[1].sha256 = "bad"),
      ["declarations", "gitReferences", 1, "sha256"],
    ],
    [
      "kind",
      (x) => (x.declarations.gitReferences[1].kind = "bad"),
      ["declarations", "gitReferences", 1, "kind"],
    ],
    [
      "reserved path",
      (x) => (x.declarations.gitReferences[1].path = "manifest.json"),
      ["declarations", "gitReferences", 1, "path"],
    ],
    [
      "nested reserved path",
      (x) => (x.declarations.gitReferences[1].path = "manifest.json/child"),
      ["declarations", "gitReferences", 1, "path"],
    ],
    [
      "duplicate repository alias",
      (x) => {
        x.declarations.gitReferences[1].repositoryRoot = "/repo/.";
        x.declarations.gitReferences[1].path = "authority.md";
      },
      ["declarations", "gitReferences", 1],
    ],
    [
      "duplicate id",
      (x) => (x.declarations.gitReferences[1].id = "authority"),
      ["declarations", "gitReferences", 1, "id"],
    ],
    ["provenance", (x) => (x.provenance.model = 1), ["provenance", "model"]],
    [
      "missing task",
      (x) =>
        (x.declarations.gitReferences = x.declarations.gitReferences.slice(
          0,
          1,
        )),
      ["declarations"],
    ],
  ];
  for (const [name, mutate, location] of cases) {
    const value = baseline();
    mutate(value);
    const error = failure(value);
    assert.equal(error.code, "invalid-config", name);
    assert.deepEqual(error.location, location, name);
  }
  assert.deepEqual(failure("{").location, []);
  const root = baseline();
  root.extra = true;
  assert.deepEqual(failure(root).location, []);
});

test("all pure structure wins before metadata scanner can observe a credential-shaped id", () => {
  const value = baseline();
  value.declarations.gitReferences[0].id =
    "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  value.provenance.target = 7;
  assert.deepEqual(failure(value).location, ["provenance", "target"]);
});

test("unknown platform codes remain finite platform-error facts", () => {
  assert.deepEqual(
    safeDiagnostic("config-structure", { code: "EVIL_SECRET_CODE" }),
    { stage: "config-structure", category: "platform-error" },
  );
  assert.deepEqual(safeDiagnostic("config-read", { code: "ENOENT" }), {
    stage: "config-read",
    category: "filesystem-missing",
  });
});
