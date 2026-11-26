import * as path from 'node:path';
/**
 * One export of a whole workflow hierarchy, cached per root.
 *
 * Navigating a hierarchy in one editor, every view is a workflow somewhere
 * under the editor's root. Asking the runtime for each view on its own costs a
 * process per drill-down, and elaborates each nested workflow standalone
 * rather than as the instance its parent built. A runtime that can export the
 * whole hierarchy at once (`cliHierarchyArgs`) is asked once per root; every
 * view, and the outline, are read from that export.
 *
 * The export is kept while every file it came from is unchanged on disk -- the
 * root's and each nested workflow's -- and taken again once any of them is not.
 */
import { createHash } from 'node:crypto';
import { FileMemo } from '@dialogram/diagram-server/services/file-memo';
import { promises as fs } from 'node:fs';
import { URI } from 'vscode-uri';
import type { GraphDocument, HierarchyGraph, HierarchyOutlineEntry } from '@dialogram/shared';

/** One instance in a runtime's hierarchy export. */
export interface HierarchyEntry {
    path: string[];
    workflowName: string;
    sourcePath?: string;
    nodeId?: string;
    nodeCount?: number;
    graph?: unknown;
    error?: string;
    truncated?: boolean;
    children: HierarchyEntry[];
}

/** A runtime's hierarchy export: the root's graph document plus the tree. */
export type HierarchyExport = Record<string, unknown> & { graph: unknown; hierarchy: HierarchyEntry };

/** The instance at `path` (instance names from the root), if the tree has it. */
export function findInstance(root: HierarchyEntry, path: string[]): HierarchyEntry | undefined {
    let current: HierarchyEntry | undefined = root;
    for (const name of path) {
        current = current?.children.find(child => child.path[child.path.length - 1] === name);
        if (!current) {
            return undefined;
        }
    }
    return current;
}

/**
 * The tree without its graphs: what the outline shows. Light enough to ride
 * on every view's model, however large the hierarchy's graphs are.
 */
export function outlineOf(entry: HierarchyEntry): HierarchyOutlineEntry {
    return {
        path: entry.path,
        workflowName: entry.workflowName,
        ...(entry.sourcePath ? { sourceUri: URI.file(entry.sourcePath).toString() } : {}),
        ...(entry.nodeId ? { nodeId: entry.nodeId } : {}),
        ...(typeof entry.nodeCount === 'number' ? { nodeCount: entry.nodeCount } : {}),
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.truncated ? { truncated: true } : {}),
        children: entry.children.map(outlineOf)
    };
}

const graphsByExport = new WeakMap<HierarchyExport, HierarchyGraph[]>();

/**
 * Every instance's graph, root first, for an outline of nodes across the
 * hierarchy (`GraphDocument.hierarchyGraphs`). The root's is the export's
 * own document; a nested instance's is its tree entry's. The documents are
 * the export's, not copies, and the list is made once per export.
 */
export function graphsOf(exported: HierarchyExport): HierarchyGraph[] {
    const known = graphsByExport.get(exported);
    if (known) {
        return known;
    }
    const graphs: HierarchyGraph[] = [];
    const place = (entry: HierarchyEntry): Pick<HierarchyGraph, 'path' | 'workflowName' | 'sourceUri'> => ({
        path: entry.path,
        workflowName: entry.workflowName,
        ...(entry.sourcePath ? { sourceUri: URI.file(entry.sourcePath).toString() } : {})
    });
    const { hierarchy: root, ...rootDocument } = exported;
    graphs.push({ ...place(root), document: rootDocument as unknown as GraphDocument });
    const walk = (entry: HierarchyEntry): void => {
        if (entry.graph && typeof entry.graph === 'object') {
            graphs.push({ ...place(entry), document: entry.graph as GraphDocument });
        }
        entry.children.forEach(walk);
    };
    root.children.forEach(walk);
    graphsByExport.set(exported, graphs);
    return graphs;
}

/** A node of a graph that is a unit answered by a past run (`child(instance=run)`). */
export interface RecordedUnitNode {
    /** Its instance name: its path's last name. */
    name: string;
    /** The workflow it is an instance of, and the file declaring it. */
    workflow: string;
    file: string;
    /** The run, as the node writes it (`meta.workflowInstance.run`). */
    run: string;
}

/**
 * The nodes of a graph document that are units answered by a past run: a
 * workflow instance whose node names the run (`meta.workflowInstance.run`,
 * what the canvas carries as `RECORDED_RUN`) and the file of its workflow.
 */
export function recordedUnitNodes(document: unknown): RecordedUnitNode[] {
    const nodes = ((document as { graph?: { nodes?: unknown } } | undefined)?.graph?.nodes);
    if (!Array.isArray(nodes)) {
        return [];
    }
    const units: RecordedUnitNode[] = [];
    for (const node of nodes as Array<Record<string, any>>) {
        const meta = node?.meta;
        const run = meta?.workflowInstance?.run;
        const file = meta?.referencedSource?.file;
        const isInstance = node?.kind === 'workflow' || meta?.networkInstance === true;
        if (
            isInstance
            && typeof run === 'string' && run.trim() !== ''
            && typeof node.label === 'string' && node.label.trim() !== ''
            && typeof node.type === 'string' && node.type.trim() !== ''
            && typeof file === 'string' && path.isAbsolute(file)
        ) {
            units.push({ name: node.label.trim(), workflow: node.type.trim(), file, run: run.trim() });
        }
    }
    return units;
}

/** How deep units answered by past runs are grafted, one inside another. */
const MAX_RECORDED_UNIT_DEPTH = 4;

/**
 * The grafted lists made from an export's graphs, by those graphs: kept while
 * every unit's export is the one it was made from, so a view drawn again
 * does not graft again.
 */
const graftedByGraphs = new WeakMap<HierarchyGraph[], { exports: Array<HierarchyExport | undefined>; grafted: HierarchyGraph[] }>();

/**
 * The hierarchy's graphs, with what each unit answered by a past run
 * elaborated grafted under it: its workflow's hierarchy as a root of its own
 * (`exportOf`), as a view in it is read (`hierarchyRootAt`), its paths under
 * the unit's and its root marked with the run (`HierarchyGraph.recordedRun`).
 * The unit runs nothing with its parent, so its parent's export has nothing
 * under it. A unit the export already elaborated is only marked; one that
 * does not export is left as it is; one inside another is grafted too, a
 * workflow already on the way not again.
 */
export async function withRecordedUnits(
    graphs: HierarchyGraph[],
    exportOf: (unit: { file: string; workflow: string }) => Promise<HierarchyExport | undefined>,
    within: readonly string[] = []
): Promise<HierarchyGraph[]> {
    const byPath = new Map(graphs.map(graph => [graph.path.join('/'), graph]));
    const units = graphs.flatMap(graph => recordedUnitNodes(graph.document).map(unit => ({ unit, at: [...graph.path, unit.name] })));
    if (units.length === 0) {
        return graphs;
    }
    // Already elaborated by the export: its graphs stay, the unit's own marked with the run.
    const marked = new Map(units.filter(({ at }) => byPath.has(at.join('/'))).map(({ unit, at }) => [at.join('/'), unit.run]));
    const toGraft = units.filter(({ unit, at }) => !marked.has(at.join('/'))
        && !within.includes(`${unit.file}::${unit.workflow}`) && within.length < MAX_RECORDED_UNIT_DEPTH);
    const exports = await Promise.all(toGraft.map(({ unit }) => exportOf(unit)));
    const known = within.length === 0 ? graftedByGraphs.get(graphs) : undefined;
    if (known && known.exports.length === exports.length && known.exports.every((exported, i) => exported === exports[i])) {
        return known.grafted;
    }
    const grafts = await Promise.all(toGraft.map(async ({ unit, at }, i) => {
        const exported = exports[i];
        if (!exported) {
            return [];
        }
        const inner = await withRecordedUnits(graphsOf(exported), exportOf, [...within, `${unit.file}::${unit.workflow}`]);
        return inner.map((innerGraph, index): HierarchyGraph => ({
            ...innerGraph,
            path: [...at, ...innerGraph.path],
            ...(index === 0 ? { recordedRun: unit.run } : {})
        }));
    }));
    const own = marked.size === 0
        ? graphs
        : graphs.map(graph => {
            const run = marked.get(graph.path.join('/'));
            return run ? { ...graph, recordedRun: run } : graph;
        });
    const flat = grafts.flat();
    // Without a graft or a mark, the export's own list (`graphsOf`), as before.
    const grafted = flat.length === 0 ? own : [...own, ...flat];
    if (within.length === 0) {
        graftedByGraphs.set(graphs, { exports, grafted });
    }
    return grafted;
}

/** Every file the hierarchy was elaborated from. */
export function hierarchyFiles(entry: HierarchyEntry): string[] {
    const files = new Set<string>();
    const walk = (node: HierarchyEntry): void => {
        if (node.sourcePath) {
            files.add(node.sourcePath);
        }
        node.children.forEach(walk);
    };
    walk(entry);
    return [...files];
}

/**
 * The files the definitions drawn are declared in (each node's
 * `referencedSource.file`): a class a workflow imports, whose ports or
 * parameters are drawn, is not one of the workflows' own files, and a port
 * added to it has to be drawn too.
 */
export function definitionFiles(exported: unknown): string[] {
    const files = new Set<string>();
    const walk = (value: unknown): void => {
        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }
        if (!value || typeof value !== 'object') {
            return;
        }
        for (const [key, inner] of Object.entries(value)) {
            const file = key === 'referencedSource' ? (inner as { file?: unknown } | null)?.file : undefined;
            if (typeof file === 'string' && path.isAbsolute(file)) {
                files.add(file);
            } else {
                walk(inner);
            }
        }
    };
    walk(exported);
    return [...files];
}

/** A large file is hashed once for as long as it stays as it was (file-memo.ts). */
const hashes = new FileMemo<string>();

/** A file's hash; `undefined` for one that cannot be read, which is not kept: it is read again at the next ask. */
export async function fileHash(filePath: string): Promise<string | undefined> {
    try {
        return await hashes.get(filePath, async () => createHash('sha256').update(await fs.readFile(filePath)).digest('hex'));
    } catch {
        return undefined;
    }
}

interface CachedHierarchy {
    exported: HierarchyExport;
    hashes: Map<string, string | undefined>;
}

export class HierarchyCache {
    private readonly entries = new Map<string, CachedHierarchy>();
    private readonly pending = new Map<string, Promise<HierarchyExport | undefined>>();
    private static readonly MAX = 8;

    constructor(
        /** Runs the runtime's hierarchy export from `cwd`, with `variables`; its stdout, or undefined on failure. */
        private readonly run: (rootFile: string, rootWorkflow: string, cwd: string, variables: Record<string, string>) => Promise<string | undefined>,
        private readonly hash: (filePath: string) => Promise<string | undefined> = fileHash
    ) {}

    /**
     * The hierarchy rooted at `rootWorkflow` in `rootFile`, exported from `cwd` (the root file's
     * run root) with the variables the product's settings give the CLI, anew if any of its files
     * changed. One exported from another folder, or with other variables, is not this one.
     */
    async get(rootFile: string, rootWorkflow: string, cwd: string, variables: Record<string, string> = {}): Promise<HierarchyExport | undefined> {
        const key = `${rootFile}::${rootWorkflow}::${cwd}::${JSON.stringify(variables)}`;
        // Asked again while it is being answered (two views loading, a unit grafted into both):
        // the same answer, one export.
        const pending = this.pending.get(key);
        if (pending) {
            return pending;
        }
        const answer = this.answer(key, rootFile, rootWorkflow, cwd, variables);
        this.pending.set(key, answer);
        try {
            return await answer;
        } finally {
            this.pending.delete(key);
        }
    }

    private async answer(
        key: string, rootFile: string, rootWorkflow: string, cwd: string, variables: Record<string, string>
    ): Promise<HierarchyExport | undefined> {
        const cached = this.entries.get(key);
        if (cached && (await this.unchanged(cached))) {
            this.entries.delete(key);
            this.entries.set(key, cached);
            return cached.exported;
        }

        const stdout = await this.run(rootFile, rootWorkflow, cwd, variables);
        if (stdout === undefined) {
            this.entries.delete(key);
            return undefined;
        }
        let exported: HierarchyExport;
        try {
            exported = JSON.parse(stdout);
        } catch {
            return undefined;
        }
        if (!exported || typeof exported !== 'object' || !exported.graph || !exported.hierarchy) {
            return undefined;
        }

        const files = new Set([rootFile, ...hierarchyFiles(exported.hierarchy), ...definitionFiles(exported)]);
        const hashes = new Map<string, string | undefined>();
        for (const file of files) {
            hashes.set(file, await this.hash(file));
        }
        this.entries.set(key, { exported, hashes });
        while (this.entries.size > HierarchyCache.MAX) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.entries.delete(oldest);
        }
        return exported;
    }

    private async unchanged(cached: CachedHierarchy): Promise<boolean> {
        for (const [file, hash] of cached.hashes) {
            if ((await this.hash(file)) !== hash) {
                return false;
            }
        }
        return true;
    }
}
