/**
 * Build an environment for test-owned processes without inheriting machine
 * role-ledger or Pi-home pointers. Right-hand masks survive downstream env
 * remerges; Node spawn omits undefined values.
 *
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, agentDir?: string }} [options]
 * @returns {NodeJS.ProcessEnv}
 */
export function isolatedTestProcessEnv(options = {}) {
  const env = {
    ...(options.env ?? process.env),
    AK_ROLE_RUN_DIR: undefined,
    PI_CODING_AGENT_DIR: undefined,
  };
  if (options.home !== undefined) env.HOME = options.home;
  if (options.agentDir !== undefined) env.PI_CODING_AGENT_DIR = options.agentDir;
  return env;
}
