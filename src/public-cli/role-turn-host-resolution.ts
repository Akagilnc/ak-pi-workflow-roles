/**
 * One host-adapter table and one seat-keyed selection (#617 / ADR 0082).
 * Public CLI composition root and nested public summons share this seam —
 * the selected parent adapter is never a child-host override.
 */
import type { DurablePrincipalAuthority, RoleTurnHost } from "../host-contracts.ts";
import { packagedExternalHostNames } from "../host-descriptions.ts";
import { createPiRoleTurnHost } from "../pi/role-turn-host.ts";
import type { EffectiveSeat } from "./config.ts";
import {
  observeLaunchedRolePackageIdentity,
  recordLaunchedPiIdentity,
  recordLaunchedRolePackageIdentity,
} from "./invocation.ts";
import { createLazyProductionExternalHost } from "./load-production-external-host.ts";
import type { PublicCallableRole } from "./registry.ts";

export type HostSelectionFailure = {
  readonly kind: "host-unregistered" | "host-model-mismatch";
  readonly host: string;
  readonly seat: PublicCallableRole;
  readonly model: string;
  readonly registeredHosts: readonly string[];
};

export type NamedRoleTurnHostAdapter = {
  readonly name: string;
  readonly create: (input: { role: PublicCallableRole; model: EffectiveSeat["selection"] }) =>
    | { readonly ok: true; readonly host: RoleTurnHost }
    | { readonly ok: false };
};

export class HostSelectionError extends Error {
  constructor(readonly failure: HostSelectionFailure) {
    super(failure.kind);
  }
}

export type RoleTurnHostResolutionInput = {
  /** Pi-adapter inject (tests). Not a selected-host override. */
  readonly roleTurnHost?: RoleTurnHost;
  /** Composition-root adapter table. When omitted, pi + packaged externals. */
  readonly hostAdapters?: readonly NamedRoleTurnHostAdapter[];
  readonly packageRoot: string;
  readonly extraPiArgs?: readonly string[];
  readonly timeoutMs?: number;
};

export function composeRoleTurnHostAdapters(
  env: RoleTurnHostResolutionInput,
  principalAuthority: DurablePrincipalAuthority,
): readonly NamedRoleTurnHostAdapter[] {
  const piHost = env.roleTurnHost ?? createPiRoleTurnHost({
    packageRoot: env.packageRoot,
    principalAuthority,
    ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    recordLaunchedPiIdentity,
    recordLaunchedRolePackageIdentity,
    observeLaunchedRolePackageIdentity,
  });
  return env.hostAdapters ?? [
    { name: "pi", create: () => ({ ok: true as const, host: piHost }) },
    ...packagedExternalHostNames().map((name) => ({
      name,
      create: () => ({
        ok: true as const,
        host: createLazyProductionExternalHost({
          packageRoot: env.packageRoot,
          hostName: name,
          principalAuthority,
        }),
      }),
    })),
  ];
}

export function selectRoleTurnHost(
  adapters: readonly NamedRoleTurnHostAdapter[],
  options: {
    role: PublicCallableRole;
    seat: EffectiveSeat;
  },
): RoleTurnHost {
  const hostName = options.seat.host;
  const adapter = adapters.find((candidate) => candidate.name === hostName);
  const model = options.seat.selection === undefined
    ? "unconfigured"
    : `${options.seat.selection.provider}/${options.seat.selection.model}`;
  const registeredHosts = adapters.map(({ name }) => name);
  if (adapter === undefined) {
    throw new HostSelectionError(
      { kind: "host-unregistered", host: hostName, seat: options.role, model, registeredHosts },
    );
  }
  const selected = adapter.create({ role: options.role, model: options.seat.selection });
  if (!selected.ok) {
    throw new HostSelectionError(
      { kind: "host-model-mismatch", host: hostName, seat: options.role, model, registeredHosts },
    );
  }
  return selected.host;
}

export function resolveRoleTurnHost(
  env: RoleTurnHostResolutionInput,
  options: {
    role: PublicCallableRole;
    seat: EffectiveSeat;
    principalAuthority: DurablePrincipalAuthority;
  },
): RoleTurnHost {
  return selectRoleTurnHost(
    composeRoleTurnHostAdapters(env, options.principalAuthority),
    { role: options.role, seat: options.seat },
  );
}
