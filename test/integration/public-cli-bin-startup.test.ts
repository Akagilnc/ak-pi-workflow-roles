import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withTestUserProfileEnv } from "../helpers/public-cli-subprocess.ts";
import { isolatedTestProcessEnv } from "../helpers/test-process-fixtures.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

test("built public CLI starts for general and ticket-facing commands without Pi peer initialization", async () => {
  const distDir = join(packageRoot, "dist");
  await mkdir(distDir, { recursive: true });
  const binDir = await mkdtemp(join(distDir, "public-cli-bin-startup-"));
  try {
    const buildUrl = pathToFileURL(join(packageRoot, "scripts/build-package.mjs")).href;
    const { buildPublicAkRoleBin } = (await import(buildUrl)) as {
      buildPublicAkRoleBin: (outfile?: string) => Promise<void>;
    };
    const binPath = join(binDir, "main.js");
    await buildPublicAkRoleBin(binPath);

    const env = withTestUserProfileEnv(
      isolatedTestProcessEnv({ env: process.env, home: binDir }),
      binDir,
    );
    const help = execFileSync(process.execPath, [binPath, "--help"], {
      cwd: packageRoot,
      encoding: "utf8",
      env,
    });
    assert.match(help, /ak-role — public role CLI/);

    const roles = execFileSync(process.execPath, [binPath, "roles"], {
      cwd: packageRoot,
      encoding: "utf8",
      env,
    });
    assert.match(roles, /judge\s+unconfigured/);

    const judgeHelp = execFileSync(process.execPath, [binPath, "help", "judge"], {
      cwd: packageRoot,
      encoding: "utf8",
      env,
    });
    assert.match(judgeHelp, /ak-role judge \[options\] \[instruction\]/);
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});
