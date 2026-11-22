const Z95 = 1.959963984540054;

/** Wilson score interval for a binomial proportion. Well-behaved at 0/n and n/n, unlike the normal approximation. */
export function wilson(successes: number, n: number, z = Z95): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/**
 * Exact two-sided McNemar test on paired outcomes. `b` = tasks only the first setup solved,
 * `c` = tasks only the second solved. Returns the p-value.
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let logC = 0; // log C(n, 0)
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

/** Linear-interpolated quantile of an already sorted array. */
export function quantile(sorted: readonly number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

/** Half-width, in percentage points, of a 95% Wilson interval at 50% with n tasks: the coarsest it gets. */
export function worstCaseHalfWidth(n: number): number {
  const { low, high } = wilson(n / 2, n);
  return ((high - low) / 2) * 100;
}
