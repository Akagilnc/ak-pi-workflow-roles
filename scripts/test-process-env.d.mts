export function isolatedTestProcessEnv(options?: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  agentDir?: string;
}): NodeJS.ProcessEnv;

export function applyIsolatedTestProcessEnv(options?: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  agentDir?: string;
}): void;
