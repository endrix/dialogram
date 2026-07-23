/**
 * Python source-navigation engine, extracted verbatim from extension-core's
 * `glsp-activation.ts` (SP2b Task 4). Resolves cross-file drill-down requests
 * — definition targets and workflow-definition file URIs — against the VS Code
 * definition/workspace-symbol providers and a workspace Python-file search.
 *
 * The host re-routes its `NavigateToExternalTargetAction` interception through
 * {@link createPythonNavigationProvider}, which implements the neutral
 * {@link DiagramNavigationProvider} seam. SP2c will supply the provider from a
 * `DiagramProfile` instead of the host constructing it directly.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { DiagramNavigationProvider, DiagramNavigationTarget } from '@dialogram/shared';
import { extractDecoratedDefinitionNames } from './python-diagram-definitions.js';
// `normalizeSourceUriKey` now lives in the neutral uri-keys util; re-exported
// here for compat with existing importers of this module.
import { normalizeSourceUriKey } from './uri-keys.js';

export { normalizeSourceUriKey };

type SerializedPosition = { line: number; character: number };
type SerializedRange = { start: SerializedPosition; end: SerializedPosition };
type ResolvedNavigationTarget = { uri: vscode.Uri; selection?: SerializedRange };

function extractWorkflowDefinitionNames(sourceText: string): string[] {
    return extractDecoratedDefinitionNames(sourceText, 'workflow');
}

const WORKFLOW_DEF_FILE_EXCLUDE_GLOB = '**/{.git,node_modules,dist,build,wf-out,.venv,venv,__pycache__}/**';
// Deliberately module-level (not part of GlspActivationState): these are profile-agnostic,
// workspace-derived lookup caches shared across all profiles/activations, not per-activation state.
const workflowDefinitionUriCache = new Map<string, string>();
const SYMBOL_DEFINITION_CACHE_TTL_MS = 2 * 60 * 1000;
const DEFINITION_QUERY_CACHE_TTL_MS = 60 * 1000;
const NAVIGATION_RESOLVE_CACHE_TTL_MS = 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 15 * 1000;
// Deliberately module-level: profile-agnostic, workspace-derived lookup caches shared across profiles.
const symbolDefinitionTargetCache = new Map<string, { uri?: string; selection?: SerializedRange; expiresAt: number }>();
// Deliberately module-level: profile-agnostic, workspace-derived lookup caches shared across profiles.
const definitionQueryCache = new Map<string, { uri?: string; selection?: SerializedRange; expiresAt: number }>();
// Deliberately module-level: profile-agnostic, workspace-derived lookup caches shared across profiles.
const resolvedNavigationTargetCache = new Map<string, { uri?: string; selection?: SerializedRange; expiresAt: number }>();

function navigationResolveCacheKey(
    sourceUri: vscode.Uri,
    sourceSelection: SerializedRange | undefined,
    symbolHint?: string
): string {
    const line = sourceSelection?.start.line ?? -1;
    const character = sourceSelection?.start.character ?? -1;
    const symbol = symbolHint?.trim().toLowerCase() ?? '';
    return `${sourceUri.toString()}#${line}:${character}::${symbol}`;
}

function getCachedResolvedNavigationTarget(
    sourceUri: vscode.Uri,
    sourceSelection: SerializedRange | undefined,
    symbolHint?: string
): ResolvedNavigationTarget | undefined {
    const key = navigationResolveCacheKey(sourceUri, sourceSelection, symbolHint);
    const cached = resolvedNavigationTargetCache.get(key);
    if (!cached) {
        return undefined;
    }
    if (cached.expiresAt <= Date.now()) {
        resolvedNavigationTargetCache.delete(key);
        return undefined;
    }
    if (!cached.uri) {
        return undefined;
    }
    try {
        return {
            uri: vscode.Uri.parse(cached.uri),
            ...(cached.selection ? { selection: cached.selection } : {})
        };
    } catch {
        resolvedNavigationTargetCache.delete(key);
        return undefined;
    }
}

function putCachedResolvedNavigationTarget(
    sourceUri: vscode.Uri,
    sourceSelection: SerializedRange | undefined,
    symbolHint: string | undefined,
    target: ResolvedNavigationTarget | undefined
): void {
    const key = navigationResolveCacheKey(sourceUri, sourceSelection, symbolHint);
    resolvedNavigationTargetCache.set(key, {
        ...(target ? { uri: target.uri.toString(), selection: target.selection } : {}),
        expiresAt: Date.now() + (target ? NAVIGATION_RESOLVE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS)
    });
}

function definitionQueryCacheKey(uri: vscode.Uri, position: vscode.Position): string {
    return `${uri.toString()}#${position.line}:${position.character}`;
}

function getCachedDefinitionQueryResult(uri: vscode.Uri, position: vscode.Position): ResolvedNavigationTarget | undefined | null {
    const key = definitionQueryCacheKey(uri, position);
    const cached = definitionQueryCache.get(key);
    if (!cached) {
        return null;
    }
    if (cached.expiresAt <= Date.now()) {
        definitionQueryCache.delete(key);
        return null;
    }
    if (!cached.uri) {
        return undefined;
    }
    try {
        return {
            uri: vscode.Uri.parse(cached.uri),
            ...(cached.selection ? { selection: cached.selection } : {})
        };
    } catch {
        definitionQueryCache.delete(key);
        return null;
    }
}

function putCachedDefinitionQueryResult(
    uri: vscode.Uri,
    position: vscode.Position,
    target: ResolvedNavigationTarget | undefined
): void {
    const key = definitionQueryCacheKey(uri, position);
    definitionQueryCache.set(key, {
        ...(target ? { uri: target.uri.toString(), selection: target.selection } : {}),
        expiresAt: Date.now() + (target ? DEFINITION_QUERY_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS)
    });
}

function symbolDefinitionCacheKey(symbolName: string, sourceUri: vscode.Uri): string {
    const workspaceFolderUri = vscode.workspace.getWorkspaceFolder(sourceUri)?.uri.toString() ?? 'global';
    return `${workspaceFolderUri}::${symbolName.toLowerCase()}`;
}

function getCachedSymbolDefinitionTarget(
    symbolName: string,
    sourceUri: vscode.Uri
): { uri: vscode.Uri; selection: SerializedRange } | undefined {
    const key = symbolDefinitionCacheKey(symbolName, sourceUri);
    const cached = symbolDefinitionTargetCache.get(key);
    if (!cached) {
        return undefined;
    }
    if (cached.expiresAt <= Date.now()) {
        symbolDefinitionTargetCache.delete(key);
        return undefined;
    }
    if (!cached.uri || !cached.selection) {
        return undefined;
    }
    try {
        return {
            uri: vscode.Uri.parse(cached.uri),
            selection: cached.selection
        };
    } catch {
        symbolDefinitionTargetCache.delete(key);
        return undefined;
    }
}

function putCachedSymbolDefinitionTarget(
    symbolName: string,
    sourceUri: vscode.Uri,
    target: { uri: vscode.Uri; selection: SerializedRange } | undefined
): void {
    const key = symbolDefinitionCacheKey(symbolName, sourceUri);
    symbolDefinitionTargetCache.set(key, {
        ...(target ? { uri: target.uri.toString(), selection: target.selection } : {}),
        expiresAt: Date.now() + SYMBOL_DEFINITION_CACHE_TTL_MS
    });
}

function normalizeFilePathForRanking(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase();
}

function workflowCacheKey(workflowName: string, workspaceUri: vscode.Uri | undefined): string {
    return `${workspaceUri?.toString() ?? 'global'}::${workflowName}`;
}

async function getWorkflowDefinitionNamesForFile(fileUri: vscode.Uri): Promise<string[]> {
    if (fileUri.scheme !== 'file' || !fileUri.fsPath.endsWith('.py')) {
        return [];
    }
    try {
        const sourceText = await fs.readFile(fileUri.fsPath, 'utf-8');
        return extractWorkflowDefinitionNames(sourceText);
    } catch {
        return [];
    }
}

async function fileDefinesWorkflow(fileUri: vscode.Uri, workflowName: string): Promise<boolean> {
    const names = await getWorkflowDefinitionNamesForFile(fileUri);
    return names.includes(workflowName);
}

async function resolveWorkflowDefinitionUri(
    workflowNameRaw: string,
    fallbackUri: vscode.Uri,
    preferredSourceUri?: string
): Promise<vscode.Uri> {
    const workflowName = workflowNameRaw.trim();
    if (workflowName === '' || fallbackUri.scheme !== 'file') {
        return fallbackUri;
    }

    if (await fileDefinesWorkflow(fallbackUri, workflowName)) {
        return fallbackUri;
    }

    const preferredUri = typeof preferredSourceUri === 'string' && preferredSourceUri.trim() !== ''
        ? (() => {
            try {
                return vscode.Uri.parse(preferredSourceUri);
            } catch {
                return undefined;
            }
        })()
        : undefined;

    const workspaceFolder = (preferredUri && vscode.workspace.getWorkspaceFolder(preferredUri))
        ?? vscode.workspace.getWorkspaceFolder(fallbackUri)
        ?? vscode.workspace.workspaceFolders?.[0];
    const cacheKey = workflowCacheKey(workflowName, workspaceFolder?.uri);

    const cachedUriRaw = workflowDefinitionUriCache.get(cacheKey);
    if (cachedUriRaw) {
        try {
            const cachedUri = vscode.Uri.parse(cachedUriRaw);
            if (await fileDefinesWorkflow(cachedUri, workflowName)) {
                return cachedUri;
            }
            workflowDefinitionUriCache.delete(cacheKey);
        } catch {
            workflowDefinitionUriCache.delete(cacheKey);
        }
    }

    const includePattern = workspaceFolder
        ? new vscode.RelativePattern(workspaceFolder, '**/*.py')
        : '**/*.py';
    const candidates = await vscode.workspace.findFiles(includePattern, WORKFLOW_DEF_FILE_EXCLUDE_GLOB, 2000);

    const workflowNameLower = workflowName.toLowerCase();
    const preferredDir = preferredUri?.scheme === 'file'
        ? normalizeFilePathForRanking(path.dirname(preferredUri.fsPath))
        : '';
    const fallbackDir = normalizeFilePathForRanking(path.dirname(fallbackUri.fsPath));

    const rankCandidate = (uri: vscode.Uri): number => {
        const normalizedPath = normalizeFilePathForRanking(uri.fsPath);
        const baseName = path.basename(normalizedPath, '.py');
        let score = 0;
        if (baseName === workflowNameLower) {
            score += 100;
        }
        if (normalizedPath.includes(workflowNameLower)) {
            score += 20;
        }
        if (preferredDir !== '' && normalizedPath.startsWith(preferredDir)) {
            score += 40;
        }
        if (normalizedPath.startsWith(fallbackDir)) {
            score += 10;
        }
        if (normalizedPath.includes('/examples/')) {
            score += 5;
        }
        return score;
    };

    const ranked = [...candidates].sort((left, right) => {
        const scoreDiff = rankCandidate(right) - rankCandidate(left);
        if (scoreDiff !== 0) {
            return scoreDiff;
        }
        return left.fsPath.length - right.fsPath.length;
    });

    for (const candidate of ranked) {
        if (await fileDefinesWorkflow(candidate, workflowName)) {
            const normalized = normalizeSourceUriKey(candidate.toString());
            workflowDefinitionUriCache.set(cacheKey, normalized);
            return vscode.Uri.parse(normalized);
        }
    }

    return fallbackUri;
}

function canonicalizeSourcePathForMatch(pathValue: string): string {
    return path.normalize(pathValue).replace(/\\/g, '/').toLowerCase();
}

function collectPossibleDefinitionRangesForName(sourceText: string, symbolName: string): SerializedRange[] {
    const lines = sourceText.split(/\r?\n/);
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
        new RegExp(`^\\s*def\\s+${escaped}\\s*\\(`),
        new RegExp(`^\\s*class\\s+${escaped}\\b`)
    ];

    const ranges: SerializedRange[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        for (const pattern of patterns) {
            const match = pattern.exec(line);
            if (!match) {
                continue;
            }

            const startChar = match[0].indexOf(symbolName);
            const char = startChar >= 0 ? startChar : 0;
            ranges.push({
                start: { line: i, character: char },
                end: { line: i, character: char + symbolName.length }
            });
            break;
        }
    }

    return ranges;
}

type PythonCallableOnLine = {
    callable: string;
    startCharacter: number;
};

function findPythonCallableOnLine(lineText: string, preferredName?: string): PythonCallableOnLine | undefined {
    const trimmed = lineText.trim();
    if (trimmed.startsWith('def ') || trimmed.startsWith('class ')) {
        return undefined;
    }

    const assignmentRegex = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*([A-Za-z_][A-Za-z0-9_\.]*)\s*\(/;
    const assignmentMatch = assignmentRegex.exec(lineText);
    if (assignmentMatch && typeof assignmentMatch[1] === 'string') {
        const callable = assignmentMatch[1];
        const startCharacter = lineText.indexOf(callable, assignmentMatch.index);
        if (startCharacter >= 0) {
            return { callable, startCharacter };
        }
    }

    if (preferredName && preferredName.trim() !== '') {
        const escapedPreferred = escapedRegexSymbol(preferredName.trim());
        const preferredRegex = new RegExp(`\\b${escapedPreferred}\\b`);
        const preferredMatch = preferredRegex.exec(lineText);
        if (preferredMatch && typeof preferredMatch.index === 'number') {
            return {
                callable: preferredName.trim(),
                startCharacter: preferredMatch.index
            };
        }
    }

    const genericCallRegex = /\b([A-Za-z_][A-Za-z0-9_\.]*)\s*\(/;
    const genericMatch = genericCallRegex.exec(lineText);
    if (genericMatch && typeof genericMatch[1] === 'string' && typeof genericMatch.index === 'number') {
        const callable = genericMatch[1];
        const startCharacter = lineText.indexOf(callable, genericMatch.index);
        if (startCharacter >= 0) {
            return { callable, startCharacter };
        }
    }

    return undefined;
}

function escapedRegexSymbol(symbol: string): string {
    return symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolveSourcePositionForDefinition(
    sourceUri: vscode.Uri,
    sourceSelection: SerializedRange | undefined,
    symbolHint?: string
): Promise<vscode.Position> {
    if (!sourceSelection) {
        return new vscode.Position(0, 0);
    }

    if (
        !symbolHint
        || symbolHint.trim() === ''
        || sourceUri.scheme !== 'file'
        || sourceSelection.start.character !== 0
    ) {
        return new vscode.Position(sourceSelection.start.line, sourceSelection.start.character);
    }

    try {
        const doc = await vscode.workspace.openTextDocument(sourceUri);
        const line = doc.lineAt(sourceSelection.start.line).text;
        const probe = findPythonCallableOnLine(line, symbolHint);
        if (probe) {
            return new vscode.Position(sourceSelection.start.line, probe.startCharacter);
        }
    } catch {
        // Ignore source lookup errors and use raw source selection.
    }

    return new vscode.Position(sourceSelection.start.line, sourceSelection.start.character);
}

async function runDefinitionProvider(
    sourceUri: vscode.Uri,
    position: vscode.Position
): Promise<ResolvedNavigationTarget | undefined> {
    const cached = getCachedDefinitionQueryResult(sourceUri, position);
    if (cached !== null) {
        return cached;
    }

    try {
        const defs = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
            'vscode.executeDefinitionProvider',
            sourceUri,
            position
        );
        if (!Array.isArray(defs) || defs.length === 0) {
            putCachedDefinitionQueryResult(sourceUri, position, undefined);
            return undefined;
        }

        const first = defs[0] as vscode.Location | vscode.LocationLink;
        if (!first) {
            putCachedDefinitionQueryResult(sourceUri, position, undefined);
            return undefined;
        }

        const target = 'targetUri' in first
            ? {
                uri: first.targetUri,
                ...(first.targetSelectionRange ?? first.targetRange
                    ? { selection: toSerializedRange((first.targetSelectionRange ?? first.targetRange) as vscode.Range) }
                    : {})
            }
            : {
                uri: first.uri,
                ...(first.range ? { selection: toSerializedRange(first.range) } : {})
            };

        putCachedDefinitionQueryResult(sourceUri, position, target);
        return target;
    } catch {
        putCachedDefinitionQueryResult(sourceUri, position, undefined);
        return undefined;
    }
}

async function chaseAliasDefinitionTarget(
    initialTarget: { uri: vscode.Uri; selection?: SerializedRange },
    symbolHint?: string
): Promise<{ uri: vscode.Uri; selection?: SerializedRange }> {
    let current = initialTarget;
    const seen = new Set<string>();

    for (let i = 0; i < 3; i++) {
        if (current.uri.scheme !== 'file') {
            break;
        }

        const currentLine = current.selection?.start.line;
        if (typeof currentLine !== 'number' || currentLine < 0) {
            break;
        }

        const key = `${current.uri.toString()}#${currentLine}`;
        if (seen.has(key)) {
            break;
        }
        seen.add(key);

        let lineText = '';
        try {
            const doc = await vscode.workspace.openTextDocument(current.uri);
            if (currentLine >= doc.lineCount) {
                break;
            }
            lineText = doc.lineAt(currentLine).text;
        } catch {
            break;
        }

        const probe = findPythonCallableOnLine(lineText, symbolHint);
        if (!probe) {
            break;
        }

        const resolved = await runDefinitionProvider(current.uri, new vscode.Position(currentLine, probe.startCharacter));
        if (!resolved) {
            break;
        }

        const next = resolved;

        if (
            next.uri.toString() === current.uri.toString()
            && next.selection?.start.line === current.selection?.start.line
            && next.selection?.start.character === current.selection?.start.character
        ) {
            break;
        }

        current = next;
    }

    return current;
}

async function definitionTargetMatchesSymbolHint(
    target: { uri: vscode.Uri; selection?: SerializedRange },
    symbolHint?: string
): Promise<boolean> {
    if (!symbolHint || symbolHint.trim() === '') {
        return true;
    }
    if (target.uri.scheme !== 'file') {
        return false;
    }

    const symbol = symbolHint.trim();
    const escaped = escapedRegexSymbol(symbol);
    const declarationPattern = new RegExp(`^\\s*(?:def|class)\\s+${escaped}\\b`);

    try {
        const doc = await vscode.workspace.openTextDocument(target.uri);
        const lineNo = target.selection?.start.line ?? 0;
        if (lineNo < 0 || lineNo >= doc.lineCount) {
            return false;
        }

        const lineText = doc.lineAt(lineNo).text;
        if (declarationPattern.test(lineText)) {
            return true;
        }

        return false;
    } catch {
        return false;
    }
}

async function isPythonDeclarationLine(target: { uri: vscode.Uri; selection?: SerializedRange }): Promise<boolean> {
    if (target.uri.scheme !== 'file') {
        return false;
    }

    try {
        const doc = await vscode.workspace.openTextDocument(target.uri);
        const lineNo = target.selection?.start.line ?? 0;
        if (lineNo < 0 || lineNo >= doc.lineCount) {
            return false;
        }

        const lineText = doc.lineAt(lineNo).text;
        return /^\s*(?:def|class)\s+[A-Za-z_][A-Za-z0-9_]*\b/.test(lineText);
    } catch {
        return false;
    }
}

function isLikelySameLineFallbackDefinition(
    target: { uri: vscode.Uri; selection?: SerializedRange },
    sourceUri: vscode.Uri,
    sourceSelection: SerializedRange | undefined
): boolean {
    if (!sourceSelection) {
        return false;
    }
    if (target.uri.scheme !== 'file' || sourceUri.scheme !== 'file') {
        return false;
    }

    const targetPath = canonicalizeSourcePathForMatch(target.uri.fsPath);
    const sourcePath = canonicalizeSourcePathForMatch(sourceUri.fsPath);
    if (targetPath !== sourcePath) {
        return false;
    }

    const targetLine = target.selection?.start.line;
    return typeof targetLine === 'number' && targetLine === sourceSelection.start.line;
}

async function resolveDefinitionTargetBySymbol(
    symbolName: string,
    sourceUri: vscode.Uri
): Promise<{ uri: vscode.Uri; selection: SerializedRange } | undefined> {
    const cached = getCachedSymbolDefinitionTarget(symbolName, sourceUri);
    if (cached) {
        return cached;
    }

    const fromWorkspaceSymbols = await (async (): Promise<{ uri: vscode.Uri; selection: SerializedRange } | undefined> => {
        let symbols: vscode.SymbolInformation[] | undefined;
        try {
            symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
                'vscode.executeWorkspaceSymbolProvider',
                symbolName
            );
        } catch {
            return undefined;
        }

        if (!Array.isArray(symbols) || symbols.length === 0) {
            return undefined;
        }

        const sourcePath = sourceUri.scheme === 'file'
            ? canonicalizeSourcePathForMatch(sourceUri.fsPath)
            : '';
        const sourceDir = sourcePath !== '' ? path.dirname(sourcePath) : '';
        const symbolLower = symbolName.toLowerCase();

        const declarationKinds = new Set<vscode.SymbolKind>([
            vscode.SymbolKind.Function,
            vscode.SymbolKind.Method,
            vscode.SymbolKind.Constructor,
            vscode.SymbolKind.Class
        ]);

        const candidates = symbols
            .filter(info => info.location?.uri?.scheme === 'file')
            .map(info => {
                const uri = info.location.uri;
                const candidatePath = canonicalizeSourcePathForMatch(uri.fsPath);
                const range = {
                    start: {
                        line: info.location.range.start.line,
                        character: info.location.range.start.character
                    },
                    end: {
                        line: info.location.range.end.line,
                        character: info.location.range.end.character
                    }
                } as SerializedRange;

                let score = 0;
                const nameLower = info.name.toLowerCase();
                if (nameLower === symbolLower) {
                    score += 200;
                } else if (nameLower.endsWith(`.${symbolLower}`)) {
                    score += 100;
                }

                if (declarationKinds.has(info.kind)) {
                    score += 60;
                }

                if (candidatePath === sourcePath) {
                    score += 40;
                }
                if (sourceDir !== '' && candidatePath.startsWith(sourceDir)) {
                    score += 30;
                }

                return { uri, selection: range, score };
            })
            .filter(candidate => candidate.score > 0)
            .sort((left, right) => right.score - left.score);

        if (candidates.length === 0) {
            return undefined;
        }

        const best = candidates[0];
        return best ? { uri: best.uri, selection: best.selection } : undefined;
    })();

    if (fromWorkspaceSymbols) {
        putCachedSymbolDefinitionTarget(symbolName, sourceUri, fromWorkspaceSymbols);
        return fromWorkspaceSymbols;
    }

    const includePattern = '**/*.py';
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(sourceUri)
        ?? vscode.workspace.workspaceFolders?.[0];
    const include = workspaceFolder
        ? new vscode.RelativePattern(workspaceFolder, includePattern)
        : includePattern;
    const candidates = await vscode.workspace.findFiles(include, WORKFLOW_DEF_FILE_EXCLUDE_GLOB, 2000);
    if (!Array.isArray(candidates) || candidates.length === 0) {
        putCachedSymbolDefinitionTarget(symbolName, sourceUri, undefined);
        return undefined;
    }

    const sourcePath = sourceUri.scheme === 'file'
        ? canonicalizeSourcePathForMatch(sourceUri.fsPath)
        : '';

    const scored: Array<{ uri: vscode.Uri; score: number; range: SerializedRange }> = [];
    for (const candidate of candidates) {
        if (candidate.scheme !== 'file') {
            continue;
        }

        let text: string;
        try {
            const doc = await vscode.workspace.openTextDocument(candidate);
            text = doc.getText();
        } catch {
            continue;
        }

        const matches = collectPossibleDefinitionRangesForName(text, symbolName);
        if (matches.length === 0) {
            continue;
        }

        const candidatePath = canonicalizeSourcePathForMatch(candidate.fsPath);
        const fileName = path.basename(candidatePath, '.py');
        let baseScore = 0;
        if (candidatePath === sourcePath) {
            baseScore += 200;
        }
        if (sourcePath !== '' && candidatePath.startsWith(path.dirname(sourcePath))) {
            baseScore += 40;
        }
        if (fileName === symbolName.toLowerCase()) {
            baseScore += 60;
        }
        if (candidatePath.includes(`/${symbolName.toLowerCase()}`)) {
            baseScore += 20;
        }

        for (const range of matches) {
            scored.push({ uri: candidate, score: baseScore, range });
        }
    }

    if (scored.length === 0) {
        putCachedSymbolDefinitionTarget(symbolName, sourceUri, undefined);
        return undefined;
    }

    scored.sort((left, right) => {
        const diff = right.score - left.score;
        if (diff !== 0) {
            return diff;
        }

        const uriDiff = left.uri.toString().localeCompare(right.uri.toString());
        if (uriDiff !== 0) {
            return uriDiff;
        }

        return left.range.start.line - right.range.start.line;
    });

    const best = scored[0];
    if (!best) {
        putCachedSymbolDefinitionTarget(symbolName, sourceUri, undefined);
        return undefined;
    }

    const target = {
        uri: best.uri,
        selection: best.range
    };
    putCachedSymbolDefinitionTarget(symbolName, sourceUri, target);
    return target;
}

function toSerializedRange(range: vscode.Range): SerializedRange {
    return {
        start: {
            line: range.start.line,
            character: range.start.character
        },
        end: {
            line: range.end.line,
            character: range.end.character
        }
    };
}

async function resolveDefinitionTarget(
    sourceUri: vscode.Uri,
    sourceSelection: SerializedRange | undefined,
    symbolHint?: string
): Promise<{ uri: vscode.Uri; selection?: SerializedRange } | undefined> {
    if (sourceUri.scheme !== 'file') {
        return undefined;
    }

    const cachedResolved = getCachedResolvedNavigationTarget(sourceUri, sourceSelection, symbolHint);
    if (cachedResolved) {
        return cachedResolved;
    }

    const position = await resolveSourcePositionForDefinition(sourceUri, sourceSelection, symbolHint);

    try {
        const direct = await runDefinitionProvider(sourceUri, position);
        if (!direct) {
            putCachedResolvedNavigationTarget(sourceUri, sourceSelection, symbolHint, undefined);
            return undefined;
        }

        const chased = await chaseAliasDefinitionTarget(direct, symbolHint);
        const preferred = chased;

        if (symbolHint && symbolHint.trim() !== '') {
            const symbol = symbolHint.trim();
            const isSameLineFallback = isLikelySameLineFallbackDefinition(preferred, sourceUri, sourceSelection);
            const isDeclaration = await isPythonDeclarationLine(preferred);
            const matchesSymbol = await definitionTargetMatchesSymbolHint(preferred, symbol);
            if ((!isDeclaration || isSameLineFallback) && !matchesSymbol) {
                const bySymbol = await resolveDefinitionTargetBySymbol(symbol, sourceUri);
                if (bySymbol) {
                    putCachedResolvedNavigationTarget(sourceUri, sourceSelection, symbolHint, bySymbol);
                    return bySymbol;
                }
            }
        }

        putCachedResolvedNavigationTarget(sourceUri, sourceSelection, symbolHint, preferred);
        return preferred;
    } catch {
        if (symbolHint && symbolHint.trim() !== '') {
            try {
                const bySymbol = await resolveDefinitionTargetBySymbol(symbolHint.trim(), sourceUri);
                putCachedResolvedNavigationTarget(sourceUri, sourceSelection, symbolHint, bySymbol);
                return bySymbol;
            } catch {
                putCachedResolvedNavigationTarget(sourceUri, sourceSelection, symbolHint, undefined);
                return undefined;
            }
        }
        putCachedResolvedNavigationTarget(sourceUri, sourceSelection, symbolHint, undefined);
        return undefined;
    }
}

function toNavigationTarget(target: { uri: vscode.Uri; selection?: SerializedRange }): DiagramNavigationTarget {
    return {
        uri: target.uri.toString(),
        ...(target.selection
            ? {
                range: {
                    startLine: target.selection.start.line,
                    startColumn: target.selection.start.character,
                    endLine: target.selection.end.line,
                    endColumn: target.selection.end.character
                }
            }
            : {})
    };
}

/**
 * Wrap the Python source-navigation engine as a neutral
 * {@link DiagramNavigationProvider}. The `request` bag discriminates on `kind`:
 *
 *  - `'definition'`         → `{ sourceUri: string, sourceSelection?: SerializedRange, symbolHint?: string }`
 *                             resolves a cross-file definition drill-down.
 *  - `'workflow-definition-uri'` → `{ networkName: string, fallbackUri: string, preferredSourceUri?: string }`
 *                             resolves which `.py` file defines a workflow/network
 *                             (never fails: falls back to `fallbackUri`).
 *
 * SP2c firms the request shape when profiles supply providers directly.
 */
export function createPythonNavigationProvider(): DiagramNavigationProvider {
    return {
        async resolveTarget(request: Record<string, unknown>): Promise<DiagramNavigationTarget | undefined> {
            const kind = request.kind;

            if (kind === 'definition') {
                const rawSourceUri = typeof request.sourceUri === 'string' ? request.sourceUri : undefined;
                if (rawSourceUri === undefined) {
                    return undefined;
                }
                const sourceUri = vscode.Uri.parse(rawSourceUri);
                const sourceSelection = (request.sourceSelection as SerializedRange | undefined) ?? undefined;
                const symbolHint = typeof request.symbolHint === 'string' ? request.symbolHint : undefined;
                const target = await resolveDefinitionTarget(sourceUri, sourceSelection, symbolHint);
                return target ? toNavigationTarget(target) : undefined;
            }

            if (kind === 'workflow-definition-uri') {
                const rawFallbackUri = typeof request.fallbackUri === 'string' ? request.fallbackUri : undefined;
                if (rawFallbackUri === undefined) {
                    return undefined;
                }
                const fallbackUri = vscode.Uri.parse(rawFallbackUri);
                const networkName = typeof request.networkName === 'string' ? request.networkName : '';
                const preferredSourceUri = typeof request.preferredSourceUri === 'string' ? request.preferredSourceUri : undefined;
                const resolved = await resolveWorkflowDefinitionUri(networkName, fallbackUri, preferredSourceUri);
                return { uri: resolved.toString() };
            }

            return undefined;
        }
    };
}
