/**
 * Which files a profile's diagram is a view of.
 *
 * The core used to answer that with one product's file extension, written out as
 * a literal: six path tests plus a file-system watcher glob. That is a product's
 * file naming compiled into the platform. A consumer whose sources end in
 * anything else got a diagram command that silently refused every file it was
 * given, and a warning telling it to open a file of a kind it does not have —
 * text it could not change, naming an extension it does not use.
 *
 * A profile declares its own extensions instead ({@link DiagramProfile.sourceExtensions}),
 * and every one of those sites asks here. The platform still names none.
 *
 * The permissive default is the deliberate half of this. A profile that declares
 * nothing gets no filtering at all, rather than a guess: the core cannot know how
 * a product names its files, and a wrong guess fails in the worst way available —
 * the command does nothing, says nothing useful, and looks like the file is
 * missing. Letting an unrecognised file through instead hands the decision to the
 * profile's own `canOpenSource`, which can refuse it with a reason that means
 * something.
 */

/**
 * Fold a declared list into the form the matcher compares against: lower-case,
 * dot-prefixed, no blanks.
 *
 * The API asks for exactly that form, so this normally changes nothing. It runs
 * anyway because the failure it prevents is invisible: `'foo'` without the dot,
 * or `'.FOO'` from a product whose files are upper-case, would match no file at
 * all, and "matches nothing" is indistinguishable here from "the workspace has
 * no sources". Accepting the near-miss costs one pass over a list of two.
 */
export function normalizeSourceExtensions(
    extensions: readonly string[] | undefined
): string[] {
    if (!extensions) {
        return [];
    }
    const normalized: string[] = [];
    for (const raw of extensions) {
        const trimmed = raw.trim().toLowerCase();
        if (trimmed === '' || trimmed === '.') {
            continue;
        }
        const withDot = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
        if (!normalized.includes(withDot)) {
            normalized.push(withDot);
        }
    }
    return normalized;
}

/**
 * True when `filePath` is one of the profile's source files — or when the
 * profile declared none, in which case every path qualifies (see the module
 * note on why the default is permissive rather than restrictive).
 */
export function matchesSourceExtension(
    filePath: string | undefined,
    extensions: readonly string[] | undefined
): boolean {
    const declared = normalizeSourceExtensions(extensions);
    if (declared.length === 0) {
        return true;
    }
    if (!filePath) {
        return false;
    }
    const lowered = filePath.toLowerCase();
    return declared.some(extension => lowered.endsWith(extension));
}

/**
 * The noun a user-facing message uses for the file the command wanted: `.foo
 * file`, `.foo or .bar file`, `.foo, .bar or .baz file` — and plain `source
 * file` when the profile declared nothing.
 *
 * Messages are built from this rather than written out, because a message that
 * names an extension is a message the core cannot write: it would have to know
 * the answer to the question this whole module exists to delegate.
 */
export function sourceFileNoun(extensions: readonly string[] | undefined): string {
    const declared = normalizeSourceExtensions(extensions);
    if (declared.length === 0) {
        return 'source file';
    }
    if (declared.length === 1) {
        return `${declared[0]} file`;
    }
    const last = declared[declared.length - 1];
    return `${declared.slice(0, -1).join(', ')} or ${last} file`;
}

/**
 * Watcher globs for the profile's sources.
 *
 * With nothing declared this is `**\/*` — every file in the workspace, which is
 * the honest reading of "the platform does not filter by extension", and the
 * same trade the matcher makes. It is not as expensive as it looks: the handler
 * ignores any path outside an open diagram's tree of interest, and a profile
 * that cares about the watcher cost declares either `sourceExtensions` or its
 * own `watch.globs`, both of which win over this fallback.
 */
export function sourceWatchGlobs(extensions: readonly string[] | undefined): string[] {
    const declared = normalizeSourceExtensions(extensions);
    if (declared.length === 0) {
        return ['**/*'];
    }
    return declared.map(extension => `**/*${extension}`);
}
