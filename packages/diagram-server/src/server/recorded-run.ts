/**
 * The run a view inside a nested unit answered by a past run is drawn from.
 *
 * A nested workflow can be an instance of a run that already happened (a
 * producer's `child(instance="wf-out/<run>")`): its parent's runs hand on the outputs that
 * run recorded and run nothing of it, so they record nothing inside it. Its
 * insides are that run: the tokens its edges carried, its agents, its trace.
 * The producer lists the run on the node (`meta.workflowInstance.run`, carried
 * as `RECORDED_RUN`), a drill-down keeps it on the crumb it adds, and a view
 * at or below that crumb is drawn from that run, its instance paths measured
 * from that crumb. Whatever run is the latest, or chosen for the parent, is
 * not this one's.
 *
 * The run is written as its producer reads it: relative to the file of the
 * workflow the node is drawn in (the crumb above), `~` for the home folder,
 * a run's directory or its record (a `.json` file in it).
 */
import * as os from 'os';
import * as path from 'path';
import { hierarchyRootAt, type HierarchyGraph } from '@dialogram/shared';

export interface RecordedRunCrumb {
    sourceUri: string;
    workflowName: string;
    recordedRun?: string;
}

export interface RecordedRunOfView {
    /** The run's directory. */
    runDir: string;
    /** The crumb of the instance it answers: the run's root on the trail. */
    at: number;
    /** The workflow it ran, which is the crumb's. */
    workflowName: string;
}

/**
 * The past run the view at the trail's end is drawn from: the deepest crumb
 * answered by one, the view's own or one above it. Nothing when no crumb is.
 * `fsPathOf` turns a crumb's source URI into its file's path.
 */
export function recordedRunOfTrail(
    trail: readonly RecordedRunCrumb[],
    fsPathOf: (sourceUri: string) => string,
    home: string = os.homedir()
): RecordedRunOfView | undefined {
    // The same crumb the view's hierarchy is rooted at.
    const at = hierarchyRootAt(trail);
    const written = trail[at]?.recordedRun?.trim();
    if (at === 0 || !written) {
        return undefined;
    }
    return {
        runDir: recordedRunDir(written, fsPathOf(trail[at - 1].sourceUri), home),
        at,
        workflowName: trail[at].workflowName
    };
}

/**
 * The directory of a past run, as an instance's node writes it (`written`),
 * relative to `holderFile`, the file of the workflow the node is drawn in.
 */
export function recordedRunDir(written: string, holderFile: string, home: string = os.homedir()): string {
    const expanded = written === '~'
        ? home
        : /^~[\\/]/.test(written) ? path.join(home, written.slice(2)) : written;
    const resolved = path.resolve(path.dirname(holderFile), expanded);
    return path.extname(resolved).toLowerCase() === '.json' ? path.dirname(resolved) : resolved;
}

/** A unit answered by a past run, in a hierarchy's graphs (`HierarchyGraph.recordedRun`). */
export interface RecordedUnit {
    /** The instance answered by it, by instance names from the hierarchy's root: the run's root. */
    path: string[];
    /** The run's directory. */
    runDir: string;
    /** The workflow it ran, the instance's. */
    workflowName: string;
}

/**
 * The units answered by a past run in a hierarchy's graphs, deepest first:
 * each graph that says so (`HierarchyGraph.recordedRun`), its run resolved
 * from the file of the graph it is drawn in, the one above it. One whose
 * holder is not among the graphs, or has no file, is left out.
 */
export function recordedUnitsOf(
    graphs: readonly HierarchyGraph[],
    fsPathOf: (sourceUri: string) => string,
    home: string = os.homedir()
): RecordedUnit[] {
    const byPath = new Map(graphs.map(graph => [graph.path.join('/'), graph]));
    const units: RecordedUnit[] = [];
    for (const graph of graphs) {
        const written = graph.recordedRun?.trim();
        const holderUri = graph.path.length > 0 ? byPath.get(graph.path.slice(0, -1).join('/'))?.sourceUri : undefined;
        if (written && holderUri) {
            units.push({ path: graph.path, runDir: recordedRunDir(written, fsPathOf(holderUri), home), workflowName: graph.workflowName });
        }
    }
    return units.sort((a, b) => b.path.length - a.path.length);
}

/** The unit an instance at `instancePath` is in (itself or one above it), from `units` deepest first. */
export function recordedUnitAt(units: readonly RecordedUnit[], instancePath: readonly string[]): RecordedUnit | undefined {
    return units.find(unit => unit.path.length <= instancePath.length && unit.path.every((name, i) => name === instancePath[i]));
}
