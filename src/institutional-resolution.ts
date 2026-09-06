/**
 * Province-officer model authority (#453/#620) and shared seatModelOnly projection.
 * #675 deleted the independent institutional-resolution.json seat page and the
 * child-session open path that consumed it. Seat resolution for every activation
 * is the live public seat table (model/host/engine).
 */
import type {
  GateOfficerSeat,
  PublicCliConfig,
  SeatModelConfig,
} from "./public-cli/config.ts";
import { seatModelOnly } from "./public-cli/registry.ts";

/**
 * Configured province-officer resolution (#453/#620 authority seam):
 * officer persistent > gatekeeper persistent > unconfigured.
 * No startup candidates and no parent-session fallback — direct call and config
 * display consume this typed result as-is.
 */
export type ConfiguredProvinceOfficerResolution = {
  readonly selection?: SeatModelConfig;
  readonly source: "persistent" | "inherit-gatekeeper" | "unconfigured";
};

/**
 * Authority for configured province-officer model+source (#453/#620):
 * own persistent > gatekeeper persistent > unconfigured.
 * Model-axis projection stays seatModelOnly (single implementation in registry).
 */
export function resolveConfiguredProvinceOfficer(
  config: PublicCliConfig,
  officer: GateOfficerSeat,
): ConfiguredProvinceOfficerResolution {
  const ownModel = seatModelOnly(config.seats[officer]);
  if (ownModel !== undefined) {
    return { selection: ownModel, source: "persistent" };
  }
  if (officer === "gatekeeper") {
    return { source: "unconfigured" };
  }
  const gatekeeperModel = seatModelOnly(config.seats.gatekeeper);
  if (gatekeeperModel !== undefined) {
    return { selection: gatekeeperModel, source: "inherit-gatekeeper" };
  }
  return { source: "unconfigured" };
}
