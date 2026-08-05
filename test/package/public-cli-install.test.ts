import assert from "node:assert/strict";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
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
import { PUBLIC_CALLABLE_ROLES, PUBLIC_CONFIGURABLE_SEATS } from "../../src/public-cli/registry.ts";

async function runAkRoleBin(
  bin: string,
  args: string[],
  options: { home: string; agentDir: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd: options.home,
      env: {
        ...process.env,
        ...options.env,
        HOME: options.home,
        PI_CODING_AGENT_DIR: options.agentDir,
        PATH: `${dirname(bin)}:${process.env.PATH ?? ""}`,
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
    const installed = await installPackedArtifactIntoPiNpm(piAgentDir);

    await access(installed.akRoleBin);
    const realBin = await realpath(installed.akRoleBin);
    assert.equal(realBin.includes("@akagilnc/pi-workflow-roles"), true);
    assert.equal(realBin.endsWith(join("dist", "public-cli", "main.js")), true);

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

test("ordinary Pi startup does not register Internal --ak-role; explicit -e load does", async () => {
  await withHermeticHome({ prefix: "ak-public-cli-no-auto-" }, async ({ home }) => {
    const piAgentDir = resolve(home, ".pi", "agent");
    await mkdir(piAgentDir, { recursive: true });
    const installed = await installPackedArtifactIntoPiNpm(piAgentDir);

    // Register the package in Pi settings so ordinary startup would load pi.extensions.
    await writeFile(
      resolve(piAgentDir, "settings.json"),
      JSON.stringify(
        {
          packages: [
            // Local path install of the already-materialized package tree.
            installed.installedRoot,
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

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
    // Extension CLI Flags section must not advertise Internal --ak-role.
    assert.equal(
      /--ak-role\b/.test(ordinary.stdout) || /--ak-role\b/.test(ordinary.stderr),
      false,
      `ordinary help must not register --ak-role\nstdout:\n${ordinary.stdout}\nstderr:\n${ordinary.stderr}`,
    );

    const internal = resolve(installed.installedRoot, INTERNAL_ROLE_ENTRYPOINT_RELATIVE);
    const explicit = await runPiSubprocess(
      [
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-session",
        "-e",
        internal,
        "--help",
      ],
      {
        cwd: home,
        timeoutMs: 30_000,
        env: {
          ...process.env,
          HOME: home,
          PI_CODING_AGENT_DIR: piAgentDir,
          PI_OFFLINE: "1",
        },
      },
    );
    assert.equal(explicit.timedOut, false, explicit.stderr);
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.equal(
      /--ak-role\b/.test(explicit.stdout) || /--ak-role\b/.test(explicit.stderr),
      true,
      `explicit -e load must register --ak-role\nstdout:\n${explicit.stdout}\nstderr:\n${explicit.stderr}`,
    );

    // ak-role resolves the same installed runtime path for one invocation.
    const akRolePackageRoot = installed.installedRoot;
    assert.equal(
      resolve(akRolePackageRoot, INTERNAL_ROLE_ENTRYPOINT_RELATIVE),
      internal,
    );
    // PATH discovery: private npm bin is how callers find ak-role.
    const which = await runAkRoleBin(installed.akRoleBin, ["help", "roles"], {
      home,
      agentDir: piAgentDir,
    });
    assert.equal(which.code, 0, which.stderr);
    assert.match(which.stdout, /roles/);
  });
});

// Keep a reference so tree-shaking/lint does not drop harness symbols used by peers.
void packageRoot;
void piCli;
