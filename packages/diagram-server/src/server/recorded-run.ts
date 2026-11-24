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
    for (let at = trail.length - 1; at >= 1; at--) {
        const written = trail[at].recordedRun?.trim();
        if (!written) {
            continue;
        }
        const expanded = written === '~'
            ? home
            : /^~[\\/]/.test(written) ? path.join(home, written.slice(2)) : written;
        const resolved = path.resolve(path.dirname(fsPathOf(trail[at - 1].sourceUri)), expanded);
        return {
            runDir: path.extname(resolved).toLowerCase() === '.json' ? path.dirname(resolved) : resolved,
            at,
            workflowName: trail[at].workflowName
        };
    }
    return undefined;
}
