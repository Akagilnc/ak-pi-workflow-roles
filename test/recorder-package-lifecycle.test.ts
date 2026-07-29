import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  commitFile,
  initGitRepo,
  makeTempDir,
  npmPackTo,
  runRecorderBin,
  sha256File,
  writeCounterScript,
  writeRecorderConfig,
} from "./helpers/recorder-test-harness.ts";
import {
  packageRoot,
  withHermeticHome,
} from "./helpers/pi-test-harness.ts";

const exec = promisify(execFile);
const nativeBindingPath = resolve(
  packageRoot,
  "dist/recorder/rename_no_replace.node",
);
const nativeBuildScript = resolve(
  packageRoot,
  "scripts/build-rename-no-replace.mjs",
);
const nativeOutDir = resolve(packageRoot, "dist/recorder");

const SUPPORTED_OS = new Set(["darwin", "linux"]);
const SUPPORTED_CPU = new Set(["x64", "arm64"]);

function hostNativeMagic(): Buffer {
  if (process.platform === "darwin") {
    // 64-bit Mach-O little-endian magic
    return Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
  }
  if (process.platform === "linux") {
    return Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  }
  throw new Error(`unsupported test host ${process.platform}`);
}

function assertHostLoadableBinding(
  path: string,
  requireBase: string = packageRoot,
): void {
  const buf = readFileSync(path);
  const magic = hostNativeMagic();
  assert.ok(
    buf.subarray(0, magic.length).equals(magic),
    `binding at ${path} lacks host native magic (got ${buf.subarray(0, 8).toString("hex")})`,
  );
  const req = createRequire(resolve(requireBase, "package.json"));
  // Bust require cache so repeated rebuilds are observed.
  try {
    delete req.cache[path];
  } catch {
    // ignore
  }
  const binding = req(path) as {
    renameNoReplace?: unknown;
  };
  assert.equal(typeof binding.renameNoReplace, "function");
}

function gitPorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
  });
}

function assertGitClean(cwd: string, label: string): void {
  assert.equal(
    gitPorcelain(cwd),
    "",
    `${label}: expected empty git status --porcelain, got:\n${gitPorcelain(cwd)}`,
  );
}

function trackedPackagePaths(): string[] {
  const raw = execFileSync("git", ["-C", packageRoot, "ls-files", "-z"], {
    encoding: "buffer",
  }).toString("utf8");
  return raw
    .split("\0")
    .filter(Boolean)
    .filter((rel) => rel !== "dist/recorder/rename_no_replace.node");
}

async function materializeCleanPackageCheckout(dest: string): Promise<void> {
  const paths = trackedPackagePaths();
  assert.ok(
    paths.includes("scripts/rename_no_replace.c"),
    "native C source must remain tracked",
  );
  assert.ok(
    paths.includes("scripts/build-rename-no-replace.mjs"),
    "native build publisher must remain tracked",
  );
  assert.equal(
    paths.includes("dist/recorder/rename_no_replace.node"),
    false,
    "generated native binding must not be Git-owned",
  );

  for (const rel of paths) {
    const src = resolve(packageRoot, rel);
    if (!existsSync(src)) continue;
    const dst = resolve(dest, rel);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }

  execFileSync("git", ["init", "-b", "main"], { cwd: dest });
  execFileSync("git", ["config", "user.email", "lifecycle@test.local"], {
    cwd: dest,
  });
  execFileSync("git", ["config", "user.name", "Lifecycle Test"], {
    cwd: dest,
  });
  execFileSync("git", ["add", "-A"], { cwd: dest });
  execFileSync("git", ["commit", "-m", "seed clean package checkout"], {
    cwd: dest,
  });
}

function listNativeScratch(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) =>
    /^rename_no_replace\..+\.tmp\.node$/.test(name),
  );
}

function listPublishedNativeScratch(): string[] {
  // Scratch must never land under packed dist/ — only the published binding name.
  if (!existsSync(nativeOutDir)) return [];
  return readdirSync(nativeOutDir).filter(
    (name) =>
      name !== "rename_no_replace.node" &&
      name.startsWith("rename_no_replace") &&
      name.endsWith(".node"),
  );
}

test("npm pack includes recorder bin, source, schema, docs, and native build entrypoints", async () => {
  await withHermeticHome({ prefix: "ak-recorder-pack-" }, async ({ home }) => {
    const pack = JSON.parse(
      (
        await exec("npm", ["pack", "--json", "--pack-destination", home], {
          cwd: packageRoot,
        })
      ).stdout,
    ) as Array<{ filename: string; files: Array<{ path: string }> }>;
    const paths = pack[0]!.files.map((file) => file.path);
    assert.ok(paths.includes("bin/ak-docket-record.js"));
    assert.ok(paths.includes("dist/recorder/cli.js"));
    assert.ok(paths.includes("dist/recorder/run.js"));
    assert.ok(paths.includes("dist/recorder/rename_no_replace.node"));
    assert.ok(paths.includes("scripts/build-rename-no-replace.mjs"));
    assert.ok(paths.includes("scripts/rename_no_replace.c"));
    assert.ok(paths.includes("src/recorder/cli.ts"));
    assert.ok(paths.includes("src/recorder/run.ts"));
    assert.ok(paths.includes("schemas/recorder-manifest-v1.schema.json"));
    assert.ok(paths.includes("README.md"));
    assert.equal(
      paths.some(
        (path) =>
          path.includes(".native-build-staging") || path.endsWith(".tmp.node"),
      ),
      false,
      "pack must not include native build scratch",
    );
  });
});

test("package admits only supported darwin/linux x64/arm64 combinations", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  ) as { os?: string[]; cpu?: string[]; scripts?: Record<string, string> };
  assert.deepEqual(new Set(manifest.os), SUPPORTED_OS);
  assert.deepEqual(new Set(manifest.cpu), SUPPORTED_CPU);
  assert.match(String(manifest.scripts?.install ?? ""), /build-rename-no-replace/);
  assert.match(
    String(manifest.scripts?.["build:native"] ?? ""),
    /build-rename-no-replace/,
  );
  assert.ok(SUPPORTED_OS.has(process.platform), "test host OS must be admitted");
  assert.ok(SUPPORTED_CPU.has(process.arch), "test host CPU must be admitted");
  const buildSource = await readFile(nativeBuildScript, "utf8");
  assert.match(buildSource, /SUPPORTED_OS/);
  assert.match(buildSource, /SUPPORTED_CPU/);
  assert.match(buildSource, /node_api\.h/);
  assert.match(buildSource, /C compiler/);
});

test("concurrent native builds leave a loadable published binding and no scratch", async () => {
  // Enough parallelism to race publishers against loaders without starving the rest of
  // the default-concurrency suite (heavy cc storms amplify unrelated pipe flakes).
  const builders = 4;
  const loaders = 8;
  const buildOnce = () =>
    execFileSync(process.execPath, [nativeBuildScript], {
      cwd: packageRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });

  const buildPromises = Array.from({ length: builders }, async (_, index) => {
    await new Promise((r) => setTimeout(r, index * 15));
    buildOnce();
  });
  const loadPromises = Array.from({ length: loaders }, async () => {
    for (let i = 0; i < 30; i++) {
      assertHostLoadableBinding(nativeBindingPath);
      await new Promise((r) => setTimeout(r, 3));
    }
  });
  await Promise.all([...buildPromises, ...loadPromises]);
  buildOnce();
  assertHostLoadableBinding(nativeBindingPath);
  // Production readers load only the published path; scratch must never live under packed dist/.
  assert.deepEqual(
    listPublishedNativeScratch(),
    [],
    "published dist must not retain native scratch artifacts",
  );
});

test("install over stale/foreign binding rebuilds a host-loadable module", async () => {
  await withHermeticHome(
    { prefix: "ak-recorder-foreign-bind-" },
    async ({ home }) => {
      const tarball = await npmPackTo(home);
      const consumer = resolve(home, "consumer");
      await mkdir(consumer, { recursive: true });
      await writeFile(
        resolve(consumer, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: {
            "@ak/pi-workflow-roles": `file:${tarball}`,
          },
        }),
      );
      // Install without lifecycle first so we can seed a foreign artifact.
      await exec(
        "npm",
        ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: consumer, maxBuffer: 5 * 1024 * 1024 },
      );
      const installedRoot = resolve(
        consumer,
        "node_modules/@ak/pi-workflow-roles",
      );
      const installedBinding = resolve(
        installedRoot,
        "dist/recorder/rename_no_replace.node",
      );
      const foreign = Buffer.from(
        "FOREIGN_STALE_BINDING_NOT_A_HOST_NATIVE_MODULE\n",
        "utf8",
      );
      await writeFile(installedBinding, foreign);
      assert.equal(
        readFileSync(installedBinding).equals(foreign),
        true,
        "foreign seed must stick before rebuild",
      );

      // Same entrypoint as package.json "install" lifecycle (single publisher).
      await exec(
        process.execPath,
        ["scripts/build-rename-no-replace.mjs"],
        {
          cwd: installedRoot,
          maxBuffer: 5 * 1024 * 1024,
        },
      );

      assert.equal(
        readFileSync(installedBinding).equals(foreign),
        false,
        "install must replace foreign binding",
      );
      const requireInstalled = createRequire(
        resolve(installedRoot, "package.json"),
      );
      try {
        delete requireInstalled.cache[installedBinding];
      } catch {
        // ignore
      }
      const buf = readFileSync(installedBinding);
      const magic = hostNativeMagic();
      assert.ok(
        buf.subarray(0, magic.length).equals(magic),
        `installed binding lacks host magic: ${buf.subarray(0, 8).toString("hex")}`,
      );
      const binding = requireInstalled(installedBinding) as {
        renameNoReplace?: unknown;
      };
      assert.equal(typeof binding.renameNoReplace, "function");
      assert.deepEqual(
        listNativeScratch(resolve(installedRoot, ".native-build-staging")),
        [],
      );
      assert.deepEqual(
        readdirSync(resolve(installedRoot, "dist/recorder")).filter(
          (name) =>
            name.startsWith("rename_no_replace") &&
            name !== "rename_no_replace.node",
        ),
        [],
      );
    },
  );
});

test("clean checkout install/build/pack keeps generated native binding host-local and git-clean", async () => {
  await withHermeticHome(
    { prefix: "ak-recorder-native-own-" },
    async ({ home }) => {
      const checkout = resolve(home, "checkout");
      await mkdir(checkout, { recursive: true });
      await materializeCleanPackageCheckout(checkout);

      const checkoutBinding = resolve(
        checkout,
        "dist/recorder/rename_no_replace.node",
      );
      const gitignoreText = await readFile(
        resolve(checkout, ".gitignore"),
        "utf8",
      );
      assert.match(
        gitignoreText,
        /^dist\/recorder\/rename_no_replace\.node$/m,
        "exact generated binding path must be gitignored",
      );
      assert.equal(
        existsSync(checkoutBinding),
        false,
        "clean checkout must not ship a checked-in host binding",
      );
      assertGitClean(checkout, "fresh checkout");

      const tracked = execFileSync("git", ["ls-files"], {
        cwd: checkout,
        encoding: "utf8",
      });
      assert.match(tracked, /^scripts\/rename_no_replace\.c$/m);
      assert.match(tracked, /^scripts\/build-rename-no-replace\.mjs$/m);
      assert.equal(
        tracked
          .split("\n")
          .includes("dist/recorder/rename_no_replace.node"),
        false,
      );

      // Offline deps from the live package so install/prepack stay hermetic.
      await cp(resolve(packageRoot, "node_modules"), resolve(checkout, "node_modules"), {
        recursive: true,
        force: true,
      });

      // package.json "install" lifecycle = single native publisher.
      await exec(process.execPath, ["scripts/build-rename-no-replace.mjs"], {
        cwd: checkout,
        maxBuffer: 5 * 1024 * 1024,
      });
      assert.equal(existsSync(checkoutBinding), true);
      assertHostLoadableBinding(checkoutBinding, checkout);
      assertGitClean(checkout, "after install lifecycle");

      await exec("npm", ["run", "build:native"], {
        cwd: checkout,
        maxBuffer: 5 * 1024 * 1024,
      });
      assertHostLoadableBinding(checkoutBinding, checkout);
      assertGitClean(checkout, "after build:native");

      const packJson = JSON.parse(
        (
          await exec(
            "npm",
            ["pack", "--json", "--pack-destination", home],
            {
              cwd: checkout,
              maxBuffer: 10 * 1024 * 1024,
            },
          )
        ).stdout,
      ) as Array<{ filename: string; files: Array<{ path: string }> }>;
      const packPaths = packJson[0]!.files.map((file) => file.path);
      assert.ok(packPaths.includes("dist/recorder/rename_no_replace.node"));
      assert.ok(packPaths.includes("scripts/build-rename-no-replace.mjs"));
      assert.ok(packPaths.includes("scripts/rename_no_replace.c"));
      assert.equal(
        packPaths.some(
          (path) =>
            path.includes(".native-build-staging") ||
            path.endsWith(".tmp.node"),
        ),
        false,
      );
      assertHostLoadableBinding(checkoutBinding, checkout);
      assertGitClean(checkout, "after prepack/pack");

      // Repeat the authorized lifecycle; Git must stay clean every time.
      await exec(process.execPath, ["scripts/build-rename-no-replace.mjs"], {
        cwd: checkout,
        maxBuffer: 5 * 1024 * 1024,
      });
      assertGitClean(checkout, "after repeated install");
      await exec("npm", ["run", "build:native"], {
        cwd: checkout,
        maxBuffer: 5 * 1024 * 1024,
      });
      assertGitClean(checkout, "after repeated build:native");
      await exec("npm", ["pack", "--json", "--pack-destination", home], {
        cwd: checkout,
        maxBuffer: 10 * 1024 * 1024,
      });
      assertGitClean(checkout, "after repeated prepack/pack");

      const tarball = resolve(home, packJson[0]!.filename);
      const consumer = resolve(home, "consumer");
      await mkdir(consumer, { recursive: true });
      await writeFile(
        resolve(consumer, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: {
            "@ak/pi-workflow-roles": `file:${tarball}`,
          },
        }),
      );
      await exec(
        "npm",
        ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: consumer, maxBuffer: 5 * 1024 * 1024 },
      );
      const installedRoot = resolve(
        consumer,
        "node_modules/@ak/pi-workflow-roles",
      );
      const installedBinding = resolve(
        installedRoot,
        "dist/recorder/rename_no_replace.node",
      );
      const foreign = Buffer.from(
        "FOREIGN_PRODUCER_BINDING_NOT_A_HOST_NATIVE_MODULE\n",
        "utf8",
      );
      await writeFile(installedBinding, foreign);
      assert.equal(readFileSync(installedBinding).equals(foreign), true);

      // Package install lifecycle replaces a packed foreign producer binding.
      await exec(process.execPath, ["scripts/build-rename-no-replace.mjs"], {
        cwd: installedRoot,
        maxBuffer: 5 * 1024 * 1024,
      });
      assert.equal(readFileSync(installedBinding).equals(foreign), false);
      assertHostLoadableBinding(installedBinding, installedRoot);
    },
  );
});

test("installed tarball .bin proves stdin, streams, exit/signal, one-spawn, and recorder failure", async () => {
  await withHermeticHome(
    { prefix: "ak-recorder-install-" },
    async ({ home }) => {
      const tarball = await npmPackTo(home);
      const consumer = resolve(home, "consumer");
      await mkdir(consumer, { recursive: true });
      await writeFile(
        resolve(consumer, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: {
            "@ak/pi-workflow-roles": `file:${tarball}`,
          },
        }),
      );
      await exec("npm", ["install", "--omit=dev"], { cwd: consumer });
      const bin = resolve(consumer, "node_modules/.bin/ak-docket-record");
      await access(bin);
      const installedBinding = resolve(
        consumer,
        "node_modules/@ak/pi-workflow-roles/dist/recorder/rename_no_replace.node",
      );
      assertHostLoadableBinding(installedBinding);

      const workspace = makeTempDir("ak-recorder-consumer-run-");
      try {
        const archive = initGitRepo(join(workspace, "archive"));
        const authority = commitFile(archive, "authority.md", "# authority\n");
        const task = commitFile(archive, "task.md", "# task\n");
        const script = writeCounterScript(workspace);
        const counter = join(workspace, "counter.txt");
        const auth = {
          repositoryRoot: archive,
          commit: authority.commit,
          path: authority.path,
          blobOid: authority.blobOid,
          sha256: authority.sha256,
        };
        const taskRef = {
          repositoryRoot: archive,
          commit: task.commit,
          path: task.path,
          blobOid: task.blobOid,
          sha256: task.sha256,
        };

        const runInstalled = (
          docketId: string,
          childArgs: string[],
          opts: { input?: string | Buffer } = {},
        ) => {
          const configPath = writeRecorderConfig(workspace, {
            archiveRepo: archive,
            cwd: workspace,
            docketId,
            authority: auth,
            task: taskRef,
          });
          // writeRecorderConfig always uses the same filename; unique per call via rewrite is fine
          // because runs are sequential.
          return runRecorderBin(
            ["--config", configPath, "--", process.execPath, script, ...childArgs],
            {
              cwd: workspace,
              env: { ...process.env, AK_RECORDER_COUNTER: counter },
              binPath: bin,
              ...(opts.input !== undefined ? { input: opts.input } : {}),
            },
          );
        };

        // Stream separation + one-spawn happy path
        const streams = await runInstalled(
          "issues/10/apply/apply-install-streams",
          ["stdout-stderr", "from-bin"],
        );
        assert.equal(streams.code, 0);
        assert.match(streams.stdout, /OUT:from-bin/);
        assert.match(streams.stderr, /ERR:marker/);
        assert.equal((await readFile(counter, "utf8")).trim().split("\n").length, 1);
        const streamManifest = JSON.parse(
          await readFile(
            join(
              archive,
              ".ak/dockets/issues/10/apply/apply-install-streams/manifest.json",
            ),
            "utf8",
          ),
        );
        assert.equal(streamManifest.recorder.status, "completed");
        assert.equal(streamManifest.child.exitCode, 0);

        // Inherited stdin
        const stdinPayload = "stdin-from-installed-bin\n";
        const stdinResult = await runInstalled(
          "issues/10/apply/apply-install-stdin",
          ["stdin-echo"],
          { input: stdinPayload },
        );
        assert.equal(stdinResult.code, 0);
        assert.equal(stdinResult.stdout, stdinPayload);

        // Child nonzero preserved
        const nonzero = await runInstalled(
          "issues/10/apply/apply-install-exit-9",
          ["exit", "9"],
        );
        assert.equal(nonzero.code, 9);
        const nonzeroManifest = JSON.parse(
          await readFile(
            join(
              archive,
              ".ak/dockets/issues/10/apply/apply-install-exit-9/manifest.json",
            ),
            "utf8",
          ),
        );
        assert.equal(nonzeroManifest.child.exitCode, 9);
        assert.equal(nonzeroManifest.recorder.status, "completed");

        // Child signal archived then re-raised through launcher
        const signaled = await runInstalled(
          "issues/10/apply/apply-install-signal",
          ["signal", "SIGTERM"],
        );
        assert.equal(signaled.signal, "SIGTERM");
        const signalManifest = JSON.parse(
          await readFile(
            join(
              archive,
              ".ak/dockets/issues/10/apply/apply-install-signal/manifest.json",
            ),
            "utf8",
          ),
        );
        assert.equal(signalManifest.child.status, "signaled");
        assert.equal(signalManifest.child.signal, "SIGTERM");

        // Recorder failure precedence via child-created collision
        const failId = "issues/10/apply/apply-install-rec-fail";
        const dest = join(archive, ".ak/dockets", failId);
        const collide = join(workspace, "install-collide.mjs");
        await writeFile(
          collide,
          `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
process.stdout.write("install-collide-out\\n");
process.stderr.write("install-collide-err\\n");
mkdirSync(${JSON.stringify(dest)}, { recursive: true });
writeFileSync(join(${JSON.stringify(dest)}, "collision.txt"), "x\\n");
process.exit(4);
`,
        );
        const failConfig = writeRecorderConfig(workspace, {
          archiveRepo: archive,
          cwd: workspace,
          docketId: failId,
          authority: auth,
          task: taskRef,
        });
        const failed = await runRecorderBin(
          ["--config", failConfig, "--", process.execPath, collide],
          {
            cwd: workspace,
            env: { ...process.env, AK_RECORDER_COUNTER: counter },
            binPath: bin,
          },
        );
        assert.equal(failed.code, 125);
        assert.equal(failed.stdout, "install-collide-out\n");
        assert.match(failed.stderr, /^install-collide-err\n/);
        const failLines = failed.stderr.trim().split("\n");
        const failure = JSON.parse(failLines.at(-1)!);
        assert.equal(failure.recorder.status, "failed");
        assert.equal(failure.child.status, "exited");
        assert.equal(failure.child.exitCode, 4);
        assert.equal(existsSync(join(dest, "manifest.json")), false);

        // One-spawn total across successful counter uses: streams + stdin + exit + signal = 4
        // (collision script does not use counter)
        const counterText = await readFile(counter, "utf8");
        assert.equal(counterText.trim().split("\n").filter(Boolean).length, 4);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});

test("recorder modules do not import role-runtime extension surface", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = resolve(packageRoot, "src/recorder");
  const files = await readdir(dir);
  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    const text = await readFile(resolve(dir, file), "utf8");
    assert.equal(
      text.includes("role-runtime"),
      false,
      `${file} must not import role-runtime`,
    );
    assert.equal(
      text.includes("extensions/"),
      false,
      `${file} must not import extensions`,
    );
    assert.equal(
      /from ["'].*\/(worker-role|judge-role|reviewer-role|collector-role|collector-ledger|collector-receipt)/.test(
        text,
      ),
      false,
      `${file} must not import full role registration surfaces`,
    );
  }
  void sha256File;
});

test("recorder startup module graph excludes role registration/model/help", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const recorderDir = resolve(packageRoot, "src/recorder");
  const files = await readdir(recorderDir);
  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    const text = await readFile(resolve(recorderDir, file), "utf8");
    assert.equal(text.includes("role-runtime"), false, file);
    assert.equal(text.includes("souls/"), false, file);
    assert.equal(text.includes("reviewer-agent"), false, file);
    assert.equal(text.includes("collector-role"), false, file);
    assert.equal(text.includes("worker-role"), false, file);
    assert.equal(text.includes("judge-role"), false, file);
    assert.equal(text.includes("reviewer-role"), false, file);
    assert.equal(text.includes("collector-receipt"), false, file);
    assert.equal(text.includes("collector-ledger"), false, file);
  }
  const extract = await readFile(resolve(recorderDir, "extract.ts"), "utf8");
  assert.match(extract, /package-contracts\/terminating-tools/);
});
