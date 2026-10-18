/**
 * One seat-runtime assembly for the public CLI and nested summons.
 * Order is host selection, the caller's argv parse, the missing-model fact,
 * then host-facing provider projection. Callers own how a missing model is shown.
 */
import { pickEngineAxis } from "../package-resources/engine-material.ts";
import { createNavigatorLookupHost, NAVIGATOR_LOOKUP_HOST } from "../navigator-lookup-host.ts";
import { isNavigatorSeat } from "../packaged-role-registry.ts";
import type { DurablePrincipalAuthority, RoleTurnHost } from "../host-contracts.ts";
import {
  resolvedSeatWithModel,
  type EffectiveSeat,
  type SeatModelConfig,
} from "./config.ts";
import {
  loadHostProvidersTable,
  projectHostFacingProvider,
} from "./host-providers.ts";
import {
  composeRoleTurnHostAdapters,
  selectRoleTurnHost,
  type NamedRoleTurnHostAdapter,
  type RoleTurnHostResolutionInput,
} from "./role-turn-host-resolution.ts";
import type { PublicCallableRole } from "./registry.ts";

export type OpenedRoleSeatRuntime =
  | { readonly ok: false }
  | {
      readonly ok: true;
      readonly roleTurnHost: RoleTurnHost;
      readonly hostAdapters: readonly NamedRoleTurnHostAdapter[];
      readonly model?: SeatModelConfig;
      readonly engine?: string;
      readonly engineModel?: string;
      readonly host: string;
    };

export function openRoleSeatRuntime(input: {
  readonly resolution: RoleTurnHostResolutionInput;
  readonly principalAuthority: DurablePrincipalAuthority;
  readonly role: PublicCallableRole;
  readonly seat: EffectiveSeat;
  readonly home: string;
  readonly afterHost?: () => void;
  /** Already host-facing. A second projection would rename the provider again. */
  readonly hostFacingModel?: SeatModelConfig;
}): OpenedRoleSeatRuntime {
  // #1192: the navigator is a table lookup, not a model seat. Its seat axes
  // (model / host / engine) are accepted and never consulted, so a mismatched
  // or absent pair cannot stop it and no host session is started.
  if (isNavigatorSeat(input.role)) {
    input.afterHost?.();
    return {
      ok: true,
      roleTurnHost: createNavigatorLookupHost(),
      hostAdapters: [],
      host: NAVIGATOR_LOOKUP_HOST,
    };
  }
  const hostAdapters = composeRoleTurnHostAdapters(
    input.resolution,
    input.principalAuthority,
  );
  const roleTurnHost = selectRoleTurnHost(hostAdapters, {
    role: input.role,
    seat: input.seat,
  });
  input.afterHost?.();
  const seatWithModel = resolvedSeatWithModel(input.seat);
  if (seatWithModel === undefined) return { ok: false };
  const projected = input.hostFacingModel ?? projectHostFacingProvider(
    seatWithModel.selection,
    seatWithModel.host,
    loadHostProvidersTable(input.home),
    input.home,
  );
  return {
    ok: true,
    roleTurnHost,
    hostAdapters,
    ...(projected === undefined ? {} : { model: projected }),
    ...pickEngineAxis(seatWithModel),
    host: seatWithModel.host,
  };
}
