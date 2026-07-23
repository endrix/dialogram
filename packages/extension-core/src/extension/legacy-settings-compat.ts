/**
 * Legacy-settings compatibility shim — THE ONLY module allowed to name the old
 * `workflow.*` setting/state keys.
 *
 * Task 4 renamed the core-owned settings and persistent-state keys to the neutral
 * `dialogram.*` namespace. To keep existing user settings and persisted state
 * working across the rename, every renamed key is read through one of the helpers
 * below, which fall back to the pre-rename key exactly once (and, for persistent
 * state, write the value through to the new key so the fallback is not needed a
 * second time). No other file may contain a `workflow.*` literal; keeping them all
 * here makes the migration surface auditable and removable in one place later.
 */

import * as vscode from 'vscode';

/** New (neutral) key -> legacy (`workflow.*`) key, for every migrated identifier. */
export const LEGACY_KEYS = {
    /** Chat settings section (VS Code configuration). */
    chatSection: { current: 'dialogram.chat', legacy: 'workflow.chat' },
    /** Per-workflow ACP session list (workspaceState). */
    sessions: { current: 'dialogram.sessions', legacy: 'workflow.sessions' },
    /** Last-selected chat model (workspaceState). */
    preferredModel: { current: 'dialogram.chat.preferredModel', legacy: 'workflow.chat.preferredModel' },
} as const;

/**
 * Read a chat setting, preferring the neutral `dialogram.chat.<key>` and falling
 * back to the legacy `workflow.chat.<key>` when the neutral one is unset. VS Code
 * `get` returns `defaultValue` when a key is absent, so "unset" is detected by
 * inspecting the configuration's `inspect()` rather than the resolved value.
 */
export function getChatSetting<T>(key: string, defaultValue: T): T {
    const current = vscode.workspace.getConfiguration(LEGACY_KEYS.chatSection.current);
    // `inspect()` distinguishes "user set the neutral key" from "manifest default".
    // Some environments (test config mocks) expose only `get()`; fall back to a plain
    // read of the neutral namespace there.
    if (typeof current.inspect !== 'function') {
        return current.get<T>(key, defaultValue);
    }
    if (isExplicitlySet(current.inspect<T>(key))) {
        return current.get<T>(key, defaultValue);
    }
    // Neutral key unset: honour a legacy value if the user still has one.
    const legacy = vscode.workspace.getConfiguration(LEGACY_KEYS.chatSection.legacy);
    if (typeof legacy.inspect === 'function' && isExplicitlySet(legacy.inspect<T>(key))) {
        return legacy.get<T>(key, defaultValue);
    }
    return current.get<T>(key, defaultValue);
}

function isExplicitlySet<T>(
    inspected: { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined,
): boolean {
    return (
        inspected !== undefined &&
        (inspected.globalValue !== undefined ||
            inspected.workspaceValue !== undefined ||
            inspected.workspaceFolderValue !== undefined)
    );
}

/** Minimal Memento-shaped storage (matches {@link vscode.Memento} and SessionManager's WorkspaceStorage). */
export interface MigratableStorage {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
}

/**
 * Read a persisted value by its neutral key, migrating a legacy value once. If the
 * neutral key is empty (deep-equals `defaultValue`) but the legacy key holds a
 * value, that value is written through to the neutral key and returned. Confining
 * this to the compat module keeps the sole legacy-key reference here.
 */
export async function readStateWithMigration<T>(
    storage: MigratableStorage,
    newKey: string,
    oldKey: string,
    defaultValue: T,
): Promise<T> {
    const current = storage.get<T>(newKey, defaultValue);
    if (!isDefault(current, defaultValue)) {
        return current;
    }
    const legacy = storage.get<T>(oldKey, defaultValue);
    if (isDefault(legacy, defaultValue)) {
        return current;
    }
    await storage.update(newKey, legacy);
    return legacy;
}

/**
 * Synchronous read-with-fallback for callers that must not await (e.g. a value
 * read on a hot/sync path). Returns the neutral value if present, else the legacy
 * value, writing it through to the neutral key once (fire-and-forget, so the
 * caller is not blocked). Confined here so the legacy key is named only in this file.
 */
export function readStateWithFallback<T>(
    storage: MigratableStorage,
    newKey: string,
    oldKey: string,
    defaultValue: T,
): T {
    const current = storage.get<T>(newKey, defaultValue);
    if (!isDefault(current, defaultValue)) {
        return current;
    }
    const legacy = storage.get<T>(oldKey, defaultValue);
    if (isDefault(legacy, defaultValue)) {
        return current;
    }
    void storage.update(newKey, legacy);
    return legacy;
}

function isDefault<T>(value: T, defaultValue: T): boolean {
    if (value === defaultValue) {
        return true;
    }
    if (Array.isArray(value) && Array.isArray(defaultValue)) {
        return value.length === 0 && defaultValue.length === 0;
    }
    return value === undefined || value === null;
}
