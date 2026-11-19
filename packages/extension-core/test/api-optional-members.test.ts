// What a product's own code compiles against the API.
//
// The API version stays 0.8.0 until the release, so a product built against
// this API can meet an installed Dialogram that reports 0.8.0 and predates a
// member. A member the platform hands a product (on the handle, and on any
// other object it gives one) is therefore optional, as `runCli` is, and the
// product checks for it before calling. And a product that stubs the handle
// in its own tests, with only what an older API had, still compiles: under
// `strict`, as a product's build is.
import { beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The product files compiled, each beside this test, importing the API as `../src/api`. */
const PRODUCT_FILES: Record<string, string> = {
    // A test stub of the handle, written against 0.8.0 as it shipped.
    'handle-stub.ts': `
        import type { DiagramProfileHandle } from '../src/api';
        export const handle: DiagramProfileHandle = {
            chat: { runDiagnostics() {}, showLog() {} },
            dispatchToWebview() {},
            postToWebview() {},
            dispose() {}
        };
    `,
    // A product that uses what is new, after checking that it is there.
    'handle-use.ts': `
        import type { DiagramProfileHandle } from '../src/api';
        export async function report(handle: DiagramProfileHandle, uri: string): Promise<void> {
            handle.loading?.report(uri, { message: 'Placing cells' });
            handle.loading?.end(uri);
            handle.revealOutlineRow?.(uri, { group: 'cells', id: 'c1' });
            if (handle.getViewOptions && handle.setViewOptions) {
                const groups = await handle.getViewOptions(uri);
                await handle.setViewOptions(uri, { group: groups[0].id, all: true });
            }
        }
    `,
    // \`watch\` with \`affects\` and the default globs.
    'watch-affects.ts': `
        import type { DiagramProfile } from '../src/api';
        export const watch: DiagramProfile['watch'] = { affects: (_changed, open) => open };
    `
};

let diagnostics: Map<string, string[]>;

beforeAll(() => {
    const files = new Map(Object.entries(PRODUCT_FILES).map(([name, text]) => [path.join(here, `__product__${name}`), text]));
    const options: ts.CompilerOptions = {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        experimentalDecorators: true,
        lib: ['lib.es2020.d.ts', 'lib.dom.d.ts']
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    host.getSourceFile = (fileName, languageVersion, ...rest) => {
        const text = files.get(path.resolve(fileName));
        return text !== undefined ? ts.createSourceFile(fileName, text, languageVersion) : getSourceFile(fileName, languageVersion, ...rest);
    };
    host.fileExists = fileName => files.has(path.resolve(fileName)) || fileExists(fileName);
    const program = ts.createProgram([...files.keys()], options, host);
    diagnostics = new Map();
    for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
        const file = diagnostic.file ? path.resolve(diagnostic.file.fileName) : '';
        if (files.has(file)) {
            const name = path.basename(file).replace('__product__', '');
            diagnostics.set(name, [...(diagnostics.get(name) ?? []), ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')]);
        }
    }
}, 60_000);

describe('a product compiled against the API, under strict', () => {
    it('stubs the handle with only what 0.8.0 shipped', () => {
        expect(diagnostics.get('handle-stub.ts') ?? []).toEqual([]);
    });

    it('calls a member that is new only after checking for it', () => {
        expect(diagnostics.get('handle-use.ts') ?? []).toEqual([]);
    });

    it('gives `watch` its `affects` alone, with the default globs', () => {
        expect(diagnostics.get('watch-affects.ts') ?? []).toEqual([]);
    });
});
