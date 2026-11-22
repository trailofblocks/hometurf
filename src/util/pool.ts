/**
 * Run `worker` over `items` with at most `jobs` in flight. `shouldStart` is checked before each
 * item starts; once it returns false, remaining items are skipped.
 */
export async function runPool<T>(
  items: readonly T[],
  jobs: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStart: () => boolean = () => true,
): Promise<{ skipped: number }> {
  let next = 0;
  let skipped = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      if (!shouldStart()) {
        skipped++;
        continue;
      }
      await worker(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, lane));
  return { skipped };
}
