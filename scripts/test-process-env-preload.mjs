/**
 * Applies isolatedTestProcessEnv() before the test framework loads (#549).
 * Imported by scripts/vitest-worker-preload.mjs — no second copy.
 */
import { applyIsolatedTestProcessEnv } from "../test/helpers/environment-fixtures.ts";

applyIsolatedTestProcessEnv();
