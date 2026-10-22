import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withTestUserProfileEnv } from "../helpers/public-cli-subprocess.ts";
import { isolatedTestProcessEnv } from "../helpers/test-process-fixtures.ts";
import { packageMachineHome, resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";

// Expand phase: retain the same case under both native runners (#1245).
const test: (name: string, fn: () => void | Promise<void>) => void = process.env.VITEST
  ? (await import("vitest")).test
  : (await import("node:test")).test;

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

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

    const home = process.env.VITEST ? process.env.HOME! : binDir;
    if (process.env.VITEST) {
      // Fail before any default-home write if the worker preload is missing.
      assert.equal(dirname(home), packageRoot);
      assert.equal(packageMachineHome(), home);
      assert.ok(process.env.AK_TEST_REAL_MACHINE_HOME);
      assert.notEqual(home, process.env.AK_TEST_REAL_MACHINE_HOME);
      assert.equal(resolveActivationLedgerHome(), join(home, ".ak-roles"));
      assert.equal(process.env.XDG_CONFIG_HOME, join(home, ".config"));
      assert.equal(process.env.XDG_DATA_HOME, join(home, ".local", "share"));
      assert.equal(process.env.XDG_CACHE_HOME, join(home, ".cache"));
      for (const key of ["AK_ROLE_RUN_DIR", "AK_ROLE_COURT_ATTEMPT", "PI_CODING_AGENT_DIR", "AK_ROLE_ENGINE", "AK_ROLE_RECEIPT_DELIVERY_LIMIT"]) {
        assert.equal(process.env[key], undefined);
      }
    }
    const result = await runAkRole(["config", "set", "coder", "xai/grok-4.5"], {
      // node:test has no worker profile; its caller-owned home stays explicit.
      ...(process.env.VITEST ? {} : { home }),
      packageRoot,
      io: { stdout() {}, stderr() {} },
    });
    assert.equal(result.exitCode, 0);
    const configPath = join(home, ".ak-roles", "public-cli.json");
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).seats.coder, {
      provider: "xai", model: "grok-4.5",
    });

    const env = withTestUserProfileEnv(
      isolatedTestProcessEnv({ env: process.env, home }),
      home,
    );
    execFileSync(process.execPath, [binPath, "config", "set", "coder", "xai/grok-4.5:high"], {
      cwd: packageRoot,
      env,
    });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).seats.coder, {
      provider: "xai", model: "grok-4.5", thinking: "high",
    });
    execFileSync(process.execPath, [binPath, "--help"], {
      cwd: packageRoot,
      env,
    });

    execFileSync(process.execPath, [binPath, "roles"], {
      cwd: packageRoot,
      env,
    });

    execFileSync(process.execPath, [binPath, "help", "judge"], {
      cwd: packageRoot,
      env,
    });
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});
