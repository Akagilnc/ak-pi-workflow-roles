import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";

import {
  RECORDER_DIAGNOSTIC_CATEGORIES,
  RECORDER_FAILURE_CODES,
  RECORDER_PUBLIC_MESSAGES,
  RECORDER_STAGES,
  RECORDER_SUPPORTED_SIGNALS,
} from "../src/recorder/errors.ts";
import { spawnOnce } from "../src/recorder/spawn.ts";
import {
  commitFile,
  initGitRepo,
  runRecorderBin,
  sha256File,
  writeRecorderConfig,
} from "./helpers/recorder-test-harness.ts";

const schema = JSON.parse(readFileSync("schemas/recorder-failure-v1.schema.json", "utf8"));
const diagnosticProperties = schema.properties.recorder.properties.diagnostic.oneOf[1].properties;
const secret = "ATTACKER_SECRET_REVIEW_004";

function emittedFailure(stderr: string): any {
  const lines = stderr.trim().split("\n").filter(Boolean);
  const value = JSON.parse(lines.at(-1) ?? "null");
  assert.equal(Check(schema, value), true, JSON.stringify(value));
  assert.equal(stderr.includes(secret), false);
  return value;
}

function fixture(root: string, options: { archiveRepo?: string; cwd?: string; externalPath?: string } = {}) {
  const refs = initGitRepo(join(root, "refs"));
  const authority = commitFile(refs, "authority.md", "authority\n");
  const task = commitFile(refs, "task.md", "task\n");
  const archiveRepo = options.archiveRepo ?? initGitRepo(join(root, "archive"));
  return writeRecorderConfig(root, {
    archiveRepo,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    authority: { repositoryRoot: refs, ...authority },
    task: { repositoryRoot: refs, ...task },
    externalInputs: options.externalPath === undefined ? [] : [{
      id: "external", sourcePath: options.externalPath,
      sha256: sha256File("expected\n"), kind: "input",
    }],
  });
}

function assertSafePreSpawn(value: any, expected: { code: string; stage: string; category?: string; childStatus?: "not-spawned" | "exited" }) {
  assert.equal(value.recorder.code, expected.code);
  assert.equal(value.recorder.message, ({
    "internal-error": "internal Recorder failure",
    "admission-failed": "declaration admission failed",
    "invalid-path": "invalid path",
    "invalid-archive": "invalid archive worktree",
  } as Record<string, string>)[expected.code]);
  assert.equal(value.recorder.location, null);
  assert.equal(value.recorder.diagnostic.stage, expected.stage);
  assert.ok(RECORDER_DIAGNOSTIC_CATEGORIES.includes(value.recorder.diagnostic.category));
  if (expected.category) assert.equal(value.recorder.diagnostic.category, expected.category);
  if ((expected.childStatus ?? "not-spawned") === "not-spawned") {
    assert.deepEqual(value.child, { status: "not-spawned", exitCode: null, signal: null, diagnostic: null });
  } else {
    assert.equal(value.child.status, "exited");
  }
  assert.equal(JSON.stringify(value).includes(secret), false);
}

test("shipped failure schema vocabulary exactly matches TypeScript", () => {
  assert.deepEqual(schema.properties.recorder.properties.code.enum, [...RECORDER_FAILURE_CODES]);
  assert.deepEqual(diagnosticProperties.stage.enum, [...RECORDER_STAGES]);
  assert.deepEqual(diagnosticProperties.category.enum, [...RECORDER_DIAGNOSTIC_CATEGORIES]);
  const signaled = schema.properties.child.oneOf.find((x: any) => x.properties.status.const === "signaled");
  assert.deepEqual(signaled.properties.signal.enum, [...RECORDER_SUPPORTED_SIGNALS]);
  for (const code of RECORDER_FAILURE_CODES) {
    assert.equal(typeof RECORDER_PUBLIC_MESSAGES[code], "string");
  }
});

test("schema rejects unlawful wire combinations", () => {
  const base = {
    recorder: {
      status: "failed",
      code: "spawn-failed",
      message: "failed to spawn child process",
      location: null,
      diagnostic: null,
    },
    child: { status: "not-spawned", exitCode: null, signal: null, diagnostic: null },
  };
  const rejects: Array<[string, any]> = [
    ["wrong message", { ...base, recorder: { ...base.recorder, message: "fabricated" } }],
    ["unknown signal", {
      recorder: { ...base.recorder, code: "extraction-failed", message: "receipt extraction failed" },
      child: { status: "signaled", exitCode: null, signal: "SIGMADEUP", diagnostic: null },
    }],
    ["overlong location", {
      recorder: {
        status: "failed",
        code: "invalid-config",
        message: "invalid Recorder config",
        location: ["a", "b", "c", "d", "e"],
        diagnostic: null,
      },
      child: base.child,
    }],
    ["unlawful location segment", {
      recorder: {
        status: "failed",
        code: "invalid-config",
        message: "invalid Recorder config",
        location: ["not-a-real-field"],
        diagnostic: null,
      },
      child: base.child,
    }],
    ["location on non-config", {
      recorder: { ...base.recorder, location: ["execution"] },
      child: base.child,
    }],
    ["internal-error without diagnostic", {
      recorder: {
        status: "failed",
        code: "internal-error",
        message: "internal Recorder failure",
        location: null,
        diagnostic: null,
      },
      child: base.child,
    }],
    ["exited with signal", {
      recorder: base.recorder,
      child: { status: "exited", exitCode: 1, signal: "SIGTERM", diagnostic: null },
    }],
    ["exit out of bounds", {
      recorder: base.recorder,
      child: { status: "exited", exitCode: 999, signal: null, diagnostic: null },
    }],
    ["not-spawned with exit", {
      recorder: base.recorder,
      child: { status: "not-spawned", exitCode: 1, signal: null, diagnostic: null },
    }],
  ];
  for (const [name, value] of rejects) {
    assert.equal(Check(schema, value), false, name);
  }
  assert.equal(Check(schema, base), true);
});

test("actual Recorder bin emits schema-valid not-spawned failure", async () => {
  const result = await runRecorderBin([secret]);
  assert.equal(result.code, 125);
  const value = emittedFailure(result.stderr);
  assert.equal(value.child.status, "not-spawned");
});

function ambiguousTerminalSource(settlement: string): string {
  const details = { status: "completed", report: "done" };
  const lifecycle = (id: string) => [
    { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id, name: "ak_coder_output", arguments: details }] } },
    { type: "tool_execution_start", toolCallId: id, toolName: "ak_coder_output", args: details },
    { type: "tool_execution_end", toolCallId: id, toolName: "ak_coder_output", isError: false, result: { content: [{ type: "text", text: "Coder report accepted" }], details } },
  ];
  return `const details=${JSON.stringify(details)}; const lifecycle=${lifecycle.toString()}; for (const event of [...lifecycle("one"), ...lifecycle("two")]) console.log(JSON.stringify(event)); ${settlement}`;
}

for (const childCase of [
  { name: "exited", source: ambiguousTerminalSource("process.exit(17)"), expected: { status: "exited", exitCode: 17, signal: null } },
  { name: "signaled", source: ambiguousTerminalSource("process.kill(process.pid, 'SIGTERM')"), expected: { status: "signaled", exitCode: null, signal: "SIGTERM" } },
] as const) {
  test(`actual Recorder bin emits schema-valid ${childCase.name} failure`, async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-failure-bin-"));
    try {
      const config = fixture(root);
      const result = await runRecorderBin(["--config", config, "--", process.execPath, "-e", childCase.source], { cwd: root });
      assert.equal(result.code, 125);
      const value = emittedFailure(result.stderr);
      assert.deepEqual({ status: value.child.status, exitCode: value.child.exitCode, signal: value.child.signal }, childCase.expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("launcher missing entry is internal-error with launcher diagnostic, not spawn-failed", async () => {
  const root = mkdtempSync(join(tmpdir(), "recorder-launcher-fallback-"));
  try {
    const bin = join(root, "bin", "ak-docket-record.js");
    mkdirSync(dirname(bin), { recursive: true });
    cpSync(resolve("bin/ak-docket-record.js"), bin);
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    const result = await runRecorderBin([secret], { cwd: root, binPath: bin });
    assert.equal(result.code, 125);
    const value = emittedFailure(result.stderr);
    assert.equal(value.recorder.code, "internal-error");
    assert.equal(value.recorder.message, "internal Recorder failure");
    assert.deepEqual(value.recorder.location, null);
    assert.equal(value.recorder.diagnostic.stage, "launcher");
    assert.ok(RECORDER_DIAGNOSTIC_CATEGORIES.includes(value.recorder.diagnostic.category));
    assert.deepEqual(value.child, {
      status: "not-spawned",
      exitCode: null,
      signal: null,
      diagnostic: null,
    });
    assert.equal(JSON.stringify(value).includes(secret), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const schemaCase of [
  { name: "read", category: "filesystem-missing", install: (_root: string) => {} },
  { name: "parse", category: "error", install: (root: string) => writeFileSync(join(root, "schemas", "recorder-manifest-v1.schema.json"), `{${secret}`) },
] as const) {
  test(`manifest schema ${schemaCase.name} cause reaches the production boundary safely`, async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-manifest-cause-"));
    try {
      cpSync(resolve("dist"), join(root, "dist"), { recursive: true });
      cpSync(resolve("bin"), join(root, "bin"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
      mkdirSync(join(root, "schemas"));
      schemaCase.install(root);
      const config = fixture(root);
      const result = await runRecorderBin(["--config", config, "--", process.execPath, "-e", "process.exit(0)"], { cwd: root, binPath: join(root, "bin", "ak-docket-record.js") });
      const value = emittedFailure(result.stderr);
      assertSafePreSpawn(value, { code: "internal-error", stage: "manifest", category: schemaCase.category, childStatus: "exited" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const causeCase of [
  { name: "unreadable external input", expected: { code: "admission-failed", stage: "admission", category: "filesystem-missing" }, configure: (root: string) => fixture(root, { externalPath: join(root, `${secret}-missing`) }) },
  { name: "missing cwd", expected: { code: "invalid-path", stage: "config-state", category: "filesystem-missing" }, configure: (root: string) => fixture(root, { cwd: join(root, `${secret}-missing`) }) },
  { name: "invalid Git worktree", expected: { code: "invalid-archive", stage: "config-state" }, configure: (root: string) => fixture(root, { archiveRepo: join(root, "not-a-repo") }) },
] as const) {
  test(`${causeCase.name} retains a safe real-cause diagnostic`, async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-cause-"));
    try {
      if (causeCase.name === "invalid Git worktree") mkdirSync(join(root, "not-a-repo"));
      const config = causeCase.configure(root);
      const result = await runRecorderBin(["--config", config, "--", process.execPath, "-e", "process.exit(0)"], { cwd: root });
      const value = emittedFailure(result.stderr);
      assertSafePreSpawn(value, causeCase.expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const childCase of [
  { name: "exit", source: "process.stdout.write('x'); process.exit(17)", expected: { exitCode: 17, signal: null } },
  { name: "signal", source: "process.stdout.write('x'); process.kill(process.pid, 'SIGTERM')", expected: { exitCode: null, signal: "SIGTERM" } },
] as const) {
  test(`real tee sink failure preserves exact child ${childCase.name} settlement`, async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-tee-test-"));
    try {
      const failingSink = join(root, "sink-directory");
      mkdirSync(failingSink);
      const execution = await spawnOnce({
        argv: [process.execPath, "-e", childCase.source], cwd: root, env: process.env,
        stdin: "inherit", stdoutPath: failingSink, stderrPath: join(root, "stderr"),
      });
      const [settlement, tee] = await Promise.all([
        execution.settlement,
        execution.teeCompletion.then(() => "resolved", () => "rejected"),
      ]);
      assert.deepEqual(settlement, childCase.expected);
      assert.equal(tee, "rejected");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("tee regressions leave no owned temporary roots", () => {
  assert.deepEqual(readdirSync(tmpdir()).filter((name) => name.startsWith("recorder-tee-test-")), []);
});

test("destination preflight: occupied yields destination-exists without spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "recorder-dest-occupied-"));
  try {
    const archiveRepo = initGitRepo(join(root, "archive"));
    const destParent = join(archiveRepo, ".ak", "dockets", "issues", "23", "apply");
    mkdirSync(destParent, { recursive: true });
    writeFileSync(join(destParent, "x"), "occupied\n");
    const config = fixture(root, { archiveRepo });
    // rewrite docketId to x via re-read
    const text = JSON.parse(readFileSync(config, "utf8"));
    text.archive.docketId = "issues/23/apply/x";
    writeFileSync(config, JSON.stringify(text, null, 2));
    const result = await runRecorderBin(
      ["--config", config, "--", process.execPath, "-e", `console.log(${JSON.stringify(secret)}); process.exit(0)`],
      { cwd: root },
    );
    assert.equal(result.code, 125);
    const value = emittedFailure(result.stderr);
    assert.equal(value.recorder.code, "destination-exists");
    assert.equal(value.recorder.message, "archive destination already exists");
    assert.deepEqual(value.child, {
      status: "not-spawned",
      exitCode: null,
      signal: null,
      diagnostic: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("environment lexical defects reject structurally before spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "recorder-env-lex-"));
  try {
    const config = fixture(root);
    const text = JSON.parse(readFileSync(config, "utf8"));
    text.execution.environment.overrides = { ["BAD\u0000NAME"]: "x" };
    writeFileSync(config, JSON.stringify(text));
    const result = await runRecorderBin(
      ["--config", config, "--", process.execPath, "-e", "process.exit(0)"],
      { cwd: root },
    );
    assert.equal(result.code, 125);
    const value = emittedFailure(result.stderr);
    assert.equal(value.recorder.code, "invalid-config");
    assert.deepEqual(value.recorder.location, ["execution", "environment", "overrides"]);
    assert.deepEqual(value.child, {
      status: "not-spawned",
      exitCode: null,
      signal: null,
      diagnostic: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
