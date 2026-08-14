/**
 * Public argv grammar seams — lock launcher helpers to real CLI parsers.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  parseCoderArgv,
  parseCollectorArgv,
  parseDoctorArgv,
  parseFixerArgv,
  parseJudgeArgv,
  parseMergerArgv,
  parseReviewerArgv,
} from "../../src/public-cli/invocation.ts";
import {
  injectPublicAttachArg,
  publicCliCommandIndex,
  publicRoleAcceptsAttach,
} from "../../src/public-cli/public-argv.ts";
import { PUBLIC_CALLABLE_ROLES } from "../../src/public-cli/registry.ts";

test("publicCliCommandIndex matches real global-flag grammar", () => {
  assert.equal(publicCliCommandIndex(["judge", "x"]), 0);
  assert.equal(publicCliCommandIndex(["--model", "m", "fixer", "x"]), 2);
  assert.equal(publicCliCommandIndex(["--thinking=high", "coder"]), 1);
  assert.equal(publicCliCommandIndex(["--help", "roles"]), 1);
  assert.equal(publicCliCommandIndex(["--model", "m", "--thinking", "low", "doctor"]), 4);
  // Unknown dashed tokens are positional (same as parseArgv).
  assert.equal(publicCliCommandIndex(["--unknown", "judge"]), 0);
  assert.equal(publicCliCommandIndex(["--"]), undefined);
  assert.equal(publicCliCommandIndex(["--", "merger"]), 1);
});

test("injectPublicAttachArg inserts only for attach-capable commands", () => {
  assert.deepEqual(
    injectPublicAttachArg(["--model", "m", "judge", "--project", "/p", "go"], "/t.md"),
    ["--model", "m", "judge", "--attach", "/t.md", "--project", "/p", "go"],
  );
  assert.deepEqual(
    injectPublicAttachArg(["reviewer", "--base", "HEAD"], "/t.md"),
    ["reviewer", "--base", "HEAD"],
  );
  assert.deepEqual(injectPublicAttachArg(["roles"], "/t.md"), ["roles"]);
});

test("publicRoleAcceptsAttach tracks parse*Argv attach grammar for every public role", () => {
  const probes: Record<
    (typeof PUBLIC_CALLABLE_ROLES)[number],
    () => void
  > = {
    judge: () => {
      parseJudgeArgv(["--attach", "/t.md", "instruction"]);
    },
    coder: () => {
      parseCoderArgv(["--attach", "/t.md", "instruction"]);
    },
    fixer: () => {
      parseFixerArgv(["--attach", "/t.md", "instruction"]);
    },
    collector: () => {
      parseCollectorArgv(["--attach", "/t.md", "--pr", "1", "instruction"]);
    },
    doctor: () => {
      parseDoctorArgv(["--attach", "/t.md", "--issue", "1", "instruction"]);
    },
    merger: () => {
      parseMergerArgv(["--attach", "/t.md", "instruction"]);
    },
    reviewer: () => {
      parseReviewerArgv(["--attach", "/t.md", "--base", "HEAD"]);
    },
  };

  for (const role of PUBLIC_CALLABLE_ROLES) {
    const accepts = publicRoleAcceptsAttach(role);
    let threwAttachUnknown = false;
    try {
      probes[role]();
    } catch (error) {
      assert.ok(error instanceof CliUsageError, `${role} probe error type`);
      threwAttachUnknown =
        error.message.includes("unknown") && error.message.includes("--attach");
      if (!threwAttachUnknown) throw error;
    }
    if (accepts) {
      assert.equal(
        threwAttachUnknown,
        false,
        `${role} parser must accept --attach when publicRoleAcceptsAttach is true`,
      );
    } else {
      assert.equal(
        threwAttachUnknown,
        true,
        `${role} parser must reject --attach when publicRoleAcceptsAttach is false`,
      );
    }
  }

  assert.equal(publicRoleAcceptsAttach("roles"), false);
  assert.equal(publicRoleAcceptsAttach("not-a-role"), false);
});
