import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  INTERNAL_ROLE_ENTRYPOINT_RELATIVE,
  installPackedArtifactIntoPiNpm,
  packageRoot,
  piCli,
  runPiSubprocess,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";
import {
  PUBLIC_CALLABLE_ROLES,
  PUBLIC_CONFIGURABLE_SEATS,
} from "../../src/public-cli/registry.ts";

async function runAkRoleBin(
  bin: string,
  args: string[],
  options: { home: string; agentDir: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolvePromise) => {
    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      HOME: options.home,
      PI_CODING_AGENT_DIR: options.agentDir,
    };
    // Keep caller PATH overrides (e.g. pi argv shim) after the installed bin dir.
    const pathPrefix = `${dirname(bin)}:${mergedEnv.PATH ?? process.env.PATH ?? ""}`;
    const child = spawn(bin, args, {
      cwd: options.home,
      env: {
        ...mergedEnv,
        PATH: pathPrefix,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
}

test("isolated Pi home installs packed artifact and discovers ak-role via private npm bin", async () => {
  await withHermeticHome({ prefix: "ak-public-cli-bin-" }, async ({ home, agentDir }) => {
    // Use a Pi-shaped agent dir under the hermetic home (not the harness default .pi-agent label).
    const piAgentDir = resolve(home, ".pi", "agent");
    await mkdir(piAgentDir, { recursive: true });
    const installed = await installPackedArtifactIntoPiNpm(piAgentDir, home);

    await access(installed.akRoleBin);
    const realBin = await realpath(installed.akRoleBin);
    assert.equal(realBin.includes("@akagilnc/pi-workflow-roles"), true);
    assert.equal(realBin.endsWith(join("dist", "public-cli", "main.js")), true);

    // pi install owner persists the package into user settings (not a raw npm root hack).
    const settings = JSON.parse(
      await readFile(resolve(piAgentDir, "settings.json"), "utf8"),
    ) as { packages?: unknown[] };
    assert.equal(Array.isArray(settings.packages), true);
    assert.equal(
      (settings.packages ?? []).some(
        (entry) =>
          typeof entry === "string" &&
          entry.startsWith("npm:@akagilnc/pi-workflow-roles@file:"),
      ),
      true,
    );

    // Seed codex-only credentials for effective model resolution.
    await writeFile(
      resolve(piAgentDir, "auth.json"),
      JSON.stringify({ "openai-codex": { type: "oauth", access: "test" } }),
      "utf8",
    );

    const roles = await runAkRoleBin(installed.akRoleBin, ["roles"], {
      home,
      agentDir: piAgentDir,
    });
    assert.equal(roles.timedOut, false, roles.stderr);
    assert.equal(roles.code, 0, roles.stderr);
    for (const seat of PUBLIC_CONFIGURABLE_SEATS) {
      assert.match(roles.stdout, new RegExp(`^${seat}\\t`, "m"));
    }
    assert.match(roles.stdout, /^navigator\tautomatic\t/m);
    assert.equal(roles.stdout.includes("auditor"), false);

    // Help capabilities: exit 0; topic listing includes registry support + role names.
    // Do not assert exact prose/layout (锚定宪法).
    const help = await runAkRoleBin(installed.akRoleBin, ["help"], {
      home,
      agentDir: piAgentDir,
    });
    assert.equal(help.code, 0, help.stderr);
    for (const name of ["roles", "config", "help", ...PUBLIC_CALLABLE_ROLES]) {
      assert.equal(help.stdout.includes(name), true, `help must mention ${name}`);
    }

    // Bulk config survives a new process.
    const set = await runAkRoleBin(
      installed.akRoleBin,
      ["config", "set", "coder", "xai/grok-4.5:high"],
      { home, agentDir: piAgentDir },
    );
    assert.equal(set.code, 0, set.stderr);
    const again = await runAkRoleBin(installed.akRoleBin, ["roles"], {
      home,
      agentDir: piAgentDir,
      env: {
        // xai credential absent → persistent still wins for coder
      },
    });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /^coder\tcallable\tpersistent\txai\/grok-4\.5:high$/m);

    const before = await readFile(resolve(home, ".ak-roles", "public-cli.json"), "utf8");
    const overridden = await runAkRoleBin(
      installed.akRoleBin,
      ["roles", "--model", "openai-codex/gpt-5.6-luna", "--thinking", "high"],
      { home, agentDir: piAgentDir },
    );
    assert.equal(overridden.code, 0, overridden.stderr);
    assert.match(
      overridden.stdout,
      /^coder\tcallable\tinvocation\topenai-codex\/gpt-5\.6-luna:high$/m,
    );
    const after = await readFile(resolve(home, ".ak-roles", "public-cli.json"), "utf8");
    assert.equal(after, before);

    // Internal entrypoint remains on the same installed package copy.
    const internal = resolve(installed.installedRoot, INTERNAL_ROLE_ENTRYPOINT_RELATIVE);
    await access(internal);
  });
});

test("ordinary Pi startup does not register Internal --ak-role; ak-role explicitly loads installed runtime", async () => {
  await withHermeticHome({ prefix: "ak-public-cli-no-auto-" }, async ({ home }) => {
    const piAgentDir = resolve(home, ".pi", "agent");
    await mkdir(piAgentDir, { recursive: true });
    const installed = await installPackedArtifactIntoPiNpm(piAgentDir, home);
    const internal = resolve(installed.installedRoot, INTERNAL_ROLE_ENTRYPOINT_RELATIVE);
    await access(internal);

    // pi install already wrote settings.packages; ordinary startup must still stay inert
    // because package manifest leaves pi.extensions empty (ADR 0052).
    const ordinary = await runPiSubprocess(["--help"], {
      cwd: home,
      timeoutMs: 30_000,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: piAgentDir,
        PI_OFFLINE: "1",
      },
    });
    assert.equal(ordinary.timedOut, false, ordinary.stderr);
    assert.equal(ordinary.code, 0, ordinary.stderr);
    assert.equal(
      /--ak-role\b/.test(ordinary.stdout) || /--ak-role\b/.test(ordinary.stderr),
      false,
      `ordinary help must not register --ak-role\nstdout:\n${ordinary.stdout}\nstderr:\n${ordinary.stderr}`,
    );

    // Record argv of the Pi process that ak-role owns, then forward to real pi.
    const shimDir = resolve(home, "pi-shim");
    await mkdir(shimDir, { recursive: true });
    const argvLog = resolve(home, "ak-role-pi-argv.json");
    const realPi = await realpath(piCli);
    const shimPath = resolve(shimDir, "pi");
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args), "utf8");
const child = spawn(${JSON.stringify(realPi)}, args, {
  stdio: "inherit",
  env: process.env,
});
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
`,
      "utf8",
    );
    await chmod(shimPath, 0o755);

    // Enter through installed ak-role on a role that still defers full settlement:
    // production must spawn Pi with explicit -e load of the same installed copy.
    // (Judge is the first complete public run path — covered by #106 tests.)
    const throughAkRole = await runAkRoleBin(installed.akRoleBin, ["reviewer"], {
      home,
      agentDir: piAgentDir,
      env: {
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        PI_OFFLINE: "1",
      },
    });
    assert.equal(throughAkRole.timedOut, false, throughAkRole.stderr);
    assert.equal(throughAkRole.code, 2, throughAkRole.stderr);
    assert.match(throughAkRole.stderr, /not available in this install slice/);

    const recorded = JSON.parse(await readFile(argvLog, "utf8")) as string[];
    assert.equal(recorded.includes("--no-extensions"), true);
    const eIndex = recorded.indexOf("-e");
    assert.equal(eIndex >= 0, true, `expected -e in ${JSON.stringify(recorded)}`);
    const loadedEntrypoint = recorded[eIndex + 1];
    assert.equal(typeof loadedEntrypoint, "string");
    assert.equal(await realpath(loadedEntrypoint!), await realpath(internal));

    // Real Pi behind the shim registered Internal for that one invocation.
    // Re-run the recorded argv directly only to observe registration (not the product path).
    const loaded = await runPiSubprocess(recorded, {
      cwd: home,
      timeoutMs: 30_000,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: piAgentDir,
        PI_OFFLINE: "1",
      },
    });
    assert.equal(loaded.timedOut, false, loaded.stderr);
    assert.equal(loaded.code, 0, loaded.stderr);
    assert.equal(
      /--ak-role\b/.test(loaded.stdout) || /--ak-role\b/.test(loaded.stderr),
      true,
      `ak-role-owned explicit load must register --ak-role\nstdout:\n${loaded.stdout}\nstderr:\n${loaded.stderr}`,
    );
  });
});

// Keep a reference so tree-shaking/lint does not drop harness symbols used by peers.
void packageRoot;
void piCli;
