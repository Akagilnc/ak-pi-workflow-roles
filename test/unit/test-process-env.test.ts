/**
 * Owning seam for scripts/test-process-env.mjs — #549 HOME/XDG default redirect.
 * Proves default isolation, explicit home priority, host-write negative, and bare
 * entry preload wiring. Does not exercise production code.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  isolatedTestProcessEnv,
} from "../../scripts/test-process-env.mjs";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";
import { runTestSubprocess } from "../helpers/test-subprocess.ts";

const HOST_HOME = userInfo().homedir;
const PRELOAD = resolve(packageRoot, "scripts/test-process-env-preload.mjs");

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hostModelsPath(): string {
  return join(HOST_HOME, ".pi", "agent", "models.json");
}

function readHostModelsHash(): string | null {
  const path = hostModelsPath();
  if (!existsSync(path)) return null;
  return sha256(readFileSync(path));
}

/** AC5: explicit options.home wins over default and over env.HOME. */
test("isolatedTestProcessEnv: options.home wins over default and env.HOME", () => {
  const custom = mkdtempSync(join(tmpdir(), "ak-549-explicit-home-"));
  try {
    const env = isolatedTestProcessEnv({
      env: { ...process.env, HOME: HOST_HOME },
      home: custom,
    });
    assert.equal(env.HOME, custom);
    assert.equal(env.XDG_CONFIG_HOME, join(custom, ".config"));
    assert.equal(env.XDG_DATA_HOME, join(custom, ".local", "share"));
    assert.equal(env.XDG_CACHE_HOME, join(custom, ".cache"));
    assert.equal(env.AK_ROLE_RUN_DIR, undefined);
    assert.equal(env.PI_CODING_AGENT_DIR, undefined);
  } finally {
    rmSync(custom, { recursive: true, force: true });
  }
});

/** AC default: no options.home → HOME/XDG leave the host home. */
test("isolatedTestProcessEnv: default HOME/XDG leave the host home", () => {
  const env = isolatedTestProcessEnv({
    env: { ...process.env, HOME: HOST_HOME },
  });
  assert.notEqual(env.HOME, HOST_HOME);
  assert.ok(typeof env.HOME === "string" && env.HOME.length > 0);
  assert.equal(env.XDG_CONFIG_HOME, join(env.HOME!, ".config"));
  assert.equal(env.XDG_DATA_HOME, join(env.HOME!, ".local", "share"));
  assert.equal(env.XDG_CACHE_HOME, join(env.HOME!, ".cache"));
  // Default home is stable within the process.
  const again = isolatedTestProcessEnv();
  assert.equal(again.HOME, env.HOME);
});

/**
 * AC3 negative tracer (write + host sentinel, same root):
 * Without explicit agentDir, $HOME-resolved models.json and a HOME-relative
 * sentinel both land under the redirected home; host models.json hash and the
 * absolute host sentinel stay unchanged.
 */
test("isolatedTestProcessEnv: $HOME writes miss host models.json and host sentinel", () => {
  const env = isolatedTestProcessEnv({
    env: { ...process.env, HOME: HOST_HOME },
  });
  assert.notEqual(env.HOME, HOST_HOME);

  const beforeHash = readHostModelsHash();
  const sentinelName = `.ak-549-sentinel-${process.pid}-${Date.now()}`;
  const hostSentinel = join(HOST_HOME, sentinelName);
  const sentinelBody = `host-sentinel-body-${process.pid}`;
  writeFileSync(hostSentinel, sentinelBody, "utf8");

  try {
    const redirectedModels = join(env.HOME!, ".pi", "agent", "models.json");
    mkdirSync(dirname(redirectedModels), { recursive: true });
    writeFileSync(
      redirectedModels,
      `${JSON.stringify({ providers: { "openai-codex": { baseUrl: "http://127.0.0.1:9" } } })}\n`,
      "utf8",
    );
    writeFileSync(join(env.HOME!, sentinelName), "fixture-poison-sentinel", "utf8");

    assert.equal(
      readFileSync(hostSentinel, "utf8"),
      sentinelBody,
      "host sentinel content must be unchanged",
    );
    assert.equal(
      readHostModelsHash(),
      beforeHash,
      "host ~/.pi/agent/models.json hash must be unchanged",
    );
    assert.equal(
      readFileSync(join(env.HOME!, sentinelName), "utf8"),
      "fixture-poison-sentinel",
    );
    assert.ok(existsSync(redirectedModels));
  } finally {
    rmSync(hostSentinel, { force: true });
    // Do not rm the process-wide defaultTestHome; only the host sentinel.
  }
});

const BARE_ENTRY_SCRIPTS = [
  "test",
  "test:fast",
  "test:integration",
  "test:adjudication",
] as const;

const PRELOAD_IMPORT = "--import ./scripts/test-process-env-preload.mjs";

/** package.json bare entries share the preload true source (Scope 2 / residual ①). */
test("package.json bare test entries preload test-process-env-preload.mjs", async () => {
  const pkg = JSON.parse(
    await readFileSync(resolve(packageRoot, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };

  for (const name of BARE_ENTRY_SCRIPTS) {
    const script = pkg.scripts[name];
    assert.ok(typeof script === "string", `${name} script must exist`);
    assert.ok(
      script.includes(PRELOAD_IMPORT),
      `${name} must --import the HOME redirect preload (got: ${script})`,
    );
    assert.ok(
      script.includes("--import tsx"),
      `${name} keeps tsx import`,
    );
    assert.equal(
      script.includes("run-test-all"),
      false,
      `${name} must remain a bare node --test entry`,
    );
  }
});

/**
 * AC4 bare-entry negative: same write/sentinel proof under the preload import
 * chain the bare npm scripts use (not via run-test-all.mjs).
 */
test("bare preload entry: $HOME writes miss host models.json and host sentinel", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "ak-549-bare-entry-"));
  await withPrimaryAwareCleanup(
    async () => {
      const beforeHash = readHostModelsHash();
      const sentinelName = `.ak-549-bare-sentinel-${process.pid}-${Date.now()}`;
      const hostSentinel = join(HOST_HOME, sentinelName);
      const sentinelBody = `bare-host-sentinel-${process.pid}`;
      writeFileSync(hostSentinel, sentinelBody, "utf8");

      const probe = join(workspace, "home-redirect-probe.mjs");
      writeFileSync(
        probe,
        `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

const hostHome = userInfo().homedir;
const home = process.env.HOME;
assert.ok(home && home !== hostHome, "HOME must be redirected by preload");
assert.equal(process.env.XDG_CONFIG_HOME, join(home, ".config"));
assert.equal(process.env.PI_CODING_AGENT_DIR, undefined);

const sentinelName = process.env.AK_549_SENTINEL_NAME;
const hostSentinel = join(hostHome, sentinelName);
const beforeHash = process.env.AK_549_BEFORE_HASH === "" ? null : process.env.AK_549_BEFORE_HASH;
const hostModels = join(hostHome, ".pi", "agent", "models.json");

const modelsPath = join(home, ".pi", "agent", "models.json");
mkdirSync(dirname(modelsPath), { recursive: true });
writeFileSync(modelsPath, JSON.stringify({ providers: { poison: true } }) + "\\n");
writeFileSync(join(home, sentinelName), "bare-fixture-poison");

assert.equal(readFileSync(hostSentinel, "utf8"), process.env.AK_549_SENTINEL_BODY);
const afterHash = existsSync(hostModels)
  ? createHash("sha256").update(readFileSync(hostModels)).digest("hex")
  : null;
assert.equal(afterHash, beforeHash);
console.log(JSON.stringify({ ok: true, home, hostHome }));
`,
        "utf8",
      );

      try {
        const result = await runTestSubprocess(
          process.execPath,
          ["--import", PRELOAD, probe],
          {
            cwd: packageRoot,
            env: {
              ...process.env,
              // Start from host HOME so the preload must do the redirect.
              HOME: HOST_HOME,
              AK_549_SENTINEL_NAME: sentinelName,
              AK_549_SENTINEL_BODY: sentinelBody,
              AK_549_BEFORE_HASH: beforeHash ?? "",
            },
            owner: "bare-preload-home-redirect",
            timeoutMs: 15_000,
          },
        );
        assert.equal(
          result.code,
          0,
          `preload probe failed: stderr=${result.stderr}\nstdout=${result.stdout}`,
        );
        assert.equal(
          readFileSync(hostSentinel, "utf8"),
          sentinelBody,
          "host sentinel must survive bare-entry fixture writes",
        );
        assert.equal(readHostModelsHash(), beforeHash);
      } finally {
        rmSync(hostSentinel, { force: true });
      }
    },
    async () => {
      rmSync(workspace, { recursive: true, force: true });
    },
  );
});
