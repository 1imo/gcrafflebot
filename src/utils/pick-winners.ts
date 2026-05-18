export function pickRandomWinners<T>(pool: T[], count: number): T[] {
  if (pool.length === 0 || count <= 0) return [];
  const take = Math.min(count, pool.length);
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, take);
}
