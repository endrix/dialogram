/**
 * The view options of the diagram shown, in the webview (shared
 * `view-options.ts`): what the palette draws under its tools, and what a
 * product's renderer is told.
 *
 * The host holds the truth, per file; this is the webview's copy of it. The
 * groups come with each model (`wf:viewOptions`, the file's choices already
 * applied). A reader's click is in force here at once: the copy turns, the
 * palette redraws, and {@link ViewOptionsChangedAction} is dispatched to the
 * product's client modules before anything is sent, so a renderer follows
 * without waiting for the host. The click then goes to the host, which keeps
 * it. Every line the host turns comes back, the result of this diagram's own
 * click too: a change the host made just before it can have left the host
 * with another state than the click showed here, and the copy follows the
 * host's. (Two clicks quicker than the host answers can show the first
 * answer for a moment; the second answer follows.)
 *
 * A model can have been made before the last change reached the host (a
 * click on its way, a host change on its way here): for the file it already
 * shows, the copy keeps the state it has for every line it knows and takes
 * from the model only what is new. A model of another file is taken whole.
 * Either way, lines the host turned that the copy did not show then (the
 * first model, or the file being opened in place, still on its way; a line
 * of a group the view shown does not have) are heard from the start and
 * applied over the model of their file, which may be older than they are.
 */
import { inject, injectable, optional } from 'inversify';
import { TYPES, type IActionDispatcher } from '@eclipse-glsp/client';
import {
    applyViewOptionTurns,
    isViewOptionsTurnedMessage,
    normalizeViewOptionGroups,
    turnsOf,
    VIEW_OPTIONS_ARG,
    VIEW_OPTIONS_CHANGED_MESSAGE,
    ViewOptionsChangedAction,
    viewOptionTurnsBetween,
    type ViewOptionChange,
    type ViewOptionGroup,
    type ViewOptionTurn
} from '@dialogram/shared';
import { VscodeUi } from './vscode-ui';

/** Whether two spellings of a source URI name the same file. */
export function sameSource(a: string, b: string): boolean {
    if (a === b) {
        return true;
    }
    const plain = (uri: string): string => {
        try {
            return decodeURIComponent(uri).replace(/\/+$/, '');
        } catch {
            return uri;
        }
    };
    return plain(a) === plain(b);
}

/**
 * The groups a model declares, with the state the diagram already shows for
 * every line it knows: it has heard every change since, and the model may
 * have been made before the last of them. A `one` group keeps its own line
 * where that line is still there.
 */
export function keepShownState(declared: ViewOptionGroup[], shown: ViewOptionGroup[]): ViewOptionGroup[] {
    const known = new Map<string, boolean>();
    for (const group of shown) {
        for (const item of group.items) {
            known.set(`${group.id}\u0000${item.id}`, item.checked !== false);
        }
    }
    return declared.map(group => {
        const items = group.items.map(item => {
            const checked = known.get(`${group.id}\u0000${item.id}`);
            return checked === undefined ? item : { ...item, checked };
        });
        if (group.choice === 'one' && items.filter(item => item.checked !== false).length !== 1) {
            return group;
        }
        return { ...group, items };
    });
}

/** Whether the groups have the line a turn names. */
function hasLine(groups: ViewOptionGroup[], turn: ViewOptionTurn): boolean {
    return groups.some(group => group.id === turn.group && group.items.some(item => item.id === turn.item));
}

/**
 * The groups with lines the host turned applied, in the order they came; a
 * `one` group they would leave with other than one line checked keeps its
 * own.
 */
function applyHeard(groups: ViewOptionGroup[], turns: ViewOptionTurn[]): ViewOptionGroup[] {
    if (turns.length === 0) {
        return groups;
    }
    const turned = applyViewOptionTurns(groups, turns);
    return turned.map((group, at) => (group.choice === 'one' && group.items.filter(item => item.checked !== false).length !== 1 ? groups[at] : group));
}

/** The groups a model root carries, or none. */
export function viewOptionsOfRoot(root: unknown): { sourceUri: string; groups: ViewOptionGroup[] } {
    const args = (root as { args?: Record<string, unknown> } | undefined)?.args;
    const sourceUri = typeof args?.['sourceUri'] === 'string' ? (args['sourceUri'] as string) : '';
    const raw = args?.[VIEW_OPTIONS_ARG];
    if (typeof raw !== 'string') {
        return { sourceUri, groups: [] };
    }
    try {
        return { sourceUri, groups: normalizeViewOptionGroups(JSON.parse(raw)) };
    } catch {
        return { sourceUri, groups: [] };
    }
}

/** Host changes kept for a file the diagram does not show yet, at most. */
const MAX_HEARD = 256;

@injectable()
export class ViewOptionsService {
    @inject(TYPES.IActionDispatcher) @optional() protected readonly dispatcher?: IActionDispatcher;

    private shownSource = '';
    private shown: ViewOptionGroup[] = [];
    private shownJson = '[]';
    private readonly listeners = new Set<() => void>();
    private listening = false;
    /**
     * Lines the host turned that the diagram shown did not have when they
     * came, by file, oldest first: applied over the next model of their
     * file. A model lets go of the others (the diagram is not showing them).
     */
    private heard: Array<{ sourceUri: string; turns: ViewOptionTurn[] }> = [];

    constructor() {
        // From the start, not from the first model: a host change made while
        // the first model is laid out comes before it.
        this.listen();
    }

    /** The file the groups are of. */
    get sourceUri(): string {
        return this.shownSource;
    }

    /** Every group of the diagram shown, as it stands. */
    get groups(): ViewOptionGroup[] {
        return this.shown;
    }

    /** Whether a line is checked; `undefined` when the diagram has no such line. */
    isChecked(group: string, item: string): boolean | undefined {
        const line = this.shown.find(candidate => candidate.id === group)?.items.find(candidate => candidate.id === item);
        return line ? line.checked !== false : undefined;
    }

    /** Be told whenever the groups change, in shape or state. */
    onDidChange(listener: () => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    modelRootChanged(root: unknown): void {
        this.listen();
        const { sourceUri, groups: declared } = viewOptionsOfRoot(root);
        const sameFile = sameSource(sourceUri, this.shownSource) && this.shownSource !== '';
        const before = sameFile ? this.shown : [];
        const kept = sameFile ? keepShownState(declared, this.shown) : declared;
        const heard = this.heard.filter(entry => sameSource(entry.sourceUri, sourceUri)).flatMap(entry => entry.turns);
        const next = applyHeard(kept, heard);
        // What this model still does not show is heard on, for the next one of the file.
        const unshown = heard.filter(turn => !hasLine(next, turn));
        this.heard = unshown.length > 0 ? [{ sourceUri, turns: unshown }] : [];
        this.shownSource = sourceUri;
        this.show(next, viewOptionTurnsBetween(before, next), 'load');
    }

    /**
     * The reader's change: in force here at once, then the host's. Nothing
     * happens for a change that turns nothing (a disabled line, a line
     * already as asked).
     */
    change(change: ViewOptionChange): void {
        const turns = turnsOf(this.shown, change);
        if (turns.length === 0) {
            return;
        }
        this.show(applyViewOptionTurns(this.shown, turns), turns, 'reader');
        this.postToHost({ type: VIEW_OPTIONS_CHANGED_MESSAGE, payload: { sourceUri: this.shownSource, changes: [change] } });
    }

    /**
     * Lines the host turned for a file; only the diagram of that file
     * follows. Lines it does not show (another file, the first model still
     * to come, a group it does not have) are kept for the model that shows
     * them.
     */
    hostTurned(sourceUri: string, turns: ViewOptionTurn[]): void {
        const shownFile = this.shownSource !== '' && sameSource(sourceUri, this.shownSource);
        const unshown = shownFile ? turns.filter(turn => !hasLine(this.shown, turn)) : turns;
        if (unshown.length > 0) {
            this.heard.push({ sourceUri, turns: unshown });
            // A file shown in place hears its editor's own file for as long as it lasts: the oldest go.
            if (this.heard.length > MAX_HEARD) {
                this.heard.shift();
            }
        }
        if (!shownFile) {
            return;
        }
        // A host's pick racing the reader's click in a one-of group would
        // check two lines: the group keeps the click until its answer comes.
        const next = applyHeard(this.shown, turns);
        this.show(next, viewOptionTurnsBetween(this.shown, next), 'host');
    }

    /** Doing nothing for the action this dispatches makes it one the diagram knows, with or without a product's handler. */
    handle(_action: unknown): void {
        // The state is kept here already.
    }

    /** What goes to the host; a test overrides it. */
    protected postToHost(message: unknown): void {
        VscodeUi.instance.post(message);
    }

    private show(groups: ViewOptionGroup[], turns: ViewOptionTurn[], origin: 'load' | 'reader' | 'host'): void {
        const json = JSON.stringify(groups);
        const changedShape = json !== this.shownJson;
        this.shown = groups;
        this.shownJson = json;
        if (turns.length > 0 && this.dispatcher) {
            void this.dispatcher.dispatch(ViewOptionsChangedAction.create({
                sourceUri: this.shownSource,
                groups,
                changed: turns,
                origin
            }) as never);
        }
        if (changedShape || turns.length > 0) {
            for (const listener of [...this.listeners]) {
                listener();
            }
        }
    }

    private listen(): void {
        if (this.listening || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
            return;
        }
        this.listening = true;
        window.addEventListener('message', (event: MessageEvent) => {
            if (isViewOptionsTurnedMessage(event.data)) {
                this.hostTurned(event.data.payload.sourceUri, event.data.payload.turns);
            }
        });
    }
}
