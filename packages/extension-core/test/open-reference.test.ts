/**
 * Resolving a reference clicked in the property panel.
 *
 * The forms people write (`picorv32.v:1202-1210`, `memif.py::MemIf.hold_nop`,
 * `top.sv#L40`, `file:` URIs, absolute paths) are read into a path and a
 * place. A relative path is tried against the file the text came from and the
 * folders above it, then searched for in the workspace by its trailing path,
 * the closest match first. A symbol lands on its definition when it has one.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReference, rankByCloseness, resolveReferencePath, symbolLine, type ReferenceFileSystem } from '../src/extension/diagram/open-reference';

describe('parseReference', () => {
    it('reads line ranges after a colon or as a fragment', () => {
        expect(parseReference('picorv32.v:1202-1210')).toEqual({ kind: 'file', path: 'picorv32.v', line: 1202, endLine: 1210 });
        expect(parseReference('rtl/top.sv#L40')).toEqual({ kind: 'file', path: 'rtl/top.sv', line: 40 });
        expect(parseReference('rtl/top.sv#L40-L44')).toEqual({ kind: 'file', path: 'rtl/top.sv', line: 40, endLine: 44 });
    });

    it('reads a symbol after :: or as a fragment', () => {
        expect(parseReference('membus/memif.py::MemIf.hold_nop')).toEqual({ kind: 'file', path: 'membus/memif.py', symbol: 'MemIf.hold_nop' });
        expect(parseReference('picorv32.v#latched_store')).toEqual({ kind: 'file', path: 'picorv32.v', symbol: 'latched_store' });
    });

    it('reads file URIs and absolute paths, and leaves URLs to the browser', () => {
        expect(parseReference('file:///w/gen/a%20b.py#L3')).toEqual({ kind: 'file', path: '/w/gen/a b.py', line: 3 });
        expect(parseReference('/w/spec/doc.md#L11')).toEqual({ kind: 'file', path: '/w/spec/doc.md', line: 11 });
        expect(parseReference('https://example.org')).toEqual({ kind: 'external', url: 'https://example.org' });
        expect(parseReference('  ')).toBeUndefined();
    });
});

/** A workspace of these files, rooted at /w. */
const workspace = (files: string[]): ReferenceFileSystem => ({
    async exists(file) {
        return files.includes(path.normalize(file));
    },
    async findByTrailingPath(relative) {
        return files.filter(file => file.endsWith(`/${relative}`));
    },
    workspaceFolderOf(file) {
        return file.startsWith('/w/') ? '/w' : undefined;
    }
});

describe('resolveReferencePath', () => {
    const files = [
        '/w/proj/spec/10-arch/pipeline.md',
        '/w/proj/gen/membus/memif.py',
        '/w/proj/README.md',
        '/w/picorv32/picorv32.v',
        '/w/proj/ac/build/s4/picorv32.v'
    ];
    const base = '/w/proj/spec/10-arch/pipeline.md';

    it('takes an absolute path as it is, when it exists', async () => {
        expect(await resolveReferencePath('/w/proj/README.md', base, workspace(files))).toEqual(['/w/proj/README.md']);
        expect(await resolveReferencePath('/w/nope.md', base, workspace(files))).toEqual([]);
    });

    it('tries the folders from the text’s own up to the workspace folder', async () => {
        expect(await resolveReferencePath('../../README.md', base, workspace(files))).toEqual(['/w/proj/README.md']);
        expect(await resolveReferencePath('gen/membus/memif.py', base, workspace(files))).toEqual(['/w/proj/gen/membus/memif.py']);
    });

    it('searches the workspace by trailing path, the closest first', async () => {
        expect(await resolveReferencePath('membus/memif.py', base, workspace(files))).toEqual(['/w/proj/gen/membus/memif.py']);
        expect(await resolveReferencePath('picorv32.v', base, workspace(files)))
            .toEqual(['/w/proj/ac/build/s4/picorv32.v', '/w/picorv32/picorv32.v']);
    });

    it('ranks by shared folders, then by length', () => {
        expect(rankByCloseness(['/a/x/y/f', '/b/f', '/a/x/f'], '/a/x/z')).toEqual(['/a/x/f', '/a/x/y/f', '/b/f']);
    });
});

describe('symbolLine', () => {
    const python = ['class MemIf:', '    def hold_take(self):', '        self.hold_nop()', '    def hold_nop(self):', '        pass'].join('\n');

    it('lands on the definition of the last segment, over an earlier mention', () => {
        expect(symbolLine(python, 'MemIf.hold_nop')).toBe(4);
        expect(symbolLine(python, 'MemIf')).toBe(1);
    });

    it('falls back to the first whole-word mention, and to nothing', () => {
        expect(symbolLine('assign latched_store = 1;\nreg latched_stores;', 'latched_store')).toBe(1);
        expect(symbolLine(python, 'missing')).toBeUndefined();
    });
});
