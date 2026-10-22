/**
 * Bare `node --test` entry preload (#549). Same true source as
 * isolatedTestProcessEnv() used by scripts/run-test-all.mjs — no second copy.
 */
import { applyIsolatedTestProcessEnv } from "../test/helpers/environment-fixtures.ts";

applyIsolatedTestProcessEnv();
