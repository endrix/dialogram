/**
 * What a run left on an edge, as the canvas shows it: the token it carries
 * (`wf:viewerLastToken`) and the size of its queue at a trace step.
 *
 * One rule, read by the canvas's overlay (`applyViewerOverlayToEdges`) and by
 * the node list (`node-list.ts`), so a row of the list opens what a double
 * click on its node opens, at a trace step too.
 *
 * An edge is matched to the run's records by its AST paths first, then by
 * its signature (the ends' entity and port names): the first AST path with
 * a record gives the run's final token, a signature match overrides it. At a
 * trace step, an edge the trace knows shows the token it carried then, or
 * none; an edge the trace does not know keeps the final token.
 */

export interface EdgeTokenSources {
    /** The run's overlay records, by AST path or queue id. */
    overlayEdges: Record<string, { lastToken?: unknown }>;
    /** The run's final tokens, by every signature an overlay record answers to. */
    overlayBySignature: Map<string, unknown>;
    /** At a trace step: each queue's size and token then, by AST path and by signature. */
    queueByAstPath: Map<string, number>;
    queueBySignature: Map<string, number>;
    queueTokenByAstPath: Map<string, unknown>;
    queueTokenBySignature: Map<string, unknown>;
    /** Whether a trace step is shown. */
    atTrace: boolean;
    astPathCandidates(args: Record<string, unknown> | undefined): string[];
    signatureCandidates(args: Record<string, unknown> | undefined): string[];
}

export interface EdgeTokens {
    /** The token the edge shows; absent when it shows none. */
    shown?: { token: unknown };
    /** Its queue's size at the trace step shown, when the trace knows it. */
    queueSize?: number;
}

const has = (record: object | undefined, key: string): boolean =>
    record !== undefined && Object.prototype.hasOwnProperty.call(record, key);

export function edgeTokensOf(sources: EdgeTokenSources): (args: Record<string, unknown> | undefined) => EdgeTokens {
    return args => {
        let queueSize: number | undefined;
        let queueToken: unknown;
        let hasQueueToken = false;
        // The token the edge carried by the end of the run.
        let finalToken: unknown;
        let hasFinalToken = false;
        for (const astPath of sources.astPathCandidates(args)) {
            const entry = sources.overlayEdges[astPath];
            if (!hasFinalToken && entry && has(entry, 'lastToken')) {
                finalToken = entry.lastToken;
                hasFinalToken = true;
            }
            const size = sources.queueByAstPath.get(astPath);
            if (queueSize === undefined && typeof size === 'number') {
                queueSize = size;
            }
            if (!hasQueueToken && sources.queueTokenByAstPath.has(astPath)) {
                queueToken = sources.queueTokenByAstPath.get(astPath);
                hasQueueToken = queueToken !== undefined;
            }
        }

        const signature = sources.signatureCandidates(args)
            .find(candidate => sources.overlayBySignature.has(candidate) || sources.queueBySignature.has(candidate));
        if (signature && sources.overlayBySignature.has(signature)) {
            finalToken = sources.overlayBySignature.get(signature);
            hasFinalToken = true;
        }
        if (queueSize === undefined && signature) {
            const size = sources.queueBySignature.get(signature);
            if (typeof size === 'number') {
                queueSize = size;
            }
        }
        if (!hasQueueToken && signature && sources.queueTokenBySignature.has(signature)) {
            queueToken = sources.queueTokenBySignature.get(signature);
            hasQueueToken = queueToken !== undefined;
        }

        // A step is shown and the trace knows this edge: it is drawn as it
        // was then. The run's final token would paint an edge as carried at a
        // step no token had reached it yet. An edge the trace does not know
        // keeps the final token.
        const atStep = sources.atTrace && queueSize !== undefined;
        const hasShown = atStep ? hasQueueToken : hasQueueToken || hasFinalToken;
        const shown = hasShown ? { token: atStep ? queueToken : (queueToken ?? finalToken) } : undefined;
        return { ...(shown ? { shown } : {}), ...(queueSize !== undefined ? { queueSize } : {}) };
    };
}
