/** Random float in [min, max). */
export function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Random integer in [0, n). */
export function randIndex(n: number): number {
  return Math.floor(Math.random() * n);
}

/** Random element of a non-empty array. */
export function pick<T>(items: readonly T[]): T {
  return items[randIndex(items.length)];
}
