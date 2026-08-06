import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildExplicitInternalActivationArgs,
  helpDocument,
  resolveInternalRoleEntrypoint,
  runAkRole,
} from "../../src/public-cli/cli.ts";
import { PUBLIC_CALLABLE_ROLES, PUBLIC_CONFIGURABLE_SEATS } from "../../src/public-cli/registry.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-cli-"));
  try {
    return await scenario(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

test("help document capabilities match typed registry without depending on layout", () => {
  const doc = helpDocument();
  assert.equal(doc.executable, "ak-role");
  const names = doc.capabilities.map((c) => c.name);
  assert.equal(names.includes("roles"), true);
  assert.equal(names.includes("config"), true);
  assert.equal(names.includes("help"), true);
  for (const role of PUBLIC_CALLABLE_ROLES) {
    assert.equal(names.includes(role), true);
  }
  assert.equal((names as readonly string[]).includes("navigator"), false);
});

test("roles lists seven callable seats plus automatic Navigator with effective models", async () => {
  await withTempHome(async (home) => {
    const { io, stdout } = captureIo();
    const result = await runAkRole(["roles"], {
      packageRoot,
      home,
      credentials: { "openai-codex": true, xai: false },
      io,
    });
    assert.equal(result.exitCode, 0);
    const text = stdout.join("");
    // Contract: every configurable seat appears once; kind markers present.
    for (const seat of PUBLIC_CONFIGURABLE_SEATS) {
      assert.match(text, new RegExp(`^${seat}\\t`, "m"));
    }
    assert.match(text, /^navigator\tautomatic\t/m);
    assert.match(text, /^judge\tcallable\tstartup\topenai-codex\/gpt-5\.6-sol:high$/m);
    assert.equal(text.includes("auditor"), false);
  });
});

test("config set bulk write is visible to a subsequent roles process; local override does not persist", async () => {
  await withTempHome(async (home) => {
    const first = captureIo();
    const setResult = await runAkRole(
      [
        "config",
        "set",
        "judge",
        "xai/grok-4.5:high",
        "navigator",
        "openai-codex/gpt-5.6-luna:medium",
      ],
      { packageRoot, home, io: first.io },
    );
    assert.equal(setResult.exitCode, 0);

    const second = captureIo();
    const rolesResult = await runAkRole(["roles"], {
      packageRoot,
      home,
      credentials: { "openai-codex": true, xai: true },
      io: second.io,
    });
    assert.equal(rolesResult.exitCode, 0);
    const rolesText = second.stdout.join("");
    assert.match(rolesText, /^judge\tcallable\tpersistent\txai\/grok-4\.5:high$/m);
    assert.match(
      rolesText,
      /^navigator\tautomatic\tpersistent\topenai-codex\/gpt-5\.6-luna:medium$/m,
    );

    const before = await readFile(join(home, ".ak-roles", "public-cli.json"), "utf8");
    const third = captureIo();
    const overrideResult = await runAkRole(
      ["roles", "--model", "openai-codex/gpt-5.6-sol", "--thinking", "high"],
      {
        packageRoot,
        home,
        credentials: { "openai-codex": true, xai: true },
        io: third.io,
      },
    );
    assert.equal(overrideResult.exitCode, 0);
    assert.match(
      third.stdout.join(""),
      /^judge\tcallable\tinvocation\topenai-codex\/gpt-5\.6-sol:high$/m,
    );
    const after = await readFile(join(home, ".ak-roles", "public-cli.json"), "utf8");
    assert.equal(after, before);
  });
});

test("explicit internal activation args point at the package entrypoint file", async () => {
  const entry = resolveInternalRoleEntrypoint(packageRoot);
  await access(entry);
  const args = buildExplicitInternalActivationArgs(packageRoot, [
    "--ak-role",
    "judge",
    "--help",
  ]);
  assert.deepEqual(args.slice(0, 3), ["--no-extensions", "-e", entry]);
  assert.equal(args.includes("--ak-role"), true);
});

test("merger role command is a completed public run path (no deferred slice)", async () => {
  await withTempHome(async (home) => {
    const { io, stderr, stdout } = captureIo();
    // Blank instruction is a structural reject on the completed Merger adapter.
    const result = await runAkRole(["merger", "   "], {
      packageRoot,
      home,
      io,
      piRunner: async () => {
        throw new Error("must not dispatch blank merger");
      },
    });
    assert.equal(result.exitCode, 2);
    assert.equal(stderr.join("").includes("not available in this install slice"), false);
    assert.equal(stdout.join("").includes("not available in this install slice"), false);
  });
});

test("unknown command exits nonzero without touching config", async () => {
  await withTempHome(async (home) => {
    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await writeFile(
      join(home, ".ak-roles", "public-cli.json"),
      JSON.stringify({ seats: {} }),
      "utf8",
    );
    const before = await readFile(join(home, ".ak-roles", "public-cli.json"), "utf8");
    const { io, stderr } = captureIo();
    const result = await runAkRole(["not-a-command"], {
      packageRoot,
      home,
      io,
    });
    assert.equal(result.exitCode, 2);
    assert.equal(stderr.join("").length > 0, true);
    const after = await readFile(join(home, ".ak-roles", "public-cli.json"), "utf8");
    assert.equal(after, before);
  });
});
