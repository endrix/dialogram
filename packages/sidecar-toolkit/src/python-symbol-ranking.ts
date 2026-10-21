/**
 * Ranking for the workspace-symbol fallback of the Python drill-down: which of
 * the symbols a workspace search for a definition's name returns is the
 * definition. Pure, so it is testable without a language server.
 *
 * A search for `Load` also returns the instance `load` in `load = Load()`, in
 * the very file being drilled from. Python names are case-sensitive, so only an
 * exact name counts, and being a declaration outweighs being near the source.
 */
import * as path from 'node:path';

export interface WorkspaceSymbolCandidate {
    /** The symbol's name as the provider reports it. */
    readonly name: string;
    /** Whether the symbol is a class, function, method or constructor. */
    readonly isDeclaration: boolean;
    /** The canonicalized path of the file declaring it. */
    readonly path: string;
}

const EXACT_NAME_SCORE = 200;
const QUALIFIED_NAME_SCORE = 100;
// Above the two locality bonuses together, so a definition elsewhere beats a
// same-file use of the name.
const DECLARATION_SCORE = 100;
const SAME_FILE_SCORE = 40;
const SAME_DIR_SCORE = 30;

function nameScore(name: string, symbolName: string): number {
    if (name === symbolName) {
        return EXACT_NAME_SCORE;
    }
    if (name.endsWith(`.${symbolName}`)) {
        return QUALIFIED_NAME_SCORE;
    }
    return 0;
}

function scoreCandidate(candidate: WorkspaceSymbolCandidate, symbolName: string, sourcePath: string): number {
    const byName = nameScore(candidate.name, symbolName);
    if (byName === 0) {
        return 0;
    }
    const sourceDir = sourcePath !== '' ? path.dirname(sourcePath) : '';
    return byName
        + (candidate.isDeclaration ? DECLARATION_SCORE : 0)
        + (sourcePath !== '' && candidate.path === sourcePath ? SAME_FILE_SCORE : 0)
        + (sourceDir !== '' && candidate.path.startsWith(sourceDir) ? SAME_DIR_SCORE : 0);
}

/**
 * The candidate most likely to be the definition of `symbolName` drilled into
 * from `sourcePath`, or undefined when none is named after it.
 */
export function pickBestWorkspaceSymbol<T extends WorkspaceSymbolCandidate>(
    candidates: readonly T[],
    symbolName: string,
    sourcePath: string
): T | undefined {
    const ranked = candidates
        .map(candidate => ({ candidate, score: scoreCandidate(candidate, symbolName, sourcePath) }))
        .filter(entry => entry.score > 0)
        .sort((left, right) => right.score - left.score);
    return ranked[0]?.candidate;
}
