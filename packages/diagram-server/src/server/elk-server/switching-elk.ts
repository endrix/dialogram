/**
 * The ELK the layout engine calls: elkjs, or the ELK server for a large graph.
 *
 * It stands where the elkjs instance stood (`ElkFactory`), so the engine, its
 * Free Ports probe and every layout command go through it unchanged. A graph
 * goes to the server when the choice is `elk-server`, or `auto` and the graph
 * is past the size at which the platform starts trading quality for speed
 * (`LAYOUT_TIER_MIDDLE_NODES`, `LAYOUT_TIER_MIDDLE_EDGES`): below it elkjs is
 * done before a request would be, and a small diagram lays out exactly as it
 * always has. Anything the server cannot do — not started, timed out, failed —
 * falls back to elkjs for that layout.
 */
import type { ELK, ElkLayoutArguments, ElkNode } from 'elkjs';
import { LAYOUT_TIER_MIDDLE_EDGES, LAYOUT_TIER_MIDDLE_NODES } from '../layout-configurator';
import { layoutOnServer } from './elk-server-client';
import type { ElkServerProcess } from './elk-server-process';
import { DEFAULT_ELK_SERVER_TIMEOUT_MS, type ElkServerOptions } from './elk-server-options';

/** The nodes and edges of an ELK graph, at every depth. */
export function elkGraphSize(graph: ElkNode): { nodes: number; edges: number } {
    let nodes = 0;
    let edges = 0;
    const visit = (node: ElkNode): void => {
        edges += node.edges?.length ?? 0;
        for (const child of node.children ?? []) {
            nodes++;
            visit(child);
        }
    };
    visit(graph);
    return { nodes, edges };
}

/** Whether a graph of this size goes to the server under this choice. */
export function goesToServer(engine: ElkServerOptions['engine'], size: { nodes: number; edges: number }): boolean {
    if (engine === 'elk-server') {
        return true;
    }
    return engine === 'auto' && (size.nodes > LAYOUT_TIER_MIDDLE_NODES || size.edges > LAYOUT_TIER_MIDDLE_EDGES);
}

/** What `ELK.layout` answers a graph of type `T` with: the graph, laid out (elkjs's own declaration). */
type LaidOut<T extends ElkNode> = Awaited<ReturnType<ELK['layout']>> & Omit<T, 'children'>;

export class SwitchingElk implements ELK {
    constructor(
        private readonly elkjs: ELK,
        private readonly server: Pick<ElkServerProcess, 'ensureStarted'>,
        private readonly options: Pick<ElkServerOptions, 'engine' | 'timeoutMs'>,
        private readonly layoutOnPort: typeof layoutOnServer = layoutOnServer
    ) {}

    async layout<T extends ElkNode>(graph: T, args?: ElkLayoutArguments): Promise<LaidOut<T>> {
        const size = elkGraphSize(graph);
        if (goesToServer(this.options.engine, size)) {
            const port = await this.server.ensureStarted();
            if (port !== undefined) {
                const started = Date.now();
                try {
                    // The server's layout is written into the graph it was given, as elkjs's is.
                    const result = await this.layoutOnPort(port, graph, this.options.timeoutMs ?? DEFAULT_ELK_SERVER_TIMEOUT_MS);
                    console.log(`[dialogram layout] ELK server: ${size.nodes} nodes, ${size.edges} edges in ${Date.now() - started} ms`);
                    return result as LaidOut<T>;
                } catch (error) {
                    console.warn(`[dialogram layout] ${error instanceof Error ? error.message : String(error)}; laying out with elkjs`);
                }
            }
        }
        return this.elkjs.layout(graph, args);
    }

    knownLayoutAlgorithms(): ReturnType<ELK['knownLayoutAlgorithms']> {
        return this.elkjs.knownLayoutAlgorithms();
    }

    knownLayoutOptions(): ReturnType<ELK['knownLayoutOptions']> {
        return this.elkjs.knownLayoutOptions();
    }

    knownLayoutCategories(): ReturnType<ELK['knownLayoutCategories']> {
        return this.elkjs.knownLayoutCategories();
    }

    terminateWorker(): void {
        this.elkjs.terminateWorker();
    }
}
