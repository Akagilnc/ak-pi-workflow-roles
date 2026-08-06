/**
 * Human-read formatting helpers (#162 人读格式助手).
 *
 * Presentation layer only: machine consumers bite full-precision data-* values;
 * these helpers format the same facts for human scanning (中文时长 / 紧凑 token /
 * 成本有效精度 / 本地时刻). Shared by the S1 trajectory page and the S2 board —
 * no structural change to either.
 */

/** 中文时长: two largest non-zero units (天/小时/分/秒). Non-finite/negative → 0 秒. */
export function formatDurationZh(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 秒";
  const units: Array<[number, string]> = [
    [86_400_000, "天"],
    [3_600_000, "小时"],
    [60_000, "分"],
    [1000, "秒"],
  ];
  let rest = Math.floor(ms);
  const parts: string[] = [];
  for (const [unitMs, label] of units) {
    if (parts.length === 2) break;
    const value = Math.floor(rest / unitMs);
    if (value > 0) {
      parts.push(`${value} ${label}`);
      rest -= value * unitMs;
    }
  }
  return parts.length > 0 ? parts.join(" ") : "0 秒";
}

/** 紧凑 token: exact below 1000; one-decimal k/M above (rounded). */
export function formatTokensCompact(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  const round1 = (x: number): string => {
    const r = Math.round(x * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  };
  if (tokens < 1_000_000) return `${round1(tokens / 1000)}k`;
  return `${round1(tokens / 1_000_000)}M`;
}

/** 成本有效精度: ≥100 integer, ≥1 two decimals, <1 four significant digits; zeros stripped. */
export function formatUsdPrecise(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  const abs = Math.abs(value);
  const strip = (text: string): string =>
    text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  if (abs >= 100) return String(Math.round(value));
  if (abs >= 1) return strip(value.toFixed(2));
  return String(Number(value.toPrecision(4)));
}

/** 本地时刻: local wall clock of the instant; unparseable input passes through. */
export function formatLocalDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}
