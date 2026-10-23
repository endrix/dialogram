/**
 * Opening a reference a person clicked in the property panel.
 *
 * The panel's text is the producer's, and it names files the way people do:
 * `gen/membus/memif.py`, `picorv32.v:1202-1210`, `memif.py::MemIf.hold_nop`,
 * `rtl/top.sv#L40`, or an absolute path the producer resolved itself. The
 * webview cannot tell which of those exist, so the host resolves them, the way
 * a person would look:
 *
 * 1. an absolute path, or a `file:` URI, as it is;
 * 2. relative to the file the text came from, then to each folder above it up
 *    to its workspace folder (a path written from a project's root, read in a
 *    document deeper down);
 * 3. anywhere in the workspace, by its trailing path, the matches ranked by how
 *    close they are to that file. One match opens; several are offered, the
 *    closest first.
 *
 * What follows the path picks the place: `#L12`, `#L12-L20` or `:12-20` a
 * line range, `::Name.member` or `#name` a symbol, found in the file as its
 * definition when there is one, else its first mention.
 */
import * as path from 'node:path';

export type ParsedReference =
    | { kind: 'external'; url: string }
    | { kind: 'file'; path: string; line?: number; endLine?: number; symbol?: string };

/** What a clicked href names. */
export function parseReference(href: string): ParsedReference | undefined {
    let value = href.trim();
    if (!value) {
        return undefined;
    }
    if (/^(https?|mailto):/i.test(value)) {
        return { kind: 'external', url: value };
    }
    let line: number | undefined;
    let endLine: number | undefined;
    let symbol: string | undefined;

    const hash = value.indexOf('#');
    if (hash >= 0) {
        const fragment = decode(value.slice(hash + 1));
        value = value.slice(0, hash);
        const range = /^L(\d+)(?:-L?(\d+))?$/i.exec(fragment);
        if (range) {
            line = Number(range[1]);
            endLine = range[2] ? Number(range[2]) : undefined;
        } else if (fragment) {
            symbol = fragment;
        }
    }
    if (/^file:/i.test(value)) {
        value = decode(value.replace(/^file:\/\//i, ''));
        // file:///C:/x → C:/x on Windows; on POSIX the leading slash stays.
        if (/^\/[A-Za-z]:\//.test(value)) {
            value = value.slice(1);
        }
    } else {
        value = decode(value);
    }
    const member = /^(.*\.[A-Za-z0-9_]{1,10})::([A-Za-z_][\w.]*)$/.exec(value);
    if (member) {
        value = member[1];
        symbol ??= member[2];
    }
    const lines = /^(.*\.[A-Za-z0-9_]{1,10}):(\d+)(?:-(\d+))?$/.exec(value);
    if (lines && line === undefined) {
        value = lines[1];
        line = Number(lines[2]);
        endLine = lines[3] ? Number(lines[3]) : undefined;
    }
    if (!value) {
        return undefined;
    }
    return { kind: 'file', path: value, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}), ...(symbol ? { symbol } : {}) };
}

/** How many leading path segments two absolute paths share. */
function sharedSegments(a: string, b: string): number {
    const left = path.resolve(a).split(path.sep);
    const right = path.resolve(b).split(path.sep);
    let n = 0;
    while (n < left.length && n < right.length && left[n] === right[n]) {
        n++;
    }
    return n;
}

/** Candidates, closest to `baseDir` first: most shared folders, then the shortest path. */
export function rankByCloseness(candidates: readonly string[], baseDir: string | undefined): string[] {
    const unique = [...new Set(candidates)];
    if (!baseDir) {
        return unique.sort((a, b) => a.length - b.length || a.localeCompare(b));
    }
    return unique.sort((a, b) =>
        sharedSegments(b, baseDir) - sharedSegments(a, baseDir) || a.length - b.length || a.localeCompare(b));
}

export interface ReferenceFileSystem {
    exists(file: string): Promise<boolean>;
    /** Files whose path ends with `relative`, anywhere in the workspace. */
    findByTrailingPath(relative: string): Promise<string[]>;
    /** The workspace folder holding `file`, if any. */
    workspaceFolderOf(file: string): string | undefined;
}

/** Where a file reference may point, best first; empty when it names nothing that exists. */
export async function resolveReferencePath(
    reference: string,
    baseFile: string | undefined,
    fs: ReferenceFileSystem
): Promise<string[]> {
    if (path.isAbsolute(reference)) {
        return (await fs.exists(reference)) ? [path.normalize(reference)] : [];
    }
    const baseDir = baseFile ? path.dirname(baseFile) : undefined;
    if (baseDir) {
        const stop = fs.workspaceFolderOf(baseFile!);
        let dir = baseDir;
        for (;;) {
            const candidate = path.resolve(dir, reference);
            if (await fs.exists(candidate)) {
                return [candidate];
            }
            const parent = path.dirname(dir);
            if (parent === dir || (stop && path.relative(stop, dir) === '')) {
                break;
            }
            dir = parent;
        }
    }
    // The trailing path, without the ./ and ../ that only made sense from the base.
    const trailing = reference.split(/[\\/]/).filter(part => part !== '.' && part !== '..' && part !== '').join('/');
    if (!trailing) {
        return [];
    }
    return rankByCloseness(await fs.findByTrailingPath(trailing), baseDir);
}

/**
 * The 1-based line `symbol` is defined on in `text`, else first mentioned on:
 * the last segment of a dotted name (`MemIf.hold_nop` → `hold_nop`) after a
 * definition keyword of the common languages, then as a whole word anywhere.
 */
export function symbolLine(text: string, symbol: string): number | undefined {
    const name = symbol.split(/[.:]/).filter(Boolean).pop();
    if (!name) {
        return undefined;
    }
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lines = text.split(/\r?\n/);
    const definition = new RegExp(
        `\\b(def|class|fn|function|func|struct|enum|trait|interface|type|module|entity|architecture|package|component|const|let|var|signal|reg|wire|logic)\\s+${escaped}\\b`
    );
    const word = new RegExp(`(^|[^\\w])${escaped}([^\\w]|$)`);
    for (const pattern of [definition, word]) {
        const index = lines.findIndex(line => pattern.test(line));
        if (index >= 0) {
            return index + 1;
        }
    }
    return undefined;
}

function decode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
