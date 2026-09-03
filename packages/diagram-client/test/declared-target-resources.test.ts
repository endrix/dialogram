/**
 * A declared target is not always a file you open in an editor.
 *
 * The declared route was written for one shape — a file, opened with a named
 * editor — and hardcoded all three of those. So a folder was handed to a
 * command that wants an editor, a URL was concatenated onto the diagram's own
 * directory into nonsense, and leaving the editor unnamed was an error rather
 * than "just open it".
 *
 * What the target IS gets decided where the filesystem is visible — by whoever
 * exported the graph — and travels as `kind`. This turns that into an action.
 */
import { describe, expect, it } from 'vitest';
import { ViewerMouseListener } from '../src/viewer-mouse-listener';
import { WorkflowDiagramTypes, WorkflowDiagramMetadata } from '@dialogram/shared';

const SOURCE_URI = 'file:///w/flow.py';

/**
 * `sourceUri` is a required parameter deliberately. With a default, the
 * no-source cases below would pass `undefined` and silently get the default
 * back — JavaScript applies a default to an explicit `undefined` — so those
 * tests would assert against the ordinary case and pass for the wrong reason.
 */
function openAt(args: Record<string, string>, sourceUri: string | undefined): any {
    const node: any = {
        id: 'n1',
        type: WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR,
        args: {
            [WorkflowDiagramMetadata.IS_EXTERNAL_ACTOR]: true,
            [WorkflowDiagramMetadata.ENTITY_DEFINITION_ANNOTATIONS]: [
                {
                    name: 'viewer',
                    arguments: Object.entries({ source: 'declared', ...args })
                        .map(([name, value]) => ({ name, value: `"${value}"` }))
                }
            ]
        },
        children: [],
        root: { args: {}, children: [] }
    };
    node.root.children = [node];
    const listener: any = new ViewerMouseListener();
    listener.editorContext = { sourceUri };
    return listener.doubleClick(node, {} as MouseEvent)[0];
}

const open = (args: Record<string, string>): any => openAt(args, SOURCE_URI);

describe('a declared file', () => {
    it('opens with the named editor when one is named', () => {
        const action = open({ path: 'out/report.html', viewType: 'product.preview' });

        expect(action.args['wf:viewerAction']).toBe('openWith');
        expect(action.args['wf:viewerViewType']).toBe('product.preview');
        expect(action.uri).toBe('file:///w/out/report.html');
    });

    /**
     * Naming no editor means the default one, which is what the host already
     * does with an empty viewType. It used to be an error, so a plain text file
     * could not be declared at all.
     */
    it('opens in the default editor when none is named', () => {
        const action = open({ path: 'notes.md' });

        expect(action.args['wf:viewerAction']).toBe('open');
        expect(action.uri).toBe('file:///w/notes.md');
    });
});

describe('a declared web resource', () => {
    it('keeps the URL instead of resolving it beside the diagram', () => {
        const action = open({ path: 'https://example.com/spec.json', kind: 'http' });

        expect(action.uri).toBe('https://example.com/spec.json');
    });

    /**
     * `open` and not `openWith`: no editor is registered for an https URI, so
     * openWith dead-ends. Plain open hands it to the host, which launches a
     * browser.
     */
    it('opens it rather than looking for an editor', () => {
        const action = open({
            path: 'https://example.com/spec.json',
            kind: 'http',
            viewType: 'product.preview'
        });

        expect(action.args['wf:viewerAction']).toBe('open');
    });

    it('leaves any other scheme alone too', () => {
        expect(open({ path: 'vscode://extension/page' }).uri).toBe('vscode://extension/page');
    });
});

describe('a declared folder', () => {
    /**
     * A directory has no editor to open in — every route through `open` or
     * `openWith` fails on one. Revealing it is the operation that exists.
     */
    it('is revealed rather than opened', () => {
        const action = open({ path: 'designs/', kind: 'folder' });

        expect(action.args['wf:viewerAction']).toBe('reveal');
        expect(action.uri).toBe('file:///w/designs/');
    });

    it('is revealed even when an editor was named', () => {
        const action = open({ path: 'designs/', kind: 'folder', viewType: 'product.preview' });

        expect(action.args['wf:viewerAction']).toBe('reveal');
    });
});

describe('a declared target with nothing to resolve against', () => {
    /**
     * `sourceUri` is optional on the editor context. A relative path used to be
     * concatenated onto it unchecked, which threw inside the mouse listener —
     * caught only because the package does not typecheck strictly.
     */
    it('says so instead of throwing', () => {
        const action = openAt({ path: 'out/report.html' }, undefined);

        expect(action.args['wf:viewerAction']).toBe('error');
        expect(action.args['wf:viewerMessage']).toMatch(/relative/i);
    });

    it('still opens an absolute path', () => {
        const action = openAt({ path: '/abs/report.html' }, undefined);

        expect(action.args['wf:viewerAction']).toBe('open');
        expect(action.uri).toBe('/abs/report.html');
    });

    it('still opens a URL', () => {
        expect(openAt({ path: 'https://example.com/x' }, undefined).uri)
            .toBe('https://example.com/x');
    });
});
