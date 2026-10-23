// Each fork owns its default home and exit cleanup, before test modules load.
import { syncBuiltinESMExports } from "node:module";
import { applyIsolatedTestProcessEnv } from "../test/helpers/environment-fixtures.ts";

applyIsolatedTestProcessEnv();
process.env.AK_TEST_USER_PROFILE_HOME = process.env.HOME;
await import("./test-user-profile-preload.cjs");
syncBuiltinESMExports();
