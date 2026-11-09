/**
 * What a product's webview code imports from the package rather than by path:
 * the contribution points, the panel's building blocks, the host and profile
 * accessors and the text helpers. A product bundle builds against these names.
 */
import { describe, expect, it } from 'vitest';
import * as client from '../src/index';

describe('the package, for a product’s webview code', () => {
    it('exports the contribution points and what their implementations use', () => {
        for (const name of [
            'AnnotationEditor', 'NodeSectionContribution', 'AnnotationTemplate', 'CUSTOM_ANNOTATION_ENTRY',
            'createPropertySection', 'escapeHtml', 'shortenPath', 'renderInto',
            'VscodeUi', 'clientBehavior', 'commandId', 'offersRun', 'settingsNamespace',
            'renderMarkdownSafe', 'renderDocumentMarkdownSafe', 'looksLikeMarkdown',
            'isBlock', 'looksLikeDiff', 'parseEmbedded', 'formatAgentOutputs'
        ]) {
            expect(client, name).toHaveProperty(name);
            expect((client as Record<string, unknown>)[name], name).toBeDefined();
        }
    });
});
