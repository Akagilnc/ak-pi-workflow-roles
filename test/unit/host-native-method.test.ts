/** #922 host-native method delivery. */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  applyMethodPathBrief,
  hostMethodSkills,
} from "../../src/host-native-method.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

test("#922 non-plugin hosts receive readable absolute method paths in the brief", () => {
  const path = join(packageRoot, "resources/methods/tdd/SKILL.md");
  const skills = hostMethodSkills([{ kind: "skill", path }]);
  assert.deepEqual(skills.map((skill) => skill.path), [path]);
  assert.match(applyMethodPathBrief(skills, "assignment"), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
