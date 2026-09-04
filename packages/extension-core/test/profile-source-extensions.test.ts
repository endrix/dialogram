/**
 * A product says what its source files are called; the platform stops guessing.
 *
 * The core answered "is this URI one of the product's sources?" by testing the path
 * against one product's extension, written out as a literal — in the open-diagram
 * commands, the rename command's active-file lookup, the editor provider's save
 * handler and its on-disk watcher. For a consumer whose files end in anything else,
 * every one of those refused every file, and the warning it got named an extension
 * it does not use.
 *
 * These tests pin both halves of the contract: a declared list filters and words the
 * messages, and NO declaration filters nothing — the permissive default, which is
 * what the core owes a product whose naming it cannot know.
 */
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { DiagramProfile } from '../src/api';
import { resolveDiagramOpenTarget } from '../src/extension/diagram/open-diagram-target';
import {
    matchesSourceExtension,
    normalizeSourceExtensions,
    sourceFileNoun,
    sourceWatchGlobs
} from '../src/extension/diagram/source-extensions';

vi.mock('@eclipse-glsp/vscode-integration', () => ({
    GlspEditorProvider: class {
        onDidChangeCustomDocument: unknown;
        constructor(protected readonly glspVscodeConnector: any) {
            this.onDidChangeCustomDocument = glspVscodeConnector?.onDidChangeCustomDocument;
        }
    },
    GlspVscodeConnector: class {}
}));

const { WorkflowEditorProvider } = await import('../src/extension/diagram/diagram-editor-provider');

describe('matchesSourceExtension', () => {
    it('accepts only the declared extensions', () => {
        expect(matchesSourceExtension('/repo/graph.foo', ['.foo', '.bar'])).toBe(true);
        expect(matchesSourceExtension('/repo/graph.bar', ['.foo', '.bar'])).toBe(true);
        expect(matchesSourceExtension('/repo/graph.baz', ['.foo', '.bar'])).toBe(false);
    });

    it('accepts anything when a profile declares nothing', () => {
        // The deliberate default. A core that refused what it did not recognise
        // would fail as silence — the command does nothing and the file looks
        // absent — instead of letting the profile refuse it for a real reason.
        expect(matchesSourceExtension('/repo/graph.anything', undefined)).toBe(true);
        expect(matchesSourceExtension('/repo/graph.anything', [])).toBe(true);
    });

    it('ignores case, so an upper-case file still matches', () => {
        expect(matchesSourceExtension('/repo/GRAPH.FOO', ['.foo'])).toBe(true);
    });

    it('tolerates a declaration missing the dot rather than matching nothing', () => {
        // A near-miss declaration would otherwise match no file at all, which
        // looks exactly like a workspace with no sources in it.
        expect(normalizeSourceExtensions(['foo', '.BAR', ' ', '.foo'])).toEqual(['.foo', '.bar']);
        expect(matchesSourceExtension('/repo/graph.foo', ['foo'])).toBe(true);
    });
});

describe('sourceFileNoun', () => {
    it('names the declared extensions, and nothing when none are declared', () => {
        expect(sourceFileNoun(['.foo'])).toBe('.foo file');
        expect(sourceFileNoun(['.foo', '.bar'])).toBe('.foo or .bar file');
        expect(sourceFileNoun(['.foo', '.bar', '.baz'])).toBe('.foo, .bar or .baz file');
        expect(sourceFileNoun(undefined)).toBe('source file');
    });
});

describe('sourceWatchGlobs', () => {
    it('derives one glob per declared extension, and watches everything otherwise', () => {
        expect(sourceWatchGlobs(['.foo', '.bar'])).toEqual(['**/*.foo', '**/*.bar']);
        expect(sourceWatchGlobs(undefined)).toEqual(['**/*']);
    });
});

describe('resolveDiagramOpenTarget with declared source extensions', () => {
    const openTextDocument = vi.fn(async (uri: vscode.Uri) => ({ uri }));

    it('opens a file whose extension the profile declared', async () => {
        const target = '/repo/designs/pipeline.foo';
        const resolved = await resolveDiagramOpenTarget(target, {
            getActiveWorkflowUri: () => undefined,
            openTextDocument,
            sourceExtensions: ['.foo']
        });

        expect(resolved?.toString()).toBe(vscode.Uri.file(target).toString());
    });

    it('refuses a file the profile did not declare', async () => {
        const resolved = await resolveDiagramOpenTarget('/repo/designs/notes.txt', {
            getActiveWorkflowUri: () => undefined,
            openTextDocument,
            sourceExtensions: ['.foo']
        });

        expect(resolved).toBeUndefined();
    });

    it('opens anything when the profile declared nothing', async () => {
        // The control for the case above: the refusal has to come from the
        // declaration, not from the platform having an opinion of its own.
        const target = '/repo/designs/notes.txt';
        const resolved = await resolveDiagramOpenTarget(target, {
            getActiveWorkflowUri: () => undefined,
            openTextDocument
        });

        expect(resolved?.toString()).toBe(vscode.Uri.file(target).toString());
    });
});

describe('WorkflowEditorProvider source watching', () => {
    function build(profile: Partial<DiagramProfile>): { globs: string[]; provider: any } {
        const globs: string[] = [];
        const spy = vi.spyOn(vscode.workspace, 'createFileSystemWatcher').mockImplementation(((glob: string) => {
            globs.push(glob);
            return {
                onDidChange: () => ({ dispose: () => undefined }),
                onDidCreate: () => ({ dispose: () => undefined }),
                dispose: () => undefined
            };
        }) as any);
        const connector = { onDidChangeCustomDocument: undefined, dispatchAction: () => undefined } as any;
        const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext;
        const provider: any = new WorkflowEditorProvider(context, connector, profile as DiagramProfile);
        spy.mockRestore();
        return { globs, provider };
    }

    it('watches one glob per declared extension', () => {
        expect(build({ sourceExtensions: ['.foo', '.bar'] }).globs).toEqual(['**/*.foo', '**/*.bar']);
    });

    it("prefers the profile's own watch globs, which may be wider than its sources", () => {
        // `watch.globs` was declared on the profile and read by nothing until now.
        // It is the more specific statement, so it wins over the derived globs.
        expect(build({ sourceExtensions: ['.foo'], watch: { globs: ['**/*.foo', '**/manifest.json'] } }).globs)
            .toEqual(['**/*.foo', '**/manifest.json']);
    });

    it('watches everything when a profile declares neither', () => {
        expect(build({}).globs).toEqual(['**/*']);
    });

    it('ignores an on-disk change to a file outside the declared extensions', () => {
        const dispatched: string[] = [];
        const { provider } = build({ sourceExtensions: ['.foo'] });
        provider.dispatchModelRefresh = (_clientId: string, uri: string) => dispatched.push(uri);
        const source = vscode.Uri.file('/repo/designs/pipeline.foo');
        provider.uriToClientId.set(provider.canonicalizeUriString(source), 'client-0');

        vi.useFakeTimers();
        provider.handleExternalFileChange(vscode.Uri.file('/repo/designs/README.md'));
        vi.runAllTimers();
        expect(dispatched, 'a file the product does not own triggered a reload').toEqual([]);

        provider.handleExternalFileChange(vscode.Uri.file('/repo/designs/helper.foo'));
        vi.runAllTimers();
        vi.useRealTimers();
        expect(dispatched.length, 'a declared sibling source failed to trigger a reload').toBe(1);
    });
});
