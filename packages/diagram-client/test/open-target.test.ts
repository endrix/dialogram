/**
 * Following what a node or a panel link points at.
 *
 * A node the producer says stands for a file (`wf:open`) opens it on
 * double-click, at its line, and that wins over the node's other double-click
 * meanings. A link in the property panel is an element of the diagram (`#id`),
 * a URL, or a file reference for the host to resolve against the file the
 * text came from; script URLs are not followed at all.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import {
    OPEN_REFERENCE_ARG,
    REFERENCE_BASE_ARG,
    classifyLink,
    openTargetAction,
    openTargetOf,
    referenceAction
} from '../src/open-target';

const node = (open: unknown, parent?: unknown): any => ({ id: 'n', args: { [WorkflowDiagramMetadata.OPEN_TARGET]: open }, parent });

describe('the file a node stands for', () => {
    it('is read from the node, or from the node holding a label or port', () => {
        const holder = node({ uri: 'file:///w/gen/memif.py', line: 42 });
        const label = { id: 'n_label', args: {}, parent: holder };

        expect(openTargetOf(holder)).toEqual({ uri: 'file:///w/gen/memif.py', line: 42 });
        expect(openTargetOf(label as any)).toEqual({ uri: 'file:///w/gen/memif.py', line: 42 });
        expect(openTargetOf(node(undefined))).toBeUndefined();
        expect(openTargetOf(node({ uri: '' }))).toBeUndefined();
    });

    it('opens for real (not a preview), with the 1-based line as a 0-based selection', () => {
        const action: any = openTargetAction(node({ uri: 'file:///w/gen/memif.py', line: 42 }));
        const options = JSON.parse(action.target?.args?.jsonOpenerOptions ?? action.args?.jsonOpenerOptions);

        expect(action.kind).toBe('navigateToExternalTarget');
        expect(options).toMatchObject({ preview: false, selection: { start: { line: 41, character: 0 } } });
    });
});

describe('a link in the property panel', () => {
    it('is an element of the diagram when it is a fragment', () => {
        expect(classifyLink('#node:scope:root:PIPE-ISSUE-001')).toEqual({ kind: 'element', id: 'node:scope:root:PIPE-ISSUE-001' });
        expect(classifyLink('#node%3Aa%20b')).toEqual({ kind: 'element', id: 'node:a b' });
    });

    it('is a URL for the browser, or a file reference for the host', () => {
        expect(classifyLink('https://example.org/x')).toEqual({ kind: 'external', href: 'https://example.org/x' });
        expect(classifyLink('gen/membus/memif.py#L12')).toEqual({ kind: 'reference', href: 'gen/membus/memif.py#L12' });
        expect(classifyLink('/abs/doc.md#L3')).toEqual({ kind: 'reference', href: '/abs/doc.md#L3' });
    });

    it('is nothing to follow when empty or a script', () => {
        expect(classifyLink('')).toBeUndefined();
        expect(classifyLink('#')).toBeUndefined();
        expect(classifyLink('javascript:alert(1)')).toBeUndefined();
    });

    it('goes to the host flagged as a reference, with the file it was written in', () => {
        const action: any = referenceAction({ kind: 'reference', href: 'picorv32.v:1202-1210' }, 'file:///w/spec/doc.md');
        const target = action.target ?? action;

        expect(target.uri).toBe('picorv32.v:1202-1210');
        expect(target.args).toEqual({ [OPEN_REFERENCE_ARG]: true, [REFERENCE_BASE_ARG]: 'file:///w/spec/doc.md' });
    });
});
