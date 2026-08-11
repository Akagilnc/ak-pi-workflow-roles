import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, chmod, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
import { runPublicCliSubprocess as runAkRoleBin } from "../helpers/public-cli-subprocess.ts";
import { TEST_PI_VERSION_BRANCH } from "../helpers/test-process-fixtures.ts";

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "coder-install@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Coder Install"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

test("isolated Pi home installs packed artifact and discovers ak-role via private npm bin", async () => {
  await withHermeticHome({ prefix: "ak-public-cli-bin-" }, async ({ home, agentDir }) => {
    // Use a Pi-shaped agent dir under the hermetic home (not the harness default .pi-agent label).
    const piAgentDir = resolve(home, ".pi", "agent");
    await mkdir(piAgentDir, { recursive: true });
    const installed = await installPackedArtifactIntoPiNpm(piAgentDir, home);

    const assertHostPeersAbsent = async (): Promise<void> => {
      for (const name of ["pi-ai", "pi-coding-agent"]) {
        await assert.rejects(
          () => access(resolve(installed.npmRoot, "node_modules", "@earendil-works", name)),
          (error: NodeJS.ErrnoException) => error.code === "ENOENT",
          `${name} must be supplied by the real Pi host, not its package npm root`,
        );
      }
      const listed = spawnSync("npm", ["ls", "--json", "--depth=0"], {
        cwd: installed.npmRoot,
        encoding: "utf8",
      });
      assert.notEqual(listed.stdout, "", listed.stderr);
      const tree = JSON.parse(listed.stdout) as { dependencies?: Record<string, unknown> };
      assert.ok(tree.dependencies?.["@akagilnc/pi-workflow-roles"]);
      assert.equal(tree.dependencies?.["@earendil-works/pi-ai"], undefined);
      assert.equal(tree.dependencies?.["@earendil-works/pi-coding-agent"], undefined);
    };
    await assertHostPeersAbsent();

    const project = resolve(home, "identity-work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const hostPiExecutable = await realpath(piCli);
    const hostPiVersion = execFileSync(hostPiExecutable, ["--version"], { encoding: "utf8" }).trim();
    const traceInvocationIdentity = async (): Promise<void> => {
      // Coder with no credentials reaches its documented activation-failure
      // terminal without consulting a model provider.
      const run = await runAkRoleBin(
        installed.akRoleBin,
        ["coder", "plan", "--project", project, "Trace the selected Pi identity."],
        {
          home,
          agentDir: piAgentDir,
          env: { PI_BINARY: hostPiExecutable, PI_OFFLINE: "1" },
        },
      );
      assert.equal(run.timedOut, false, run.stderr);
      assert.equal(run.code, 1, run.stderr);
      const runsRoot = resolve(home, ".ak-roles", "books", "identity-work", "runs");
      const names = (await readdir(runsRoot)).filter((name) => name.endsWith("@coder")).sort();
      const runRoot = resolve(runsRoot, names.at(-1)!);
      const invocation = JSON.parse(
        await readFile(resolve(runRoot, "invocation.json"), "utf8"),
      ) as { piExecutable?: string; piVersion?: string };
      assert.equal(invocation.piExecutable, hostPiExecutable);
      assert.equal(invocation.piVersion, hostPiVersion);
      assert.match(
        `${run.stdout}\n${run.stderr}`,
        /^coder\tfailure\t"activation"$/m,
        "installed public role must present its typed terminal",
      );
    };
    await traceInvocationIdentity();

    const source = `npm:@akagilnc/pi-workflow-roles@file:${installed.pack.tarball}`;
    const repeated = await runPiSubprocess(["install", source], {
      cwd: home,
      timeoutMs: 120_000,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: piAgentDir,
        PI_OFFLINE: "1",
      },
    });
    assert.equal(repeated.timedOut, false, repeated.stderr);
    assert.equal(repeated.code, 0, repeated.stderr);
    await assertHostPeersAbsent();
    await traceInvocationIdentity();
    await assertHostPeersAbsent();

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
${TEST_PI_VERSION_BRANCH}
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

    // Enter through installed ak-role on completed Merger (#114): no deferred slice.
    // Non-merge worktree → honest activation failure; Internal entrypoint still ships.
    const project = resolve(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const throughAkRole = await runAkRoleBin(
      installed.akRoleBin,
      ["merger", "--project", project, "Resolve the active merge."],
      {
        home,
        agentDir: piAgentDir,
        env: {
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          PI_OFFLINE: "1",
        },
      },
    );
    assert.equal(throughAkRole.timedOut, false, throughAkRole.stderr);
    // No active merge → honest activation failure (nonzero), not deferred-slice prose.
    assert.notEqual(throughAkRole.code, 0, throughAkRole.stderr);
    assert.equal(
      throughAkRole.stderr.includes("not available in this install slice"),
      false,
    );
    assert.equal(
      throughAkRole.stdout.includes("not available in this install slice"),
      false,
    );

    // Installed package still owns the Internal entrypoint for explicit load.
    await access(internal);
    const entryText = await readFile(internal, "utf8");
    assert.equal(entryText.includes("createRoleRuntimeExtension"), true);
  });
});

test("installed ak-role coder admits plan/apply and binds package-owned tdd without ambient home skills", async () => {
  await withHermeticHome({ prefix: "ak-public-cli-coder-" }, async ({ home }) => {
    const piAgentDir = resolve(home, ".pi", "agent");
    await mkdir(piAgentDir, { recursive: true });
    const installed = await installPackedArtifactIntoPiNpm(piAgentDir, home);

    // Packed install carries the complete TDD method tree + provenance.
    for (const rel of [
      "resources/methods/tdd/SKILL.md",
      "resources/methods/tdd/tests.md",
      "resources/methods/tdd/mocking.md",
      "resources/methods/tdd/agents/openai.yaml",
      "resources/methods/tdd/provenance.json",
    ]) {
      await access(resolve(installed.installedRoot, rel));
    }
    // Empty home: no ambient skills tree.
    await assert.rejects(
      () => access(resolve(home, ".agents", "skills")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );

    const project = resolve(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Structural reject stays on the installed bin (not "unavailable slice").
    const blank = await runAkRoleBin(
      installed.akRoleBin,
      ["coder", "plan", "--project", project, "   "],
      { home, agentDir: piAgentDir },
    );
    assert.equal(blank.timedOut, false, blank.stderr);
    assert.equal(blank.code, 2, blank.stderr);
    assert.equal(blank.stderr.includes("not available in this install slice"), false);

    // Record Pi argv owned by ak-role coder apply (package skill path must appear).
    const shimDir = resolve(home, "pi-shim-coder");
    await mkdir(shimDir, { recursive: true });
    const argvLog = resolve(home, "ak-role-coder-pi-argv.json");
    const shimPath = resolve(shimDir, "pi");
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
${TEST_PI_VERSION_BRANCH}
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)), "utf8");
process.exit(1);
`,
      "utf8",
    );
    await chmod(shimPath, 0o755);

    const apply = await runAkRoleBin(
      installed.akRoleBin,
      [
        "coder",
        "--project",
        project,
        "Implement the approved vertical slice with package TDD.",
      ],
      {
        home,
        agentDir: piAgentDir,
        env: {
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          PI_OFFLINE: "1",
        },
      },
    );
    assert.equal(apply.timedOut, false, apply.stderr);
    assert.equal(apply.stderr.includes("not available in this install slice"), false);
    const recorded = JSON.parse(await readFile(argvLog, "utf8")) as string[];
    assert.equal(recorded[recorded.indexOf("--ak-role") + 1], "coder");
    assert.equal(recorded[recorded.indexOf("--ak-coder-phase") + 1], "apply");
    assert.equal(recorded.includes("--skill"), true);
    const skillPath = recorded[recorded.indexOf("--skill") + 1]!;
    assert.equal(skillPath.includes("resources/methods/tdd/SKILL.md"), true);
    assert.equal(skillPath.includes(installed.installedRoot) || skillPath.includes("@akagilnc/pi-workflow-roles"), true);
    assert.equal(skillPath.includes(".agents/skills"), false);

    // Explicit plan omits package skill binding but preserves phase on the installed path.
    const planArgvLog = resolve(home, "ak-role-coder-plan-pi-argv.json");
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
${TEST_PI_VERSION_BRANCH}
writeFileSync(${JSON.stringify(planArgvLog)}, JSON.stringify(process.argv.slice(2)), "utf8");
process.exit(1);
`,
      "utf8",
    );
    await chmod(shimPath, 0o755);
    const plan = await runAkRoleBin(
      installed.akRoleBin,
      [
        "coder",
        "plan",
        "--project",
        project,
        "Propose the first implementation plan.",
      ],
      {
        home,
        agentDir: piAgentDir,
        env: {
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          PI_OFFLINE: "1",
        },
      },
    );
    assert.equal(plan.timedOut, false, plan.stderr);
    assert.equal(plan.stderr.includes("not available in this install slice"), false);
    const planArgs = JSON.parse(await readFile(planArgvLog, "utf8")) as string[];
    assert.equal(planArgs[planArgs.indexOf("--ak-role") + 1], "coder");
    assert.equal(planArgs[planArgs.indexOf("--ak-coder-phase") + 1], "plan");
    assert.equal(planArgs.includes("--skill"), false);
  });
});

test("installed ak-role collector admits PR/legs and pins isolation without preflight", async () => {
  await withHermeticHome({ prefix: "ak-public-cli-collector-" }, async ({ home }) => {
    const piAgentDir = resolve(home, ".pi", "agent");
    await mkdir(piAgentDir, { recursive: true });
    const installed = await installPackedArtifactIntoPiNpm(piAgentDir, home);

    const project = resolve(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/Acme/Widgets.git"],
      { cwd: project },
    );

    // Malformed grammar rejects on the installed bin (not "unavailable slice").
    const badPr = await runAkRoleBin(
      installed.akRoleBin,
      ["collector", "--pr", "0", "--leg", "codex:bot", "--project", project],
      { home, agentDir: piAgentDir },
    );
    assert.equal(badPr.timedOut, false, badPr.stderr);
    assert.equal(badPr.code, 2, badPr.stderr);
    assert.equal(badPr.stderr.includes("not available in this install slice"), false);

    const badLeg = await runAkRoleBin(
      installed.akRoleBin,
      ["collector", "--pr", "1", "--leg", "NOPE:bot", "--project", project],
      { home, agentDir: piAgentDir },
    );
    assert.equal(badLeg.code, 2, badLeg.stderr);
    assert.equal(badLeg.stderr.includes("not available in this install slice"), false);

    // Record Pi argv owned by ak-role collector (isolation + structural flags).
    const shimDir = resolve(home, "pi-shim-collector");
    await mkdir(shimDir, { recursive: true });
    const argvLog = resolve(home, "ak-role-collector-pi-argv.json");
    const shimPath = resolve(shimDir, "pi");
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
${TEST_PI_VERSION_BRANCH}
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)), "utf8");
process.exit(1);
`,
      "utf8",
    );
    await chmod(shimPath, 0o755);

    const run = await runAkRoleBin(
      installed.akRoleBin,
      [
        "collector",
        "--project",
        project,
        "--pr",
        "999999",
        "--leg",
        "codex:definitely-not-a-real-bot",
        "--leg",
        "cursor:cursor-bot",
      ],
      {
        home,
        agentDir: piAgentDir,
        env: {
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          PI_OFFLINE: "1",
        },
      },
    );
    assert.equal(run.timedOut, false, run.stderr);
    assert.equal(run.stderr.includes("not available in this install slice"), false);
    const recorded = JSON.parse(await readFile(argvLog, "utf8")) as string[];
    assert.equal(recorded[recorded.indexOf("--ak-role") + 1], "collector");
    assert.equal(recorded[recorded.indexOf("--ak-collector-pr") + 1], "999999");
    assert.equal(
      recorded[recorded.indexOf("--ak-collector-repo") + 1],
      "Acme/Widgets",
    );
    assert.equal(recorded.includes("--ak-collector-legs"), true);
    assert.equal(recorded.includes("--no-skills"), true);
    assert.equal(recorded.includes("--skill"), false);
    assert.equal(recorded.includes("--no-session"), false);

    // Explicit repo override reaches activation flags.
    const overrideLog = resolve(home, "ak-role-collector-repo-override-pi-argv.json");
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
${TEST_PI_VERSION_BRANCH}
writeFileSync(${JSON.stringify(overrideLog)}, JSON.stringify(process.argv.slice(2)), "utf8");
process.exit(1);
`,
      "utf8",
    );
    await chmod(shimPath, 0o755);
    const overridden = await runAkRoleBin(
      installed.akRoleBin,
      [
        "collector",
        "--project",
        project,
        "--repo",
        "OtherOrg/OtherRepo",
        "--pr",
        "7",
        "--leg",
        "codex:CodexBot",
      ],
      {
        home,
        agentDir: piAgentDir,
        env: {
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          PI_OFFLINE: "1",
        },
      },
    );
    assert.equal(overridden.timedOut, false, overridden.stderr);
    const overrideArgs = JSON.parse(await readFile(overrideLog, "utf8")) as string[];
    assert.equal(
      overrideArgs[overrideArgs.indexOf("--ak-collector-repo") + 1],
      "OtherOrg/OtherRepo",
    );
  });
});

test("installed ak-role fixer admits plan/apply and binds package diagnosing-bugs without ambient home skills", async () => {
  await withHermeticHome({ prefix: "ak-public-cli-fixer-" }, async ({ home }) => {
    const piAgentDir = resolve(home, ".pi", "agent");
    await mkdir(piAgentDir, { recursive: true });
    const installed = await installPackedArtifactIntoPiNpm(piAgentDir, home);

    for (const rel of [
      "resources/methods/diagnosing-bugs/SKILL.md",
      "resources/methods/diagnosing-bugs/agents/openai.yaml",
      "resources/methods/diagnosing-bugs/scripts/hitl-loop.template.sh",
      "resources/methods/diagnosing-bugs/provenance.json",
    ]) {
      await access(resolve(installed.installedRoot, rel));
    }
    await assert.rejects(
      () => access(resolve(home, ".agents", "skills")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );

    const project = resolve(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const blank = await runAkRoleBin(
      installed.akRoleBin,
      ["fixer", "plan", "--project", project, "   "],
      { home, agentDir: piAgentDir },
    );
    assert.equal(blank.timedOut, false, blank.stderr);
    assert.equal(blank.code, 2, blank.stderr);
    assert.equal(blank.stderr.includes("not available in this install slice"), false);

    const badPrereq = resolve(home, "bad-prereq.json");
    await writeFile(badPrereq, JSON.stringify([{ id: "bad/id", requirement: "x" }]), "utf8");
    const malformed = await runAkRoleBin(
      installed.akRoleBin,
      [
        "fixer",
        "--project",
        project,
        "--prerequisites",
        badPrereq,
        "Repair the class.",
      ],
      { home, agentDir: piAgentDir },
    );
    assert.equal(malformed.code, 2, malformed.stderr);
    assert.equal(malformed.stderr.includes("not available in this install slice"), false);

    const shimDir = resolve(home, "pi-shim-fixer");
    await mkdir(shimDir, { recursive: true });
    const argvLog = resolve(home, "ak-role-fixer-pi-argv.json");
    const shimPath = resolve(shimDir, "pi");
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
${TEST_PI_VERSION_BRANCH}
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)), "utf8");
process.exit(1);
`,
      "utf8",
    );
    await chmod(shimPath, 0o755);

    const apply = await runAkRoleBin(
      installed.akRoleBin,
      [
        "fixer",
        "--project",
        project,
        "Settle the approved repair with optional diagnosis available.",
      ],
      {
        home,
        agentDir: piAgentDir,
        env: {
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          PI_OFFLINE: "1",
        },
      },
    );
    assert.equal(apply.timedOut, false, apply.stderr);
    assert.equal(apply.stderr.includes("not available in this install slice"), false);
    const recorded = JSON.parse(await readFile(argvLog, "utf8")) as string[];
    assert.equal(recorded[recorded.indexOf("--ak-role") + 1], "fixer");
    assert.equal(recorded[recorded.indexOf("--ak-fixer-phase") + 1], "apply");
    assert.equal(recorded.includes("--skill"), true);
    const skillPath = recorded[recorded.indexOf("--skill") + 1]!;
    assert.equal(
      skillPath.includes("resources/methods/diagnosing-bugs/SKILL.md"),
      true,
    );
    assert.equal(
      skillPath.includes(installed.installedRoot) ||
        skillPath.includes("@akagilnc/pi-workflow-roles"),
      true,
    );
    assert.equal(skillPath.includes(".agents/skills"), false);
    // Diagnosis available but not forced into the first prompt.
    assert.equal(recorded[recorded.length - 1]?.includes("/skill:diagnosing-bugs"), false);

    const planArgvLog = resolve(home, "ak-role-fixer-plan-pi-argv.json");
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
${TEST_PI_VERSION_BRANCH}
writeFileSync(${JSON.stringify(planArgvLog)}, JSON.stringify(process.argv.slice(2)), "utf8");
process.exit(1);
`,
      "utf8",
    );
    await chmod(shimPath, 0o755);
    const plan = await runAkRoleBin(
      installed.akRoleBin,
      [
        "fixer",
        "plan",
        "--project",
        project,
        "Propose the first repair plan.",
      ],
      {
        home,
        agentDir: piAgentDir,
        env: {
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          PI_OFFLINE: "1",
        },
      },
    );
    assert.equal(plan.timedOut, false, plan.stderr);
    assert.equal(plan.stderr.includes("not available in this install slice"), false);
    const planArgs = JSON.parse(await readFile(planArgvLog, "utf8")) as string[];
    assert.equal(planArgs[planArgs.indexOf("--ak-role") + 1], "fixer");
    assert.equal(planArgs[planArgs.indexOf("--ak-fixer-phase") + 1], "plan");
    assert.equal(planArgs.includes("--skill"), true);
  });
});

// Keep a reference so tree-shaking/lint does not drop harness symbols used by peers.
void packageRoot;
void piCli;
