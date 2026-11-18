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
import type { HierarchyOutlineEntry } from '@dialogram/shared';

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
const hashes = new FileMemo<string | undefined>(async filePath => {
    try {
        return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
    } catch {
        return undefined;
    }
});

export async function fileHash(filePath: string): Promise<string | undefined> {
    return hashes.get(filePath);
}

interface CachedHierarchy {
    exported: HierarchyExport;
    hashes: Map<string, string | undefined>;
}

export class HierarchyCache {
    private readonly entries = new Map<string, CachedHierarchy>();
    private static readonly MAX = 8;

    constructor(
        /** Runs the runtime's hierarchy export; its stdout, or undefined on failure. */
        private readonly run: (rootFile: string, rootWorkflow: string) => Promise<string | undefined>,
        private readonly hash: (filePath: string) => Promise<string | undefined> = fileHash
    ) {}

    /** The hierarchy rooted at `rootWorkflow` in `rootFile`, exported anew if any of its files changed. */
    async get(rootFile: string, rootWorkflow: string): Promise<HierarchyExport | undefined> {
        const key = `${rootFile}::${rootWorkflow}`;
        const cached = this.entries.get(key);
        if (cached && (await this.unchanged(cached))) {
            this.entries.delete(key);
            this.entries.set(key, cached);
            return cached.exported;
        }

        const stdout = await this.run(rootFile, rootWorkflow);
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
