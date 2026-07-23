/**
 * Pure decision for how a diagram-open request resolves, given a profile-supplied
 * openability verdict and whether a cross-file graph-fallback handoff is available.
 *
 * Semantics (preserving the pre-SP2c behavior):
 * - `canOpen === undefined` (no profile predicate) → always `open`.
 * - `canOpen === true` → `open`.
 * - `canOpen === false` → `graph-fallback` when a handoff is available, else `text-fallback`.
 */
export type DiagramOpenDecision = 'open' | 'text-fallback' | 'graph-fallback';

export function decideDiagramOpen(
    canOpen: boolean | undefined,
    graphFallbackAvailable: boolean
): DiagramOpenDecision {
    if (canOpen === false) {
        return graphFallbackAvailable ? 'graph-fallback' : 'text-fallback';
    }
    return 'open';
}
