/**
 * Public argv grammar seams — behavioral locks on the single production source.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  injectPublicAttachArg,
  publicCliCommandIndex,
  publicRoleAcceptsAttach,
  takePublicGlobalFlag,
} from "../../src/public-cli/public-argv.ts";

test("takePublicGlobalFlag is the sole global-flag grammar", () => {
  assert.deepEqual(takePublicGlobalFlag(["--help"], 0), {
    flag: "help",
    consume: 1,
  });
  assert.deepEqual(takePublicGlobalFlag(["-h", "roles"], 0), {
    flag: "help",
    consume: 1,
  });
  assert.deepEqual(takePublicGlobalFlag(["--model", "m", "judge"], 0), {
    flag: "model",
    consume: 2,
    value: "m",
  });
  assert.deepEqual(takePublicGlobalFlag(["--model"], 0), {
    flag: "model",
    consume: 1,
    value: undefined,
  });
  assert.deepEqual(takePublicGlobalFlag(["--model=m"], 0), {
    flag: "model",
    consume: 1,
    value: "m",
  });
  assert.deepEqual(takePublicGlobalFlag(["--thinking", "high"], 0), {
    flag: "thinking",
    consume: 2,
    raw: "high",
  });
  assert.deepEqual(takePublicGlobalFlag(["--thinking=low"], 0), {
    flag: "thinking",
    consume: 1,
    raw: "low",
  });
  // Unknown dashed tokens are not global (positional under parseArgv).
  assert.equal(takePublicGlobalFlag(["--unknown", "judge"], 0), undefined);
  assert.equal(takePublicGlobalFlag(["judge"], 0), undefined);
});

test("publicCliCommandIndex uses takePublicGlobalFlag grammar", () => {
  assert.equal(publicCliCommandIndex(["judge", "x"]), 0);
  assert.equal(publicCliCommandIndex(["--model", "m", "fixer", "x"]), 2);
  assert.equal(publicCliCommandIndex(["--thinking=high", "coder"]), 1);
  assert.equal(publicCliCommandIndex(["--help", "roles"]), 1);
  assert.equal(
    publicCliCommandIndex(["--model", "m", "--thinking", "low", "doctor"]),
    4,
  );
  assert.equal(publicCliCommandIndex(["--unknown", "judge"]), 0);
  assert.equal(publicCliCommandIndex(["--"]), undefined);
  assert.equal(publicCliCommandIndex(["--", "merger"]), 1);
});

test("injectPublicAttachArg inserts only when role argv accepts --attach", () => {
  assert.deepEqual(
    injectPublicAttachArg(
      ["--model", "m", "judge", "--project", "/p", "go"],
      "/t.md",
    ),
    ["--model", "m", "judge", "--attach", "/t.md", "--project", "/p", "go"],
  );
  assert.deepEqual(
    injectPublicAttachArg(["reviewer", "--base", "HEAD"], "/t.md"),
    ["reviewer", "--base", "HEAD"],
  );
  assert.deepEqual(injectPublicAttachArg(["roles"], "/t.md"), ["roles"]);
});

test("publicRoleAcceptsAttach derives from production parse*Argv contracts", () => {
  assert.equal(publicRoleAcceptsAttach("judge"), true);
  assert.equal(publicRoleAcceptsAttach("coder"), true);
  assert.equal(publicRoleAcceptsAttach("fixer"), true);
  assert.equal(publicRoleAcceptsAttach("collector"), true);
  assert.equal(publicRoleAcceptsAttach("doctor"), true);
  assert.equal(publicRoleAcceptsAttach("merger"), true);
  assert.equal(publicRoleAcceptsAttach("reviewer"), false);
  assert.equal(publicRoleAcceptsAttach("roles"), false);
  assert.equal(publicRoleAcceptsAttach("not-a-role"), false);
});
