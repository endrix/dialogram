export type GraphLoadError = {
    message: string;
    file?: string;
    line?: number;
    column?: number;
};

export type GraphLoadIssueOverlayState = {
    title: string;
    message: string;
    hint?: string;
};

const NO_NETWORK_DEFINITION_PATTERN = /no\s+@network\s+definitions\s+found/i;

/**
 * Build centered overlay content for graph-load issues.
 *
 * The overlay is intentionally shown only for partial/errored graphs that render
 * no nodes at all, so it helps with "empty canvas" failures without obscuring
 * regular diagrams that still loaded useful content.
 */
export function computeGraphLoadIssueOverlayState(params: {
    isPartialGraph: boolean;
    graphErrors: GraphLoadError[];
    renderableNodeCount: number;
}): GraphLoadIssueOverlayState | undefined {
    const { isPartialGraph, graphErrors, renderableNodeCount } = params;
    if (!isPartialGraph || graphErrors.length === 0 || renderableNodeCount > 0) {
        return undefined;
    }

    const firstMessage = graphErrors[0]?.message?.trim() || 'Graph export completed with recoverable errors.';
    const extraCount = Math.max(0, graphErrors.length - 1);
    const message = extraCount > 0 ? `${firstMessage} (+${extraCount} more)` : firstMessage;
    const hint = NO_NETWORK_DEFINITION_PATTERN.test(firstMessage)
        ? 'Tip: define a top-level @network in this file (not nested inside another function), or open a file that has one.'
        : undefined;

    return {
        title: 'Cannot render diagram from this file',
        message,
        ...(hint ? { hint } : {})
    };
}