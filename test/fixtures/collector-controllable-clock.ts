/**
 * Shared controllable Collector clock for public missing-path tracers.
 * Advance between model turns so eligibility cutoff is reachable without wall wait.
 *
 * Bound on globalThis so runtime + provider fixtures share one instance even when
 * Pi loads the two -e graphs as separate module evaluations of this file.
 */
import type { CollectorClock } from "../../src/collector-evidence.ts";

export type ControllableCollectorClock = CollectorClock & {
  advance(ms: number): void;
  reset(): void;
  readonly id: string;
};

const GLOBAL_KEY = "__akCollectorPublicTracerClock__" as const;

type GlobalClockHolder = typeof globalThis & {
  [GLOBAL_KEY]?: ControllableCollectorClock;
};

function createControllableCollectorClock(
  startWall: string = "2026-01-01T00:00:00.000Z",
): ControllableCollectorClock {
  const origin = new Date(startWall);
  const id = "collector-public-tracer-clock";
  let mono = 0;
  let wall = new Date(origin);
  return {
    id,
    wallNow: () => new Date(wall),
    monoNow: () => mono,
    async sleep(ms) {
      mono += ms;
      wall = new Date(wall.getTime() + ms);
    },
    advance(ms) {
      mono += ms;
      wall = new Date(wall.getTime() + ms);
    },
    reset() {
      mono = 0;
      wall = new Date(origin);
    },
  };
}

function resolveSharedClock(): ControllableCollectorClock {
  const holder = globalThis as GlobalClockHolder;
  if (holder[GLOBAL_KEY] === undefined) {
    holder[GLOBAL_KEY] = createControllableCollectorClock();
  }
  return holder[GLOBAL_KEY];
}

/** Process-wide clock instance shared by runtime + provider fixtures. */
export const collectorPublicTracerClock = resolveSharedClock();
