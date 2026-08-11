import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { ensureHostPiRuntimeResolvable, HOST_PROVIDED_PACKAGES } from "../../src/public-cli/host-pi-runtime.ts";

function writePackage(dir: string, name: string, entryBody: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.1", main: "index.js" }));
  writeFileSync(join(dir, "index.js"), entryBody);
  return dir;
}

/** A fake host Pi global install: pi-coding-agent with nested pi-ai and typebox, plus a bin shim. */
function makeFakeHost(root: string): { binDir: string; codingAgentDir: string } {
  const codingAgentDir = join(root, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(codingAgentDir, "dist"), { recursive: true });
  writeFileSync(
    join(codingAgentDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.1", main: "dist/cli.js" }),
  );
  writeFileSync(join(codingAgentDir, "dist", "cli.js"), "module.exports = 'host-pi-cli';\n");
  writePackage(
    join(codingAgentDir, "node_modules", "@earendil-works", "pi-ai"),
    "@earendil-works/pi-ai",
    "module.exports = 'host-pi-ai';\n",
  );
  writePackage(join(codingAgentDir, "node_modules", "typebox"), "typebox", "module.exports = 'host-typebox';\n");
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  symlinkSync(join(codingAgentDir, "dist", "cli.js"), join(binDir, "pi"));
  return { binDir, codingAgentDir };
}

function makeBarePackageRoot(root: string): string {
  const packageRoot = join(root, "pkg");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@akagilnc/pi-workflow-roles", version: "0.0.1" }),
  );
  return packageRoot;
}

test("links every host-provided package from the host pi on PATH when local resolution fails", () => {
  const root = mkdtempSync(join(tmpdir(), "host-pi-runtime-"));
  try {
    const { binDir, codingAgentDir } = makeFakeHost(root);
    const packageRoot = makeBarePackageRoot(root);
    ensureHostPiRuntimeResolvable(packageRoot, { PATH: binDir });
    const packageRequire = createRequire(join(packageRoot, "package.json"));
    for (const name of HOST_PROVIDED_PACKAGES) {
      const entry = packageRequire.resolve(name);
      assert.ok(
        realpathSync(entry).startsWith(realpathSync(dirname(codingAgentDir))),
        `${name} must resolve into the host tree, got ${entry}`,
      );
    }
    assert.ok(
      lstatSync(join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent")).isSymbolicLink(),
      "host packages are linked, not copied",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leaves an install with locally resolvable packages untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "host-pi-runtime-"));
  try {
    const packageRoot = makeBarePackageRoot(root);
    for (const name of HOST_PROVIDED_PACKAGES) {
      writePackage(join(packageRoot, "node_modules", ...name.split("/")), name, "module.exports = 'local';\n");
    }
    ensureHostPiRuntimeResolvable(packageRoot, { PATH: "" });
    for (const name of HOST_PROVIDED_PACKAGES) {
      const linkPath = join(packageRoot, "node_modules", ...name.split("/"));
      assert.equal(lstatSync(linkPath).isSymbolicLink(), false, `${name} must stay a real local install`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails loud when neither local packages nor a host pi exist", () => {
  const root = mkdtempSync(join(tmpdir(), "host-pi-runtime-"));
  try {
    const packageRoot = makeBarePackageRoot(root);
    assert.throws(
      () => ensureHostPiRuntimeResolvable(packageRoot, { PATH: join(root, "empty-bin") }),
      /no host `pi` executable on PATH/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
