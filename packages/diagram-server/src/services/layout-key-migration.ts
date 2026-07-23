import { NodePosition } from './layout-persistence-service';

/**
 * Migrates legacy node keys in layout files.
 *
 * We historically keyed `nodes` by human-facing names (entityName / portName).
 * That breaks on rename.
 *
 * New approach: persist nodes keyed by a stable identifier (typically AST path).
 *
 * The migration is intentionally conservative:
 * - Keeps any keys we cannot map (to avoid data loss)
 * - Moves known legacy keys to stable keys
 */
export function migrateLayoutNodeKeys(
    nodes: Record<string, NodePosition>,
    legacyKeyToStableKey: Map<string, string>
): { migrated: Record<string, NodePosition>; changed: boolean } {
    const migrated: Record<string, NodePosition> = { ...nodes };
    let changed = false;

    for (const [legacyKey, stableKey] of legacyKeyToStableKey.entries()) {
        if (!legacyKey || !stableKey) {
            continue;
        }
        if (migrated[stableKey]) {
            continue; // already migrated
        }
        if (migrated[legacyKey]) {
            migrated[stableKey] = migrated[legacyKey];
            delete migrated[legacyKey];
            changed = true;
        }
    }

    // Strip the historical "$struct:" prefix if present.
    for (const key of Object.keys(migrated)) {
        if (!key.startsWith('$struct:')) {
            continue;
        }
        const stripped = key.slice('$struct:'.length);
        if (!stripped) {
            continue;
        }
        if (!migrated[stripped]) {
            migrated[stripped] = migrated[key];
        }
        delete migrated[key];
        changed = true;
    }

    return { migrated, changed };
}
