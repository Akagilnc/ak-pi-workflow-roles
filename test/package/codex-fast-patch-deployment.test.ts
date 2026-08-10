import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";

import { withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";
import { getSharedIsolatedPack } from "../helpers/pi-test-harness.ts";

const execFileAsync = promisify(execFile);
const PI_AI_VERSION = "0.84.1";
const PATCHED_RELATIVE = "dist/api/openai-codex-responses.js";

async function createPristinePiHost(root: string): Promise<{
  piBin: string;
  piAiRoot: string;
}> {
  const codingRoot = resolve(root, "pi-coding-agent");
  await mkdir(resolve(codingRoot, "dist"), { recursive: true });
  await writeFile(
    resolve(codingRoot, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: PI_AI_VERSION,
      private: true,
      dependencies: { "@earendil-works/pi-ai": PI_AI_VERSION },
    }),
  );
  await execFileAsync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: codingRoot, maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
  );
  const cli = resolve(codingRoot, "dist/cli.js");
  await writeFile(cli, "#!/usr/bin/env node\n", "utf8");
  const binDir = resolve(root, "bin");
  await mkdir(binDir, { recursive: true });
  const piBin = resolve(binDir, "pi");
  await symlink(cli, piBin);
  return {
    piBin,
    piAiRoot: resolve(
      codingRoot,
      "node_modules/@earendil-works/pi-ai",
    ),
  };
}

async function installDeploymentCli(root: string): Promise<string> {
  const pack = await getSharedIsolatedPack();
  const consumer = resolve(root, "consumer");
  await mkdir(consumer, { recursive: true });
  await writeFile(
    resolve(consumer, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: {
        "@akagilnc/pi-workflow-roles": `file:${pack.tarball}`,
      },
    }),
  );
  await execFileAsync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer, maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
  );
  const bin = resolve(
    consumer,
    "node_modules/.bin/ak-deploy-codex-fast-patch",
  );
  await access(bin);
  return bin;
}

async function runDeployment(bin: string, piBin: string) {
  const path = `${dirname(piBin)}:${process.env.PATH ?? ""}`;
  try {
    const result = await execFileAsync(bin, [], {
      env: { ...process.env, PATH: path },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? failed.message,
    };
  }
}

async function observeWireBehavior(piAiRoot: string, home: string) {
  const oldHome = process.env.HOME;
  const oldFetch = globalThis.fetch;
  const oldError = console.error;
  process.env.HOME = home;
  const requests: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = init?.body;
    const bodyText = body instanceof Uint8Array
      ? zstdDecompressSync(body).toString("utf8")
      : String(body);
    requests.push(JSON.parse(bodyText) as Record<string, unknown>);
    return new Response(JSON.stringify({ error: { message: "offline probe" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const { stream } = await import(
      `${resolve(piAiRoot, PATCHED_RELATIVE)}?wire=${Date.now()}`
    );
    const model = {
      id: "gpt-5.3-codex",
      name: "offline",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://example.invalid/backend-api",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    };
    const context = {
      systemPrompt: "offline",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "probe" }],
          timestamp: Date.now(),
        },
      ],
      tools: [],
    };
    const run = async (switchBytes: string | undefined, serviceTier?: string) => {
      const switchPath = resolve(home, ".pi-codex-fast");
      if (switchBytes === undefined) await unlink(switchPath).catch(() => undefined);
      else await writeFile(switchPath, switchBytes, "utf8");
      const beforeRequests = requests.length;
      const beforeLogs = logs.length;
      const tokenPayload = Buffer.from(JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "offline-account" },
      })).toString("base64url");
      const streamEvents = stream(model, context, {
        apiKey: `x.${tokenPayload}.x`,
        transport: "sse",
        ...(serviceTier === undefined ? {} : { serviceTier }),
      });
      const observedEvents: unknown[] = [];
      for await (const event of streamEvents) {
        observedEvents.push(event);
      }
      const request = requests[beforeRequests];
      assert.ok(request, JSON.stringify(observedEvents));
      return {
        request,
        logs: logs.slice(beforeLogs),
      };
    };
    return {
      on: await run("fast_mode = on\n"),
      off: await run("fast_mode = off\n"),
      conflicting: await run("fast_mode = on\nfast_mode = off\n"),
      missing: await run(undefined),
      flex: await run("fast_mode = on\n", "flex"),
    };
  } finally {
    globalThis.fetch = oldFetch;
    console.error = oldError;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
}

test("packed deployment CLI applies the 0.84.1 patch idempotently, rejects unknown bytes, and changes only eligible wire requests", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ak-fast-patch-deploy-"));
  await withPrimaryAwareCleanup(
    async () => {
      const bin = await installDeploymentCli(root);
      const pristine = await createPristinePiHost(resolve(root, "pristine"));
      const first = await runDeployment(bin, pristine.piBin);
      assert.equal(first.code, 0, first.stderr);
      assert.match(first.stdout, /applied/i);
      const patchedBytes = await readFile(
        resolve(pristine.piAiRoot, PATCHED_RELATIVE),
        "utf8",
      );
      assert.equal(patchedBytes.includes("codexFastSwitchEnabled"), true);

      const second = await runDeployment(bin, pristine.piBin);
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /already applied/i);

      const wrong = await createPristinePiHost(resolve(root, "wrong"));
      const wrongPath = resolve(wrong.piAiRoot, PATCHED_RELATIVE);
      await writeFile(
        wrongPath,
        (await readFile(wrongPath, "utf8")).replace(
          "const _os = loadNodeOs();",
          "const _os = null;",
        ),
        "utf8",
      );
      const rejected = await runDeployment(bin, wrong.piBin);
      assert.notEqual(rejected.code, 0);
      assert.match(rejected.stderr, /unknown.*bytes|neither pristine nor already applied/i);
      assert.equal(
        (await readFile(wrongPath, "utf8")).includes("codexFastSwitchEnabled"),
        false,
      );

      const home = resolve(root, "wire-home");
      await mkdir(home, { recursive: true });
      const wire = await observeWireBehavior(pristine.piAiRoot, home);
      assert.equal(wire.on.request.service_tier, "priority");
      assert.deepEqual(wire.on.logs, [
        "[ak-patch] codex fast: service_tier=priority (switch enabled)",
      ]);
      for (const result of [wire.off, wire.conflicting, wire.missing]) {
        assert.equal(Object.hasOwn(result.request, "service_tier"), false);
        assert.deepEqual(result.logs, []);
      }
      assert.equal(wire.flex.request.service_tier, "flex");
      assert.deepEqual(wire.flex.logs, []);
    },
    async () => {
      await rm(root, { recursive: true, force: true });
    },
  );
});
