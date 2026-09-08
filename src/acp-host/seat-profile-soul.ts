/**
 * Seat-scoped host profile soul delivery (#644 / 拍 2).
 *
 * Hermes has no per-session systemPrompt channel; identity is the profile's
 * SOUL.md. Each seat owns `profiles/<namePrefix><role>/`, and SOUL.md is a
 * symlink to the packaged `souls/<role>.md` (package is the sole soul source).
 */
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export type SeatProfileSoul = Readonly<{
  /** Argv flag selecting the profile (hermes pre-argparse `-p`). */
  flag: string;
  /** Profile id = `${namePrefix}${role}` (e.g. `ak-judge`). */
  namePrefix: string;
  /** Profile directory root relative to the operator home (`.hermes/profiles`). */
  profilesRootFromHome: readonly string[];
  /** Soul filename inside the profile directory. */
  soulFileName: string;
}>;

/** Profile id for one seat role. */
export function seatProfileName(spec: SeatProfileSoul, role: string): string {
  return `${spec.namePrefix}${role}`;
}

/** Packaged soul path for one role (`souls/<role>.md`). */
export function packageRoleSoulPath(packageRoot: string, role: string): string {
  return join(packageRoot, "souls", `${role}.md`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the seat profile directory exists and SOUL.md is a symlink to the
 * packaged role soul. On first create, copy credential surfaces from the host
 * root (parent of the profiles root) so the profile can authenticate without
 * touching the default profile in place. Returns the profile id for argv.
 */
export async function ensureSeatProfileSoul(options: {
  readonly spec: SeatProfileSoul;
  readonly operatorHome: string;
  readonly packageRoot: string;
  readonly role: string;
}): Promise<string> {
  const { spec, operatorHome, packageRoot, role } = options;
  const profileName = seatProfileName(spec, role);
  const soulTarget = resolve(packageRoleSoulPath(packageRoot, role));
  if (!(await pathExists(soulTarget))) {
    throw new Error(`packaged role soul missing: ${soulTarget}`);
  }

  const profilesRoot = join(operatorHome, ...spec.profilesRootFromHome);
  const profileDir = join(profilesRoot, profileName);
  const hostRoot = dirname(profilesRoot);
  const soulPath = join(profileDir, spec.soulFileName);

  if (!(await pathExists(profileDir))) {
    await mkdir(profileDir, { recursive: true });
    // First-create credential bootstrap only. Never rewrite an existing profile's
    // auth/config; never write into the host root / default profile.
    for (const name of ["auth.json", ".env", "config.yaml"] as const) {
      const source = join(hostRoot, name);
      if (!(await pathExists(source))) continue;
      await copyFile(source, join(profileDir, name));
    }
  } else {
    await mkdir(profileDir, { recursive: true });
  }

  const desiredLink = relative(profileDir, soulTarget);
  let current: string | undefined;
  try {
    const st = await lstat(soulPath);
    if (st.isSymbolicLink()) {
      current = await readlink(soulPath);
    }
  } catch {
    current = undefined;
  }
  if (current === desiredLink || current === soulTarget) {
    return profileName;
  }
  if (await pathExists(soulPath) || current !== undefined) {
    await unlink(soulPath);
  }
  await symlink(desiredLink, soulPath);
  return profileName;
}
