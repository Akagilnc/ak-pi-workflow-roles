import { rm } from "node:fs/promises";
import { afterAll } from "vitest";
import { applyIsolatedTestProcessEnv } from "../scripts/test-process-env.mjs";
import { withTestUserProfileEnv } from "./helpers/public-cli-subprocess.ts";

// Reuse the preloaded fork's home, and scrub all role-envelope injections.
const home = process.env.AK_TEST_USER_PROFILE_HOME!;
applyIsolatedTestProcessEnv({ home });
// Fork teardown may terminate the process without Node's exit event.
afterAll(() => rm(home, { recursive: true, force: true }));
// Children inherit the same userInfo preload; per-case callers can override home.
Object.assign(process.env, withTestUserProfileEnv(process.env, process.env.HOME!));
