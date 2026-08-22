/**
 * Which editors this VS Code can open a file with.
 *
 * A workflow ends in something to look at, and the node that shows it has to
 * name an editor. Asking the reader to know that `vscode.markdown.preview.editor`
 * exists is the problem this replaces, so the list has to be worth trusting:
 * complete enough that a viewer someone knows is installed appears, and honest
 * about which entries are a guess.
 */
import { describe, expect, it } from 'vitest';
import {
    ExtensionManifest,
    discoverViewerEditors,
    patternMatches,
    rankForFile
} from '../src/extension/chat/viewer-editors';

const markdown: ExtensionManifest = {
    id: 'vscode.markdown-language-features',
    displayName: 'Markdown Language Features',
    commands: [
        { command: 'markdown.showPreview', title: 'Open Preview' },
        { command: 'markdown.api.render', title: 'Render Markdown' }
    ]
};

const imagePreview: ExtensionManifest = {
    id: 'vscode.image-preview',
    displayName: 'Image Preview',
    customEditors: [
        {
            viewType: 'imagePreview.previewEditor',
            displayName: 'Image Preview',
            selector: [{ filenamePattern: '*.png' }, { filenamePattern: '*.jpg' }]
        }
    ]
};

const noise: ExtensionManifest = {
    id: 'some.extension',
    displayName: 'Some Extension',
    commands: [
        { command: 'some.openSettings', title: 'Open Settings' },
        { command: 'some.showOutput', title: 'Show Output Channel' },
        { command: 'some.doThing', title: 'Do Thing' }
    ]
};

describe('what counts as an available viewer', () => {
    it('finds custom editors, with the files they claim', () => {
        const [found] = discoverViewerEditors([imagePreview]);
        expect(found).toMatchObject({
            kind: 'customEditor',
            viewType: 'imagePreview.previewEditor',
            label: 'Image Preview',
            patterns: ['*.png', '*.jpg']
        });
    });

    it('finds preview COMMANDS too — most viewers people use are not custom editors', () => {
        // The Markdown preview, the image preview and Simple Browser are
        // commands. A list built from `contributes.customEditors` alone misses
        // them, which is most of what a reader would look for.
        const found = discoverViewerEditors([markdown]);
        expect(found.map(o => o.command)).toContain('markdown.showPreview');
    });

    it('marks a command as a command, so the chat can present it as a guess', () => {
        // A custom editor DECLARES what it opens; a command's manifest says
        // nothing, so recognising one is inference and must not be dressed up
        // as fact.
        const [found] = discoverViewerEditors([markdown]);
        expect(found.kind).toBe('command');
        expect(found.patterns).toEqual([]);
    });

    it('leaves out commands that open something other than a file', () => {
        const ids = discoverViewerEditors([noise]).map(o => o.command);
        expect(ids).not.toContain('some.openSettings');
        expect(ids).not.toContain('some.showOutput');
        expect(ids).not.toContain('some.doThing');
    });

    it('puts custom editors before commands', () => {
        // The declared ones are the reliable ones, so they lead.
        const found = discoverViewerEditors([markdown, imagePreview]);
        expect(found[0].kind).toBe('customEditor');
    });

    it('says each viewer once, however many extensions contribute it', () => {
        const twice = discoverViewerEditors([imagePreview, { ...imagePreview, id: 'fork.image' }]);
        expect(twice).toHaveLength(1);
    });

    it('keeps its footing on a manifest that contributes nothing', () => {
        expect(discoverViewerEditors([{ id: 'empty' }])).toEqual([]);
    });
});

describe('which viewer claims a file', () => {
    it('matches a plain extension glob', () => {
        expect(patternMatches('*.md', 'notes.md')).toBe(true);
        expect(patternMatches('*.md', 'notes.txt')).toBe(false);
    });

    it('matches a path glob against a full path', () => {
        expect(patternMatches('**/*.mlir', '/w/src/top.mlir')).toBe(true);
    });

    it('ignores case, because file systems disagree about it', () => {
        expect(patternMatches('*.PNG', 'plot.png')).toBe(true);
    });

    it('is not fooled by the dot in a glob', () => {
        // `.` is a regex wildcard: unescaped, `*.md` would match `notesXmd`.
        expect(patternMatches('*.md', 'notesXmd')).toBe(false);
    });
});

describe('ranking for the file at hand', () => {
    const all = discoverViewerEditors([markdown, imagePreview]);

    it('leads with the viewers that claim the file', () => {
        expect(rankForFile(all, 'plot.png')[0].viewType).toBe('imagePreview.previewEditor');
    });

    it('still offers every other viewer', () => {
        // Ranked, never filtered: a manifest's claim is a claim and not a
        // limit, and a reader who cannot see an editor they know is installed
        // stops trusting the list.
        expect(rankForFile(all, 'plot.png')).toHaveLength(all.length);
        expect(rankForFile(all, 'report.md')).toHaveLength(all.length);
    });

    it('changes nothing when there is no file to rank against', () => {
        expect(rankForFile(all, undefined)).toEqual(all);
    });

    it('keeps the original order within each group', () => {
        const many = discoverViewerEditors([imagePreview, markdown, noise]);
        const ranked = rankForFile(many, 'nothing.xyz');
        expect(ranked).toEqual(many);
    });
});
