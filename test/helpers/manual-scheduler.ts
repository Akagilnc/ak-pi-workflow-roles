export function manualScheduler(): {
  scheduler: { every(ms: number, tick: () => void): () => void };
  ticks: Array<() => void>;
} {
  const ticks: Array<() => void> = [];
  return {
    scheduler: {
      every(_ms, tick) {
        ticks.push(tick);
        return () => {
          const index = ticks.indexOf(tick);
          if (index >= 0) ticks.splice(index, 1);
        };
      },
    },
    ticks,
  };
}
