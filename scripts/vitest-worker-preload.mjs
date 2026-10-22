// Each fork owns its default home and exit cleanup, before test modules load.
import { syncBuiltinESMExports } from "node:module";
import "./test-process-env-preload.mjs";

process.env.AK_TEST_USER_PROFILE_HOME = process.env.HOME;
await import("./test-user-profile-preload.cjs");
syncBuiltinESMExports();
