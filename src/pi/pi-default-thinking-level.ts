/**
 * Sole reader of Pi's current default thinking level for seat-omit paths (#637/#697).
 * Order matches installed Pi sdk.js: settings defaultThinkingLevel, then package
 * DEFAULT_THINKING_LEVEL. No local enum/whitelist — the package constant is loaded
 * from the installed pi-coding-agent defaults module.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

let packageDefault: string | undefined;
let packageDefaultLoading: Promise<string> | undefined;

/** Load installed Pi DEFAULT_THINKING_LEVEL exactly once. */
export async function loadPiPackageDefaultThinkingLevel(): Promise<string> {
  if (packageDefault !== undefined) return packageDefault;
  packageDefaultLoading ??= (async () => {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const href = pathToFileURL(join(dirname(entry), "core", "defaults.js")).href;
    const mod = (await import(href)) as { DEFAULT_THINKING_LEVEL: string };
    if (typeof mod.DEFAULT_THINKING_LEVEL !== "string" || mod.DEFAULT_THINKING_LEVEL.length === 0) {
      throw new Error("pi-coding-agent defaults.js missing DEFAULT_THINKING_LEVEL");
    }
    packageDefault = mod.DEFAULT_THINKING_LEVEL;
    return packageDefault;
  })();
  return packageDefaultLoading;
}

/**
 * Resolve the thinking level Pi would use when the seat omits thinking.
 * Callers pass settingsDefault when they already hold a SettingsManager;
 * otherwise agentDir/cwd loads settings the same way Pi CLI would.
 */
export async function resolvePiDefaultThinkingLevel(input?: {
  readonly settingsDefault?: string;
  readonly agentDir?: string;
  readonly cwd?: string;
}): Promise<string> {
  if (input?.settingsDefault !== undefined && input.settingsDefault.length > 0) {
    return input.settingsDefault;
  }
  if (input?.agentDir !== undefined) {
    try {
      const settings = SettingsManager.create(
        input.cwd ?? process.cwd(),
        input.agentDir,
      );
      const level = settings.getDefaultThinkingLevel();
      if (typeof level === "string" && level.length > 0) return level;
    } catch {
      // Settings unreadable → package constant (same fallback as Pi sdk).
    }
  }
  return loadPiPackageDefaultThinkingLevel();
}
