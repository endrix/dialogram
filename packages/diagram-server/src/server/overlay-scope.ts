/**
 * The run records a view of one workflow instance reads.
 *
 * A run records, for every edge of every workflow instance, the token it last
 * carried (`run.wf-viewer.json`) and, at each step, its queue
 * (`run.wf-queues.json`). Two instances of one workflow wire the same names,
 * and so can two workflows, so their records answer to the same signature
 * (`p|Out|WF|Out`). Each record of a nested instance says which instance it is
 * in (`instancePath`, instance names from the run's root; a record of the
 * root's own says none), and a view reads only its instance's records. A
 * nested record's key starts with that path (`a/i/<astPath>`,
 * `queue:a/i/<queueId>`); the start is taken off, so the instance's edges find
 * the record under their own AST paths.
 *
 * A run none of whose records says an instance has no nested workflow, or was
 * written by a runtime that did not say them: each of its records counts in
 * every view, as before.
 */

/** The instance a run record is in, by instance names from the run's root; `[]` for the root's own. */
export function instancePathOf(record: unknown): string[] {
    const raw = (record as { instancePath?: unknown } | null | undefined)?.instancePath;
    return Array.isArray(raw)
        ? raw.filter((part): part is string => typeof part === 'string' && part.trim() !== '').map(part => part.trim())
        : [];
}

const samePath = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((part, index) => part === b[index]);

const saysInstances = (records: Iterable<unknown>): boolean => {
    for (const record of records) {
        if (instancePathOf(record).length > 0) {
            return true;
        }
    }
    return false;
};

/** The records of the instance at `path`; all of them when none says an instance. */
export function recordsOfInstance<T>(records: readonly T[], path: readonly string[]): T[] {
    if (!saysInstances(records)) {
        return [...records];
    }
    return records.filter(record => samePath(instancePathOf(record), path));
}

/**
 * The edge records of the instance at `path`, under the keys its edges look
 * them up by; all of them, as keyed, when none says an instance.
 */
export function edgesOfInstance<T>(edges: Record<string, T>, path: readonly string[]): Record<string, T> {
    if (!saysInstances(Object.values(edges))) {
        return edges;
    }
    const prefix = path.length > 0 ? `${path.join('/')}/` : '';
    const own: Record<string, T> = {};
    for (const [key, record] of Object.entries(edges)) {
        if (!samePath(instancePathOf(record), path)) {
            continue;
        }
        const kind = key.startsWith('queue:') ? 'queue:' : '';
        const name = key.slice(kind.length);
        own[kind + (name.startsWith(prefix) ? name.slice(prefix.length) : name)] = record;
    }
    return own;
}
