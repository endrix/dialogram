/**
 * Where an imported name's definition lives, read from the importing file the
 * way Python would: `from pcpi.div import Div` in `gen/network/picorv32.py`
 * means `pcpi/div.py` under whichever ancestor directory is the import root.
 *
 * The drill-down asks this before any workspace-wide search, so it does not
 * depend on the language server's import roots or on which files it indexes:
 * a multi-project workspace can hold several `Div`s, and only the import says
 * which one the network uses.
 */
import * as path from 'node:path';

// `from <module> import <names>`, the names either bare or parenthesized
// (possibly over several lines).
const FROM_IMPORT = /^[ \t]*from[ \t]+(\.*[A-Za-z_][\w.]*|\.+)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]*)/gm;

function importedNames(clause: string): string[] {
    return clause
        .replace(/[()]/g, '')
        .split(',')
        .map(part => part.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
        .filter(name => name !== '');
}

/** The modules `symbolName` is imported from in `sourceText`, as written (`pcpi.div`, `.div`). */
export function findImportingModules(sourceText: string, symbolName: string): string[] {
    const modules: string[] = [];
    for (const match of sourceText.matchAll(FROM_IMPORT)) {
        const [, module, clause] = match;
        if (module && clause && importedNames(clause).includes(symbolName)) {
            modules.push(module);
        }
    }
    return modules;
}

function ancestorsOf(dir: string): string[] {
    const parent = path.dirname(dir);
    return parent === dir ? [dir] : [dir, ...ancestorsOf(parent)];
}

function moduleFiles(base: string, dotted: string): string[] {
    const segments = dotted.split('.').filter(segment => segment !== '');
    if (segments.length === 0) {
        return [];
    }
    const modulePath = path.join(base, ...segments);
    return [`${modulePath}.py`, path.join(modulePath, '__init__.py')];
}

/**
 * The files that may define a module imported as `module` from the file at
 * `sourcePath`, nearest import root first.
 */
export function candidateModuleFiles(module: string, sourcePath: string): string[] {
    const sourceDir = path.dirname(sourcePath);
    const dots = /^\.*/.exec(module)?.[0].length ?? 0;
    if (dots > 0) {
        // `.div` is beside the source, `..div` one level up.
        const base = ancestorsOf(sourceDir)[dots - 1];
        return base ? moduleFiles(base, module.slice(dots)) : [];
    }
    return ancestorsOf(sourceDir).flatMap(dir => moduleFiles(dir, module));
}
