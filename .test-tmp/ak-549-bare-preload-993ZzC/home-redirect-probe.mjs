import assert from "node:assert/strict";
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
writeFileSync(modelsPath, JSON.stringify({ providers: { poison: true } }) + "\n");
writeFileSync(join(home, sentinelName), "bare-fixture-poison");

assert.equal(existsSync(hostSentinel), false, "host sentinel must not exist");
const afterHash = existsSync(hostModels)
  ? createHash("sha256").update(readFileSync(hostModels)).digest("hex")
  : null;
assert.equal(afterHash, beforeHash);
assert.equal(readFileSync(join(home, sentinelName), "utf8"), "bare-fixture-poison");
console.log(JSON.stringify({ ok: true, home, hostHome }));
