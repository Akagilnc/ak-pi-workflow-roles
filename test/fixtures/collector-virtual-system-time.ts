/**
 * External time fixture for public Collector missing-path tracers.
 * Patches process-global Date / hrtime so production createSystemCollectorClock
 * can reach the eligibility cutoff without a production test hook or runtime
 * entrypoint replacement. Bound on globalThis across module graphs in one process.
 */

const GLOBAL_KEY = "__akCollectorVirtualSystemTime__" as const;
const INSTALLED_KEY = "__akCollectorVirtualSystemTimeInstalled__" as const;

export type VirtualSystemTime = {
  advance(ms: number): void;
  reset(): void;
  readonly offsetMs: number;
};

type GlobalHolder = typeof globalThis & {
  [GLOBAL_KEY]?: VirtualSystemTime;
  [INSTALLED_KEY]?: true;
};

function installVirtualSystemTimePatches(getOffsetMs: () => number): void {
  const holder = globalThis as GlobalHolder;
  if (holder[INSTALLED_KEY] === true) return;
  holder[INSTALLED_KEY] = true;

  const realHrtimeBigint = process.hrtime.bigint.bind(process.hrtime);
  Object.defineProperty(process.hrtime, "bigint", {
    configurable: true,
    value: () => realHrtimeBigint() + BigInt(Math.trunc(getOffsetMs() * 1e6)),
  });

  const RealDate = Date;
  const realDateNow = RealDate.now.bind(RealDate);

  function FakeDate(this: Date, ...args: unknown[]): Date | string {
    if (new.target === undefined) {
      // `Date()` without `new` returns a string in the real platform.
      return RealDate();
    }
    if (args.length === 0) {
      return new RealDate(realDateNow() + getOffsetMs());
    }
    switch (args.length) {
      case 1:
        return new RealDate(args[0] as string | number | Date);
      case 2:
        return new RealDate(args[0] as number, args[1] as number);
      case 3:
        return new RealDate(args[0] as number, args[1] as number, args[2] as number);
      case 4:
        return new RealDate(
          args[0] as number,
          args[1] as number,
          args[2] as number,
          args[3] as number,
        );
      case 5:
        return new RealDate(
          args[0] as number,
          args[1] as number,
          args[2] as number,
          args[3] as number,
          args[4] as number,
        );
      case 6:
        return new RealDate(
          args[0] as number,
          args[1] as number,
          args[2] as number,
          args[3] as number,
          args[4] as number,
          args[5] as number,
        );
      default:
        return new RealDate(
          args[0] as number,
          args[1] as number,
          args[2] as number,
          args[3] as number,
          args[4] as number,
          args[5] as number,
          args[6] as number,
        );
    }
  }

  FakeDate.now = () => realDateNow() + getOffsetMs();
  FakeDate.parse = RealDate.parse.bind(RealDate);
  FakeDate.UTC = RealDate.UTC.bind(RealDate);
  FakeDate.prototype = RealDate.prototype;
  Object.defineProperty(FakeDate, "name", { value: "Date" });
  (globalThis as { Date: DateConstructor }).Date =
    FakeDate as unknown as DateConstructor;
}

function resolveVirtualSystemTime(): VirtualSystemTime {
  const holder = globalThis as GlobalHolder;
  if (holder[GLOBAL_KEY] !== undefined) return holder[GLOBAL_KEY];

  let offsetMs = 0;
  installVirtualSystemTimePatches(() => offsetMs);
  const api: VirtualSystemTime = {
    get offsetMs() {
      return offsetMs;
    },
    advance(ms: number) {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(`virtual system time advance requires non-negative finite ms, got ${ms}`);
      }
      offsetMs += ms;
    },
    reset() {
      offsetMs = 0;
    },
  };
  holder[GLOBAL_KEY] = api;
  return api;
}

/** Process-wide virtual system time shared by the missing-path provider fixture. */
export const collectorVirtualSystemTime = resolveVirtualSystemTime();
