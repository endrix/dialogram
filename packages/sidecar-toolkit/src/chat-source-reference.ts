/**
 * The chat's context by reference instead of by content.
 *
 * By default a session attaches the whole source file (up to a bound) and the
 * resolved graph as JSON, and every turn names the selected nodes by id. For a
 * hand-written workflow that is the right amount; for a generated design, a
 * thousand-line netlist or a module with a hundred instances, it fills the
 * agent's context before the question is read. This provides the other shape:
 * the file is not attached (the platform's note names its path and size), the
 * graph goes in as a compact summary, one line per node with where it is in
 * the source, and a selected node goes in as its name, what it is and the
 * file and line to read, with a link to the file. The agent reads line ranges
 * and calls `get_graph` when it needs more.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { SidecarOpResult } from './sidecar-graph-export.js';

export interface SourceReferenceDeps {
    /** The sidecar transport, as the registry tools have it. */
    invoke: (file: string, opName: string, args: Record<string, unknown>) => Promise<SidecarOpResult>;
    /** The graph-export op (`exportModuleGraph`, `exportEntityGraph`). */
    exportOp: string;
    /** What the file is, for the link. */
    sourceMimeType?: string;
    /** Nodes named in the graph summary before it says how many more there are. */
    summaryNodeLimit?: number;
}

export interface SourceReferenceContext {
    graphContextProvider(file: string): Promise<string | undefined>;
    turnContextProvider(file: string, selectedNodeIds: string[]): Promise<unknown[]>;
}

interface Location {
    file?: string;
    line?: number;
}

interface PayloadNode {
    id: string;
    label?: string;
    kind?: string;
    type?: string;
    location?: Location;
    /** Where the normalized document keeps a node's location (`graphPayloadToDoc` moves `location` here). */
    meta?: { source?: Location };
    metadata?: { referencedSource?: Location; referencedEntityName?: string; networkInstance?: boolean; external?: boolean };
}

interface Payload {
    network?: string;
    nodes?: PayloadNode[];
    edges?: unknown[];
}

const DEFAULT_SUMMARY_NODE_LIMIT = 60;

/** `file:line` for people and agents alike; the graph's own file when a location has none. */
function where(loc: Location | undefined, ownFile: string): string | undefined {
    if (!loc || typeof loc.line !== 'number') {
        return undefined;
    }
    return `${loc.file ?? ownFile}:${loc.line}`;
}

function describe(node: PayloadNode): string {
    const kind = node.kind ?? 'node';
    if (kind === 'wf-input') {
        return 'input port';
    }
    if (kind === 'wf-output') {
        return 'output port';
    }
    const of = node.metadata?.referencedEntityName ?? node.type;
    if (kind === 'instance' || node.metadata?.networkInstance) {
        return `${node.metadata?.external ? 'blackbox ' : ''}instance of ${of ?? '?'}`;
    }
    return of ? `${kind} (${of})` : kind;
}

/** One line per node: what it is and where to read it. */
export function nodeLine(node: PayloadNode, ownFile: string): string {
    // The raw export carries `location`; a plan document, already normalized, carries `meta.source`.
    const at = where(node.location ?? node.meta?.source, ownFile);
    const defined = node.metadata?.referencedSource ? where(node.metadata.referencedSource, ownFile) : undefined;
    const parts = [`${node.label ?? node.id}: ${describe(node)}`];
    if (at) {
        parts.push(`at ${at}`);
    }
    if (defined && defined !== at) {
        parts.push(`defined at ${defined}`);
    }
    return parts.join(', ');
}

/** The graph as the session sees it: a count and a line per node, capped. */
export function summarizeGraph(payload: Payload, ownFile: string, limit = DEFAULT_SUMMARY_NODE_LIMIT): string {
    const nodes = payload.nodes ?? [];
    const edges = payload.edges ?? [];
    const head = `Structure of ${payload.network ?? path.basename(ownFile)}: ${nodes.length} nodes, ${edges.length} edges. ` +
        'The source file is not attached: read the line ranges named here, and call get_graph for the full structure.';
    const lines = nodes.slice(0, limit).map(n => `- ${nodeLine(n, ownFile)}`);
    const more = nodes.length > limit ? [`- ... and ${nodes.length - limit} more; get_graph lists them all.`] : [];
    return [head, ...lines, ...more].join('\n');
}

/** The selected nodes, each with where to read it, and a link per file to read. */
export function selectionBlocks(
    payload: Payload | undefined,
    ownFile: string,
    selectedNodeIds: string[],
    mimeType: string | undefined
): unknown[] {
    if (selectedNodeIds.length === 0) {
        return [];
    }
    const byId = new Map((payload?.nodes ?? []).map(n => [n.id, n] as const));
    const lines: string[] = [];
    const files = new Set<string>();
    for (const id of selectedNodeIds.slice(0, 20)) {
        const node = byId.get(id);
        if (!node) {
            lines.push(`- ${id}`);
            continue;
        }
        lines.push(`- ${nodeLine(node, ownFile)}`);
        for (const loc of [node.location, node.metadata?.referencedSource]) {
            if (loc && typeof loc.line === 'number') {
                files.add(loc.file ?? ownFile);
            }
        }
    }
    const count = selectedNodeIds.length;
    const text =
        `The user currently has ${count} node(s) selected in the diagram; when they say "this" or ` +
        `"the selected node(s)", they mean these. Read only the line ranges named, the file is not attached:\n` +
        lines.join('\n') + (count > 20 ? `\n- ... and ${count - 20} more` : '');
    const links = [...files].slice(0, 5).map(file => ({
        type: 'resource_link',
        uri: `file://${file}`,
        name: path.basename(file),
        ...(mimeType ? { mimeType } : {})
    }));
    return [{ type: 'text', text }, ...links];
}

/**
 * The two providers, sharing one export per file version: a turn's selection
 * and the session's summary read the same graph, and a file that has not
 * changed is not exported twice.
 */
export function createSourceReferenceContext(deps: SourceReferenceDeps): SourceReferenceContext {
    const cache = new Map<string, { mtimeMs: number; payload: Payload | undefined }>();

    const exportCached = async (file: string): Promise<Payload | undefined> => {
        let mtimeMs = 0;
        try {
            mtimeMs = (await fs.stat(file)).mtimeMs;
        } catch {
            return undefined;
        }
        const hit = cache.get(file);
        if (hit && hit.mtimeMs === mtimeMs) {
            return hit.payload;
        }
        let payload: Payload | undefined;
        try {
            const result = await deps.invoke(file, deps.exportOp, {});
            const response = result.ok ? result.response : undefined;
            const graph = response?.diagnostic?.graph ?? response?.graph;
            payload = graph && typeof graph === 'object' ? (graph as Payload) : undefined;
        } catch {
            payload = undefined;
        }
        cache.set(file, { mtimeMs, payload });
        return payload;
    };

    return {
        async graphContextProvider(file) {
            const payload = await exportCached(file);
            return payload ? summarizeGraph(payload, file, deps.summaryNodeLimit) : undefined;
        },
        async turnContextProvider(file, selectedNodeIds) {
            if (selectedNodeIds.length === 0) {
                return [];
            }
            const payload = await exportCached(file);
            return selectionBlocks(payload, file, selectedNodeIds, deps.sourceMimeType);
        }
    };
}
