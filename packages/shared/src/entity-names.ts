/**
 * The name an entity is referred to by, without its qualification: the last
 * dotted segment, and of that the part after the last `__`
 * (`pkg.Outer__Inner` is `Inner`). The property panel and the toolkit's
 * handlers resolve a definition by this one rule.
 */
export function unqualifiedName(name: string): string {
    const afterDots = name.split('.').pop() ?? name;
    const parts = afterDots.split('__');
    return parts[parts.length - 1] ?? afterDots;
}
