/** #922 host-native method delivery. */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { hostMethodSkills } from "../../src/host-native-method.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

test("#922 Claude plugin projection keeps the bound packaged method identity", () => {
  const path = join(packageRoot, "resources/methods/tdd/SKILL.md");
  const skills = hostMethodSkills([{ kind: "skill", path }]);
  assert.deepEqual(skills, [{ name: "tdd", dir: join(packageRoot, "resources/methods/tdd"), path }]);
});
