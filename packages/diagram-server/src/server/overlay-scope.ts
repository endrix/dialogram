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
 * every view, as before. Whether a run says them is decided once for the run
 * (`saysInstances` over its final records and its trace), so its two files
 * are read alike.
 *
 * A view's place is measured from its navigation trail's root, and a run's
 * from the run's root, which is that root or a workflow further down the trail
 * (a nested workflow run on its own). `runRootPrefix` finds where the run's
 * root sits on the trail, and `fromRunRoot` measures a path from there.
 */

/** The parts of a record's `instancePath` as the runtime wrote them. */
function rawInstancePathOf(record: unknown): string[] {
    const raw = (record as { instancePath?: unknown } | null | undefined)?.instancePath;
    return Array.isArray(raw) ? raw.filter((part): part is string => typeof part === 'string' && part.trim() !== '') : [];
}

/** The instance a run record is in, by instance names from the run's root; `[]` for the root's own. */
export function instancePathOf(record: unknown): string[] {
    return rawInstancePathOf(record).map(part => part.trim());
}

const samePath = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((part, index) => part === b[index]);

/** Whether any of the records says the instance it is in: the run records nested instances apart. */
export function saysInstances(records: Iterable<unknown>): boolean {
    for (const record of records) {
        if (instancePathOf(record).length > 0) {
            return true;
        }
    }
    return false;
}

/**
 * The records of the instance at `path`; all of them when the run says no
 * instance (`scoped`, by default whether one of these records says one).
 */
export function recordsOfInstance<T>(records: readonly T[], path: readonly string[], scoped = saysInstances(records)): T[] {
    if (!scoped) {
        return [...records];
    }
    return records.filter(record => samePath(instancePathOf(record), path));
}

/**
 * The edge records of the instance at `path`, under the keys its edges look
 * them up by; all of them, as keyed, when the run says no instance (`scoped`,
 * by default whether one of these records says one).
 */
export function edgesOfInstance<T>(
    edges: Record<string, T>,
    path: readonly string[],
    scoped = saysInstances(Object.values(edges))
): Record<string, T> {
    if (!scoped) {
        return edges;
    }
    const own: Record<string, T> = {};
    for (const [key, record] of Object.entries(edges)) {
        if (!samePath(instancePathOf(record), path)) {
            continue;
        }
        // The key starts with the path as the runtime wrote it, untrimmed.
        const raw = rawInstancePathOf(record);
        const prefix = raw.length > 0 ? `${raw.join('/')}/` : '';
        const kind = key.startsWith('queue:') ? 'queue:' : '';
        const name = key.slice(kind.length);
        own[kind + (name.startsWith(prefix) ? name.slice(prefix.length) : name)] = record;
    }
    return own;
}

/**
 * Where the run's root sits on a navigation trail: the instance path, from the
 * trail's root, of the first crumb that is the run's root workflow (`isRunRoot`).
 * `[]` when that is the trail's root, and when no crumb is, as a run is then
 * read as starting at the trail's root.
 */
export function runRootPrefix<C>(
    trail: readonly C[],
    isRunRoot: (crumb: C) => boolean,
    instancePathOfTrail: (trail: readonly C[]) => string[]
): string[] {
    const at = trail.findIndex(isRunRoot);
    return at > 0 ? instancePathOfTrail(trail.slice(0, at + 1)) : [];
}

/**
 * `path` (from the trail's root) measured from the run's root at `prefix`;
 * undefined when the instance is not under the run's root, which ran nothing
 * of it.
 */
export function fromRunRoot(path: readonly string[], prefix: readonly string[]): string[] | undefined {
    if (path.length < prefix.length || !prefix.every((part, index) => part === path[index])) {
        return undefined;
    }
    return path.slice(prefix.length);
}
