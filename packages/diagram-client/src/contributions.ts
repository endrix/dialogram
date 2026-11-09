/**
 * How a contribution point picks among what products bound: one per key, a
 * later binding replacing an earlier one in the earlier one's place. A
 * product's feature module loads after the stock one, so it can replace a
 * stock contribution. An empty key drops the contribution.
 */
export function lastPerKey<T>(bound: readonly T[] | undefined, keyOf: (item: T) => string): T[] {
    const byKey = new Map<string, T>();
    for (const item of bound ?? []) {
        const key = keyOf(item);
        if (key) {
            byKey.set(key, item);
        }
    }
    return [...byKey.values()];
}
