// TTL duration parsing for the artifacts CLI.
//
// The Artifacts binding takes a token TTL in whole seconds. Agents
// and humans reach for unit-suffixed durations (`30s`, `5m`, `1h`),
// so the CLI accepts the common Go-style grammar and converts to
// seconds before the binding ever sees it.
//
// A bare integer keeps its historical meaning: seconds. That is the
// shape `token create --ttl 3600` documented and shipped, so it must
// not change underfoot. Only when a unit suffix is present does the
// parser interpret the units.

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/**
 * Parse a TTL into whole seconds.
 *
 * Accepts a bare positive integer (seconds) or a sequence of
 * `<integer><unit>` segments, where unit is one of `s`, `m`, `h`,
 * `d` — for example `90s`, `5m`, `1h`, `2h30m`, `1d`. Whitespace
 * around the value is ignored.
 *
 * Throws `RangeError` with a caller-facing message on anything else:
 * an empty string, a non-positive total, a fractional value, an
 * unknown unit, or a malformed segment. The CLI maps that to an
 * argv-shape error (exit 129).
 */
export function parseDuration(input: string): number {
  const raw = input.trim();
  if (raw === "") throw new RangeError("empty duration");

  // A bare integer is seconds — preserve the historical contract.
  if (/^\d+$/.test(raw)) {
    const seconds = Number.parseInt(raw, 10);
    if (seconds <= 0) throw new RangeError(`duration must be positive (got '${input}')`);
    return seconds;
  }

  // Otherwise require one or more <integer><unit> segments. No sign,
  // no decimal point — TTLs are whole seconds.
  const segment = /(\d+)([a-z])/giy;
  let total = 0;
  let consumed = 0;
  for (let match = segment.exec(raw); match !== null; match = segment.exec(raw)) {
    const [whole, digits, unit] = match;
    const factor = UNIT_SECONDS[unit.toLowerCase()];
    if (factor === undefined) {
      throw new RangeError(`unknown duration unit '${unit}' in '${input}'`);
    }
    total += Number.parseInt(digits, 10) * factor;
    consumed += whole.length;
  }
  if (consumed !== raw.length) {
    throw new RangeError(`invalid duration '${input}'`);
  }
  if (total <= 0) throw new RangeError(`duration must be positive (got '${input}')`);
  return total;
}
