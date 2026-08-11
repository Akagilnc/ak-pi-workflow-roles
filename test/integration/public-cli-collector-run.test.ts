import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { runAkRole } from "../../src/public-cli/cli.ts";
import { INTERNAL_ROLE_ENTRYPOINT_RELATIVE } from "../../src/public-cli/registry.ts";
import { packageRoot, piCli, runPiSubprocess, withHermeticHome } from "../helpers/pi-test-harness.ts";

function seedProject(project: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: project });
  execFileSync("git", ["config", "user.email", "collector@test.local"], { cwd: project });
  execFileSync("git", ["config", "user.name", "Collector"], { cwd: project });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: project });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: project });
}

test("public Collector preserves a real HTTP 404 as typed activation failure and Error Artifact", { timeout: 120_000 }, async () => {
  await withHermeticHome({ prefix: "ak-public-collector-404-" }, async ({ home }) => {
    const project = resolve(home, "work");
    const agentDir = resolve(home, ".pi", "agent");
    const binDir = resolve(home, "bin");
    await mkdir(project, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    seedProject(project);

    const gh = resolve(binDir, "gh");
    await writeFile(gh, `#!/usr/bin/env node
const args = process.argv.slice(2); const path = args.filter(a => a.startsWith('/')).at(-1) || '';
function reply(status, body) { process.stdout.write('HTTP/1.1 '+status+'\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify(body)); }
if (path.endsWith('/user')) reply(200, {login:'fixture'}); else if (path.includes('/pulls/404')) reply(404, {message:'Not Found'}); else process.exit(2);
`, "utf8");
    await chmod(gh, 0o755);

    const stderr: string[] = [];
    const result = await runAkRole([
      "collector", "--model", "ak-collector-offline/faux-1", "--thinking", "off",
      "--project", project, "--pr", "404", "Observe the pull request.",
    ], {
      packageRoot, home, agentDir, cwd: project,
      createRunId: () => "public-collector-http-404",
      credentials: { "openai-codex": true, xai: false },
      collectorExtraPiArgs: ["-e", resolve(packageRoot, "test/fixtures/collector-observe-provider.ts")],
      collectorTimeoutMs: 90_000,
      io: { stdout() {}, stderr: (text) => stderr.push(text) },
      piRunner: async (args, options) => {
        assert.ok(args.some((arg) => arg.endsWith(INTERNAL_ROLE_ENTRYPOINT_RELATIVE)));
        const subprocess = await runPiSubprocess([...args], {
          cwd: options.cwd,
          env: { ...options.env, PATH: `${binDir}:${dirname(piCli)}:${options.env.PATH ?? ""}`, PI_OFFLINE: "1" },
          timeoutMs: options.timeoutMs ?? 90_000,
        });
        return { code: subprocess.code, stdout: subprocess.stdout, stderr: subprocess.stderr, timedOut: subprocess.timedOut, args: [...args] };
      },
    });

    assert.equal(result.exitCode, 1, stderr.join(""));
    assert.equal(result.terminal?.roleOutcome.kind, "failure");
    if (result.terminal?.roleOutcome.kind !== "failure") assert.fail("expected typed failure");
    assert.equal(result.terminal.roleOutcome.cause, "activation");
    assert.match(result.terminal.roleOutcome.diagnostic, /HTTP 404/);
    const errorArtifact = result.terminal.artifacts.find((artifact) => artifact.kind === "error");
    assert.ok(errorArtifact, "typed failure must publish an Error Artifact");
    assert.match(await readFile(errorArtifact.path, "utf8"), /HTTP 404/);
  });
});
