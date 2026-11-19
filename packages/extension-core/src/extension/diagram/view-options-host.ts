/**
 * The host's side of the view options (shared `view-options.ts`): what the
 * reader chose, per file, and the one place that changes it.
 *
 * The host holds the truth rather than the webview, for three reasons. It is
 * the only side that can keep a choice beside the file's layout, so that it
 * is there after a reload and when the file is opened again. It is there
 * when no diagram is: a chat tool asked to hide something answers whether a
 * diagram of the file is open or not, and the next one opened shows it. And
 * a choice the producer applies itself (`reload`) is read by `getGraph`,
 * which runs here. The webview shows what it is told and says what the
 * reader did; a click is in force there at once and is the host's a moment
 * later.
 *
 * How the choices reach a diagram: each graph's groups go through
 * {@link ViewOptionsHost.wrapModelSource}, which puts the profile's groups
 * in front of the graph's own and applies the file's choices, so the model
 * carries them as they stand (`wf:viewOptions`). A change made here after
 * that goes to every diagram of the file as the lines it turned
 * ({@link VIEW_OPTIONS_TURNED_MESSAGE}), never as a whole state, so that a
 * reader's click on its way to the host is not undone by an answer to the
 * click before. The diagram a reader's change came from is told too: a
 * change the host made just before can have left another state than the
 * click showed there, and the diagram follows the host's.
 *
 * A file's diagrams can show views of it that declare different groups (two
 * editors, each in another view): the file's declaration is every group its
 * graphs have declared, the newest declaration of each.
 */
import type {
    DiagramModelSource,
    GraphDocument,
    ModelSourceOptions,
    ViewOptionChange,
    ViewOptionGroup,
    ViewOptionsState,
    ViewOptionTurn
} from '@dialogram/shared';
import {
    applyViewOptionsState,
    applyViewOptionTurns,
    isViewOptionChange,
    normalizeViewOptionGroups,
    normalizeViewOptionsState,
    recordViewOptionTurns,
    turnsOf,
    VIEW_OPTIONS_TURNED_MESSAGE
} from '@dialogram/shared';

/** Where the choices are kept: the file's layout record (diagram-server `LayoutPersistenceService`). */
export interface ViewOptionsStore {
    load(filePath: string): Promise<ViewOptionsState | undefined>;
    save(filePath: string, state: ViewOptionsState): Promise<void>;
}

/** What a product is told of a change (`DiagramProfile.viewOptions.onDidChange`). */
export interface ViewOptionsChangeEvent {
    /** Every group of the file, as it now stands. */
    groups: ViewOptionGroup[];
    /** The lines the change turned. */
    turns: ViewOptionTurn[];
    /** The reader, in the palette, or the host (`DiagramProfileHandle.setViewOptions`). */
    origin: 'reader' | 'host';
}

export interface ViewOptionsHostOptions {
    /** The profile's own groups, in front of every graph's. */
    groups?: ViewOptionGroup[];
    /** Told every change, once it is in force and kept. A throw is logged and changes nothing. */
    onDidChange?: (file: string, event: ViewOptionsChangeEvent) => void;
    store: ViewOptionsStore;
    /** The key a source URI is known by (diagram-server `normalizeSourceUriKey`). */
    keyOf: (uri: string) => string;
    /** The file system path of a source URI, for the store and the product. */
    pathOf: (uri: string) => string;
    /**
     * Post a message to every diagram of the file, the one a reader's change
     * came from too. `message(shownAs)` is what one is sent, with the file's
     * URI as that diagram names it: a file's editors, and a view shown in
     * place, each spell it their own way, and a diagram knows its file by its
     * own spelling.
     */
    post: (sourceUri: string, message: (shownAs: string) => unknown) => void;
    /** Ask every diagram of the file for its model again. */
    refresh: (sourceUri: string) => void;
    log?: (message: string) => void;
}

export class ViewOptionsHost {
    /** What the reader chose, per file key; loaded from the store on first need. */
    private readonly choices = new Map<string, ViewOptionsState>();
    private readonly loading = new Map<string, Promise<ViewOptionsState>>();
    /** The groups each file's graphs declared, the profile's first, the newest declaration of each group. */
    private readonly declared = new Map<string, ViewOptionGroup[]>();
    /** The URI each key was last seen as, for the messages. */
    private readonly uris = new Map<string, string>();
    private readonly profileGroups: ViewOptionGroup[];
    /** Changes are made one at a time per file: each reads what the one before left. */
    private readonly queues = new Map<string, Promise<unknown>>();

    constructor(private readonly options: ViewOptionsHostOptions) {
        this.profileGroups = normalizeViewOptionGroups(options.groups ?? []);
    }

    /**
     * A model source whose graphs carry the file's view options as they
     * stand, and whose `getGraph` is handed the reader's choices. Every other
     * member is the source's own. A source that declares none, under a
     * profile that declares none, gives the same documents as before.
     */
    wrapModelSource(source: DiagramModelSource): DiagramModelSource {
        const getGraph = async (sourceUri: string, options: ModelSourceOptions): Promise<GraphDocument | undefined> => {
            const key = this.remember(sourceUri);
            const chosen = await this.choicesOf(key);
            // The options are the platform's as they came (`progress`,
            // `signal`, the request's own), with the choices beside them.
            const doc = await source.getGraph(sourceUri, Object.keys(chosen).length > 0 ? { ...options, viewOptions: chosen } : options);
            // A load whose reader has gone (`signal`) is drawn for nobody, and
            // what came back of it may be partial: the groups it declares are
            // not the file's, so they are not taken as its declaration.
            if (options.signal?.aborted) {
                return doc;
            }
            return doc ? this.publish(key, doc) : doc;
        };
        return new Proxy(source, {
            get(target, property) {
                if (property === 'getGraph') {
                    return getGraph;
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
    }

    /** The file's groups as they stand: those its graphs declared, or the profile's when none has been read yet. */
    async get(uri: string): Promise<ViewOptionGroup[]> {
        const key = this.remember(uri);
        return applyViewOptionsState(this.declarationOf(key), await this.choicesOf(key));
    }

    /**
     * Change the file's view options, as the host: each change in turn, kept,
     * told to the product and to every diagram of the file. A line of a group
     * the file has not declared yet (no diagram of it has been opened) is
     * kept as a choice and applies when one is; All, None and Only need the
     * group's lines and do nothing then. Resolves to the groups as they stand.
     */
    set(uri: string, changes: ViewOptionChange | ViewOptionChange[]): Promise<ViewOptionGroup[]> {
        const list = (Array.isArray(changes) ? changes : [changes]).filter(isViewOptionChange);
        return this.change(uri, list, 'host');
    }

    /**
     * A webview's message: the reader changed what is shown. Every diagram of
     * the file is told what the host made of it, the one it came from and a
     * second editor of the same file included.
     */
    async onWebviewChange(payload: unknown): Promise<void> {
        const sourceUri = (payload as { sourceUri?: unknown } | undefined)?.sourceUri;
        const raw = (payload as { changes?: unknown } | undefined)?.changes;
        if (typeof sourceUri !== 'string' || sourceUri === '' || !Array.isArray(raw)) {
            return;
        }
        await this.change(sourceUri, raw.filter(isViewOptionChange), 'reader');
    }

    private change(uri: string, changes: ViewOptionChange[], origin: 'reader' | 'host'): Promise<ViewOptionGroup[]> {
        const key = this.remember(uri);
        const previous = this.queues.get(key) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(() => this.changeNow(key, changes, origin));
        this.queues.set(key, next);
        void next.finally(() => {
            if (this.queues.get(key) === next) {
                this.queues.delete(key);
            }
        }).catch(() => undefined);
        return next;
    }

    private async changeNow(key: string, changes: ViewOptionChange[], origin: 'reader' | 'host'): Promise<ViewOptionGroup[]> {
        const declaration = this.declarationOf(key);
        let state = await this.choicesOf(key);
        let groups = applyViewOptionsState(declaration, state);
        const turns: ViewOptionTurn[] = [];
        for (const change of changes) {
            let turned = turnsOf(groups, change);
            if (turned.length === 0 && 'item' in change && !this.declares(declaration, change.group, change.item)) {
                // Not declared yet: kept, for the graph that will declare it.
                turned = [{ group: change.group, item: change.item, checked: change.checked }];
            }
            if (turned.length === 0) {
                continue;
            }
            state = recordViewOptionTurns(state, turned);
            groups = applyViewOptionTurns(groups, turned.filter(turn => this.declares(declaration, turn.group, turn.item)));
            turns.push(...turned);
        }
        if (turns.length === 0) {
            return groups;
        }
        this.choices.set(key, state);
        const sourceUri = this.uris.get(key) ?? key;
        await this.keep(key, state, declaration);
        this.options.post(sourceUri, shownAs => ({ type: VIEW_OPTIONS_TURNED_MESSAGE, payload: { sourceUri: shownAs, turns } }));
        try {
            this.options.onDidChange?.(this.options.pathOf(sourceUri), { groups, turns, origin });
        } catch (error) {
            this.options.log?.(`[view options] the profile's onDidChange failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const reloads = new Set(declaration.filter(group => group.reload === true).map(group => group.id));
        if (turns.some(turn => reloads.has(turn.group))) {
            this.options.refresh(sourceUri);
        }
        return groups;
    }

    /** Keep the choices of every group that is kept (`persist`), the undeclared ones too. */
    private async keep(key: string, state: ViewOptionsState, declaration: ViewOptionGroup[]): Promise<void> {
        const notKept = new Set(declaration.filter(group => group.persist === false).map(group => group.id));
        const kept: ViewOptionsState = {};
        for (const [group, items] of Object.entries(state)) {
            if (!notKept.has(group)) {
                kept[group] = items;
            }
        }
        try {
            await this.options.store.save(this.options.pathOf(this.uris.get(key) ?? key), kept);
        } catch (error) {
            this.options.log?.(`[view options] could not keep the choices: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * The document with the file's groups as they stand; the producer's
     * object is left alone. The groups it declares are taken into the file's
     * declaration, each in place of the one of its id declared before; the
     * file's other groups stay, since another diagram of the file may be
     * showing the view that declared them.
     */
    private publish(key: string, doc: GraphDocument): GraphDocument {
        const own = normalizeViewOptionGroups(doc.viewOptions ?? []);
        if (own.length === 0 && this.profileGroups.length === 0) {
            return doc;
        }
        const declaration = normalizeViewOptionGroups([...this.profileGroups, ...own]);
        const ids = new Set(declaration.map(group => group.id));
        const before = (this.declared.get(key) ?? []).filter(group => !ids.has(group.id));
        this.declared.set(key, [...declaration, ...before]);
        return { ...doc, viewOptions: applyViewOptionsState(declaration, this.choices.get(key)) };
    }

    private declarationOf(key: string): ViewOptionGroup[] {
        return this.declared.get(key) ?? this.profileGroups;
    }

    private declares(groups: ViewOptionGroup[], group: string, item: string): boolean {
        return groups.some(candidate => candidate.id === group && candidate.items.some(line => line.id === item));
    }

    private remember(uri: string): string {
        const key = this.options.keyOf(uri);
        if (!this.uris.has(key)) {
            this.uris.set(key, uri);
        }
        return key;
    }

    private choicesOf(key: string): Promise<ViewOptionsState> {
        const known = this.choices.get(key);
        if (known) {
            return Promise.resolve(known);
        }
        let pending = this.loading.get(key);
        if (!pending) {
            pending = this.options.store
                .load(this.options.pathOf(this.uris.get(key) ?? key))
                .then(raw => normalizeViewOptionsState(raw), () => ({}))
                .then(state => {
                    // A change made while the file was read is newer than the file.
                    const now = this.choices.get(key) ?? state;
                    this.choices.set(key, now);
                    this.loading.delete(key);
                    return now;
                });
            this.loading.set(key, pending);
        }
        return pending;
    }
}
