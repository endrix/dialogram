/**
 * Python static-analysis free functions
 *
 * Lightweight, dependency-free (no libcst/sidecar) text-based helpers used to answer
 * workflow-definition and cross-file-caller questions directly from Python source text.
 * Extracted verbatim from diagram-glsp-module.ts.
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { URI } from 'vscode-uri';
import { WorkflowDiagramMetadata, type WorkflowRelationshipInfo, type WorkflowCallerReference } from '@dialogram/shared';

export type { WorkflowRelationshipInfo, WorkflowCallerReference };

export function normalizeSourceUriKey(value: string): string {
    const trimmed = value.trim();
    if (trimmed === '') {
        return trimmed;
    }
    try {
        const uri = URI.parse(trimmed);
        if (uri.scheme === 'file') {
            const normalizedFsPath = path.resolve(uri.fsPath);
            return URI.file(normalizedFsPath).toString();
        }
        return uri.with({ query: '', fragment: '' }).toString();
    } catch {
        return trimmed;
    }
}

export async function fileExists(pathValue: string): Promise<boolean> {
    try {
        await fs.access(pathValue);
        return true;
    } catch {
        return false;
    }
}

export async function findPackageRootForFile(filePath: string): Promise<string | undefined> {
    let current = path.dirname(filePath);
    for (;;) {
        const marker = path.join(current, '__init__.py');
        if (!(await fileExists(marker))) {
            break;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
    return current;
}

export function countParenDelta(line: string): number {
    let delta = 0;
    for (const ch of line) {
        if (ch === '(') {
            delta += 1;
        } else if (ch === ')') {
            delta -= 1;
        }
    }
    return delta;
}

export function hasWorkflowDecorator(decorators: string[]): boolean {
    return decorators.some(line => /^@\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*\.)*workflow\b/.test(line.trim()));
}

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripPythonCommentsAndStrings(sourceText: string): string {
    return sourceText
        .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, match => ' '.repeat(match.length))
        .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, match => ' '.repeat(match.length))
        .replace(/#.*$/gm, '');
}

type WorkflowDefinition = {
    name: string;
    defLine: number;
    bodyText: string;
};

type PythonImportBinding =
    | {
        kind: 'name';
        sourceModule: string;
        importedName: string;
        localName: string;
    }
    | {
        kind: 'module';
        sourceModule: string;
        callPrefix: string;
    };

export function extractWorkflowDefinitions(sourceText: string): WorkflowDefinition[] {
    const lines = sourceText.split(/\r?\n/);
    const definitions: Array<{ name: string; defLine: number }> = [];
    const workflowNames = new Set<string>();

    let pendingDecorators: string[] = [];
    let decoratorParenDepth = 0;

    const clearPendingDecorators = (): void => {
        pendingDecorators = [];
        decoratorParenDepth = 0;
    };

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const trimmed = line.trim();

        if (pendingDecorators.length > 0 && decoratorParenDepth > 0) {
            decoratorParenDepth = Math.max(0, decoratorParenDepth + countParenDelta(line));
            continue;
        }

        if (trimmed.startsWith('@')) {
            pendingDecorators.push(trimmed);
            decoratorParenDepth = Math.max(0, countParenDelta(line));
            continue;
        }

        const defMatch = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
        if (defMatch) {
            const name = defMatch[1];
            if (pendingDecorators.length > 0 && hasWorkflowDecorator(pendingDecorators) && !workflowNames.has(name)) {
                definitions.push({ name, defLine: index });
                workflowNames.add(name);
            }
            clearPendingDecorators();
            continue;
        }

        if (trimmed === '' || trimmed.startsWith('#')) {
            if (trimmed === '') {
                clearPendingDecorators();
            }
            continue;
        }

        clearPendingDecorators();
    }

    return definitions.map((definition, index) => {
        const bodyEnd = index + 1 < definitions.length ? definitions[index + 1].defLine : lines.length;
        return {
            ...definition,
            bodyText: stripPythonCommentsAndStrings(lines.slice(definition.defLine + 1, bodyEnd).join('\n'))
        };
    });
}

export function resolveWorkflowDefinitionRange(sourceText: string, workflowName: string): { start: { line: number; character: number }; end: { line: number; character: number } } | undefined {
    const normalizedWorkflowName = workflowName.trim();
    if (normalizedWorkflowName === '') {
        return undefined;
    }

    const definition = extractWorkflowDefinitions(sourceText)
        .find(entry => entry.name === normalizedWorkflowName);
    if (!definition) {
        return undefined;
    }

    return {
        start: { line: definition.defLine, character: 0 },
        end: { line: definition.defLine, character: 0 }
    };
}

export function getPythonModuleNames(filePath: string, packageRoot?: string): string[] {
    const normalizedFilePath = path.resolve(filePath);
    const names = new Set<string>();
    const baseName = path.basename(normalizedFilePath, path.extname(normalizedFilePath));
    if (baseName !== '' && baseName !== '__init__') {
        names.add(baseName);
    }
    if (!packageRoot) {
        return [...names];
    }
    const relativePath = path.relative(packageRoot, normalizedFilePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return [...names];
    }
    const withoutExt = relativePath.replace(/\.py$/i, '');
    const parts = withoutExt.split(path.sep).filter(Boolean);
    if (parts[parts.length - 1] === '__init__') {
        parts.pop();
    }
    if (parts.length > 0) {
        names.add(parts.join('.'));
    }
    return [...names];
}

export function getPythonPackageName(filePath: string, packageRoot?: string): string | undefined {
    if (!packageRoot) {
        return undefined;
    }
    const normalizedFilePath = path.resolve(filePath);
    const relativePath = path.relative(packageRoot, normalizedFilePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return undefined;
    }
    const withoutExt = relativePath.replace(/\.py$/i, '');
    const parts = withoutExt.split(path.sep).filter(Boolean);
    if (parts.length === 0) {
        return undefined;
    }
    if (parts[parts.length - 1] === '__init__') {
        parts.pop();
        return parts.length > 0 ? parts.join('.') : undefined;
    }
    parts.pop();
    return parts.length > 0 ? parts.join('.') : undefined;
}

export function resolvePythonImportModule(rawModule: string, packageName?: string): string | undefined {
    const trimmed = rawModule.trim();
    if (trimmed === '') {
        return undefined;
    }
    if (!trimmed.startsWith('.')) {
        return trimmed;
    }
    if (!packageName) {
        return undefined;
    }
    const leadingDots = /^\.+/.exec(trimmed)?.[0].length ?? 0;
    const suffix = trimmed.slice(leadingDots).trim();
    const packageParts = packageName.split('.').filter(Boolean);
    const levelsUp = Math.max(0, leadingDots - 1);
    if (levelsUp > packageParts.length) {
        return undefined;
    }
    const resolvedParts = packageParts.slice(0, packageParts.length - levelsUp);
    if (suffix !== '') {
        resolvedParts.push(...suffix.split('.').filter(Boolean));
    }
    return resolvedParts.length > 0 ? resolvedParts.join('.') : undefined;
}

export function collectLogicalImportStatements(sourceText: string): string[] {
    const statements: string[] = [];
    const lines = stripPythonCommentsAndStrings(sourceText).split(/\r?\n/);
    let buffer = '';
    let parenDepth = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        if (buffer === '') {
            if (!/^(?:from|import)\b/.test(trimmed)) {
                continue;
            }
            buffer = trimmed;
            parenDepth = countParenDelta(line);
        } else {
            buffer += ` ${trimmed}`;
            parenDepth += countParenDelta(line);
        }

        const continues = /\\\s*$/.test(trimmed);
        if (continues) {
            buffer = buffer.replace(/\\\s*$/, '');
            continue;
        }
        if (parenDepth > 0) {
            continue;
        }

        statements.push(buffer.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim());
        buffer = '';
        parenDepth = 0;
    }
    if (buffer !== '') {
        statements.push(buffer.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim());
    }
    return statements;
}

export function parsePythonImportBindings(sourceText: string, filePath: string, packageRoot?: string): PythonImportBinding[] {
    const bindings: PythonImportBinding[] = [];
    const packageName = getPythonPackageName(filePath, packageRoot);
    for (const statement of collectLogicalImportStatements(sourceText)) {
        const fromMatch = /^from\s+([^\s]+)\s+import\s+(.+)$/.exec(statement);
        if (fromMatch) {
            const sourceModule = resolvePythonImportModule(fromMatch[1], packageName);
            if (!sourceModule) {
                continue;
            }
            const specifiers = fromMatch[2].split(',').map(part => part.trim()).filter(Boolean);
            for (const specifier of specifiers) {
                if (specifier === '*' || specifier === '') {
                    continue;
                }
                const aliasMatch = /^(\S+)\s+as\s+(\S+)$/.exec(specifier);
                const importedName = aliasMatch?.[1]?.trim() ?? specifier;
                const localName = aliasMatch?.[2]?.trim() ?? importedName;
                if (importedName === '' || localName === '') {
                    continue;
                }
                bindings.push({
                    kind: 'name',
                    sourceModule,
                    importedName,
                    localName
                });
                bindings.push({
                    kind: 'module',
                    sourceModule: `${sourceModule}.${importedName}`,
                    callPrefix: localName
                });
            }
            continue;
        }

        const importMatch = /^import\s+(.+)$/.exec(statement);
        if (!importMatch) {
            continue;
        }
        const specifiers = importMatch[1].split(',').map(part => part.trim()).filter(Boolean);
        for (const specifier of specifiers) {
            const aliasMatch = /^(\S+)\s+as\s+(\S+)$/.exec(specifier);
            const sourceModule = aliasMatch?.[1]?.trim() ?? specifier;
            const callPrefix = aliasMatch?.[2]?.trim() ?? sourceModule;
            if (sourceModule === '' || callPrefix === '') {
                continue;
            }
            bindings.push({
                kind: 'module',
                sourceModule,
                callPrefix
            });
        }
    }
    return bindings;
}

/**
 * Hard ceiling on the number of `.py` files a single caller-reference scan will collect. In a
 * large monorepo the scan roots can span tens of thousands of files; walking them all synchronously
 * blocked the first diagram render. The ceiling caps that cost — a partial candidate set only ever
 * means a cross-file *caller* reference (the cosmetic "Used By" breadcrumb) might be missed for
 * projects past the ceiling, never node/edge geometry. When it trips we log a one-line warning
 * naming the root so the truncation is visible in the host log.
 */
export const MAX_SOURCE_FILES_PER_SCAN = 2000;

/**
 * Hard ceiling on the number of DIRECTORIES a single caller-reference scan will read. The
 * {@link MAX_SOURCE_FILES_PER_SCAN} ceiling only caps `.py` files *collected* — it never trips in a
 * repo with sparse Python (an MLIR/LLVM-scale monorepo whose scan root, the workspace folder, holds
 * hundreds of thousands of build/vendor directories but very few `.py` files), so the walk recursed
 * into the entire tree. That unbounded traversal — running in the background as deferred caller
 * discovery after the first open — took ~24s on a real MLIR workspace, long enough to starve a
 * concurrent `refresh-queue-visibility` build's overlay phase (its `overlaysRest` bucket absorbed
 * the wait). This ceiling bounds the traversal by directory count regardless of `.py` density; a
 * truncated scan only ever means the cosmetic "Used By" breadcrumb may be incomplete, never
 * node/edge geometry. When it trips we log a one-line warning naming the root.
 */
export const MAX_DIRS_PER_SCAN = 20_000;

export async function collectPythonFilesUnderRoots(
    scanRoots: string[],
    excludeFilePath: string,
    maxFiles: number = MAX_SOURCE_FILES_PER_SCAN,
    maxDirs: number = MAX_DIRS_PER_SCAN
): Promise<string[]> {
    const files: string[] = [];
    const seen = new Set<string>();
    // Directories that never hold first-party workflow source but can be enormous. Anything whose
    // name begins with '.' (dotdirs such as `.git`, `.venv`, `.idea`, `.tox`) is skipped as well.
    // `build`/`dist`/`out` cover the common build roots; `third_party`/`external`/`vendor` cover the
    // heavy vendored trees an LLVM/MLIR-scale checkout drags in. The {@link maxDirs} ceiling is the
    // backstop for any heavy directory whose name is not enumerated here.
    const excluded = new Set([
        'node_modules', 'venv', '__pycache__', 'wf-out', 'dist', 'out', 'build',
        'third_party', 'external', 'vendor'
    ]);
    const targetPath = path.resolve(excludeFilePath);
    let ceilingHit = false;
    let dirCeilingHit = false;
    let dirsVisited = 0;

    const visit = async (dirPath: string, root: string): Promise<void> => {
        if (ceilingHit || dirCeilingHit) {
            return;
        }
        dirsVisited += 1;
        if (dirsVisited > maxDirs) {
            dirCeilingHit = true;
            // eslint-disable-next-line no-console
            console.warn(
                `[dialogram] caller-reference scan hit the ${maxDirs}-directory ceiling under `
                + `${root}; cross-file "Used By" references may be incomplete for this project.`
            );
            return;
        }
        let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
            entries = await fs.readdir(dirPath, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        } catch {
            return;
        }
        for (const entry of entries) {
            if (ceilingHit || dirCeilingHit) {
                return;
            }
            const entryPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                if (entry.name.startsWith('.') || excluded.has(entry.name)) {
                    continue;
                }
                await visit(entryPath, root);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.py')) {
                continue;
            }
            const normalizedPath = path.resolve(entryPath);
            if (normalizedPath === targetPath || seen.has(normalizedPath)) {
                continue;
            }
            seen.add(normalizedPath);
            files.push(normalizedPath);
            if (files.length >= maxFiles) {
                ceilingHit = true;
                // eslint-disable-next-line no-console
                console.warn(
                    `[dialogram] caller-reference scan hit the ${maxFiles}-file ceiling under `
                    + `${root}; cross-file "Used By" references may be incomplete for this project.`
                );
                return;
            }
        }
    };

    for (const root of scanRoots) {
        if (ceilingHit || dirCeilingHit) {
            break;
        }
        const normalizedRoot = path.resolve(root);
        if (seen.has(`dir:${normalizedRoot}`)) {
            continue;
        }
        seen.add(`dir:${normalizedRoot}`);
        await visit(normalizedRoot, normalizedRoot);
    }
    return files;
}

export async function discoverCrossFileWorkflowCallers(
    targetFilePath: string,
    targetWorkflowName: string,
    candidateFilePaths: string[]
): Promise<WorkflowCallerReference[]> {
    const normalizedTargetFilePath = path.resolve(targetFilePath);
    const targetPackageRoot = await findPackageRootForFile(normalizedTargetFilePath);
    const targetModuleNames = new Set(getPythonModuleNames(normalizedTargetFilePath, targetPackageRoot));
    if (targetModuleNames.size === 0 || targetWorkflowName.trim() === '') {
        return [];
    }

    const directCallPatterns = new Map<string, RegExp>();
    const qualifiedCallPatterns = new Map<string, RegExp>();
    const discovered: WorkflowCallerReference[] = [];
    const seen = new Set<string>();

    for (const candidateFilePath of candidateFilePaths) {
        const normalizedCandidatePath = path.resolve(candidateFilePath);
        if (normalizedCandidatePath === normalizedTargetFilePath) {
            continue;
        }
        let sourceText: string;
        try {
            sourceText = await fs.readFile(normalizedCandidatePath, 'utf-8');
        } catch {
            continue;
        }
        const definitions = extractWorkflowDefinitions(sourceText);
        if (definitions.length === 0) {
            continue;
        }
        const candidatePackageRoot = await findPackageRootForFile(normalizedCandidatePath);
        const bindings = parsePythonImportBindings(sourceText, normalizedCandidatePath, candidatePackageRoot);
        const directAliases = new Set<string>();
        const qualifiedPrefixes = new Set<string>();
        for (const binding of bindings) {
            if (binding.kind === 'name') {
                if (binding.importedName === targetWorkflowName
                    && (
                        // `from <target-file-module> import <workflow>`
                        targetModuleNames.has(binding.sourceModule)
                        // `from <package> import <submodule>` where the submodule is
                        // the target file and re-exports a same-named workflow (so it
                        // is called directly, e.g. `from src.workflows import foo; foo()`).
                        || targetModuleNames.has(`${binding.sourceModule}.${binding.importedName}`)
                    )) {
                    directAliases.add(binding.localName);
                }
                continue;
            }
            for (const targetModuleName of targetModuleNames) {
                if (binding.sourceModule === targetModuleName || targetModuleName.startsWith(`${binding.sourceModule}.`)) {
                    qualifiedPrefixes.add(`${binding.callPrefix}${targetModuleName.slice(binding.sourceModule.length)}`);
                }
            }
        }
        if (directAliases.size === 0 && qualifiedPrefixes.size === 0) {
            continue;
        }

        for (const definition of definitions) {
            const usesDirectAlias = [...directAliases].some(alias => {
                if (!directCallPatterns.has(alias)) {
                    directCallPatterns.set(alias, new RegExp(`\\b${escapeRegExp(alias)}\\s*\\(`));
                }
                return directCallPatterns.get(alias)!.test(definition.bodyText);
            });
            const usesQualifiedAlias = !usesDirectAlias && [...qualifiedPrefixes].some(prefix => {
                const patternKey = `${prefix}::${targetWorkflowName}`;
                if (!qualifiedCallPatterns.has(patternKey)) {
                    qualifiedCallPatterns.set(
                        patternKey,
                        new RegExp(`\\b${escapeRegExp(prefix)}\\s*\\.\\s*${escapeRegExp(targetWorkflowName)}\\s*\\(`)
                    );
                }
                return qualifiedCallPatterns.get(patternKey)!.test(definition.bodyText);
            });
            if (!usesDirectAlias && !usesQualifiedAlias) {
                continue;
            }
            const sourceUri = URI.file(normalizedCandidatePath).toString();
            const dedupeKey = `${sourceUri}::${definition.name}`;
            if (seen.has(dedupeKey)) {
                continue;
            }
            seen.add(dedupeKey);
            discovered.push({ sourceUri, workflowName: definition.name });
        }
    }

    return discovered;
}

export function extractWorkflowDefinitionNames(sourceText: string): string[] {
    const lines = sourceText.split(/\r?\n/);
    const names: string[] = [];
    const seen = new Set<string>();

    let pendingDecorators: string[] = [];
    let decoratorParenDepth = 0;

    const clearPendingDecorators = (): void => {
        pendingDecorators = [];
        decoratorParenDepth = 0;
    };

    for (const line of lines) {
        const trimmed = line.trim();

        if (pendingDecorators.length > 0 && decoratorParenDepth > 0) {
            decoratorParenDepth = Math.max(0, decoratorParenDepth + countParenDelta(line));
            continue;
        }

        if (trimmed.startsWith('@')) {
            pendingDecorators.push(trimmed);
            decoratorParenDepth = Math.max(0, countParenDelta(line));
            continue;
        }

        const defMatch = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
        if (defMatch) {
            const name = defMatch[1];
            if (pendingDecorators.length > 0 && hasWorkflowDecorator(pendingDecorators) && !seen.has(name)) {
                names.push(name);
                seen.add(name);
            }
            clearPendingDecorators();
            continue;
        }

        if (trimmed === '' || trimmed.startsWith('#')) {
            if (trimmed === '') {
                clearPendingDecorators();
            }
            continue;
        }

        if (pendingDecorators.length > 0) {
            clearPendingDecorators();
        }
    }

    return names;
}

export function analyzeWorkflowRelationships(sourceText: string): WorkflowRelationshipInfo {
    const workflowNames = extractWorkflowDefinitionNames(sourceText);
    const callersByWorkflow: Record<string, string[]> = Object.fromEntries(
        workflowNames.map(name => [name, [] as string[]])
    );
    if (workflowNames.length === 0) {
        return {
            workflowNames,
            entryWorkflowNames: [],
            callersByWorkflow
        };
    }

    const lines = sourceText.split(/\r?\n/);
    const definitions: Array<{ name: string; defLine: number }> = [];
    let pendingDecorators: string[] = [];
    let decoratorParenDepth = 0;

    const clearPendingDecorators = (): void => {
        pendingDecorators = [];
        decoratorParenDepth = 0;
    };

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const trimmed = line.trim();

        if (pendingDecorators.length > 0 && decoratorParenDepth > 0) {
            decoratorParenDepth = Math.max(0, decoratorParenDepth + countParenDelta(line));
            continue;
        }

        if (trimmed.startsWith('@')) {
            pendingDecorators.push(trimmed);
            decoratorParenDepth = Math.max(0, countParenDelta(line));
            continue;
        }

        const defMatch = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
        if (defMatch) {
            const name = defMatch[1];
            if (pendingDecorators.length > 0 && hasWorkflowDecorator(pendingDecorators) && workflowNames.includes(name)) {
                definitions.push({ name, defLine: index });
            }
            clearPendingDecorators();
            continue;
        }

        if (trimmed === '' || trimmed.startsWith('#')) {
            if (trimmed === '') {
                clearPendingDecorators();
            }
            continue;
        }

        clearPendingDecorators();
    }

    // Each callee's call-site pattern depends only on the callee name, not the caller, so compile
    // the regexes once up front instead of rebuilding them inside the caller loop. This turns an
    // O(callers × callees) stream of `new RegExp` compilations into O(callees); the match results
    // are byte-identical to the previous per-iteration construction.
    const calleePatterns = new Map<string, RegExp>(
        workflowNames.map(callee => [callee, new RegExp(`\\b${escapeRegExp(callee)}\\s*\\(`)])
    );
    for (let index = 0; index < definitions.length; index += 1) {
        const caller = definitions[index];
        const bodyEnd = index + 1 < definitions.length ? definitions[index + 1].defLine : lines.length;
        const bodyText = stripPythonCommentsAndStrings(lines.slice(caller.defLine + 1, bodyEnd).join('\n'));
        for (const callee of workflowNames) {
            if (callee === caller.name) {
                continue;
            }
            const callPattern = calleePatterns.get(callee)!;
            if (callPattern.test(bodyText) && !callersByWorkflow[callee].includes(caller.name)) {
                callersByWorkflow[callee].push(caller.name);
            }
        }
    }

    return {
        workflowNames,
        entryWorkflowNames: workflowNames.filter(name => (callersByWorkflow[name] ?? []).length === 0),
        callersByWorkflow
    };
}

export function pickDefaultWorkflowName(filePath: string, workflowNames: string[]): string | undefined {
    if (workflowNames.length === 0) {
        return undefined;
    }

    const baseName = path.basename(filePath, path.extname(filePath));
    const baseNameMatch = workflowNames.find(name => name === baseName);
    if (baseNameMatch) {
        return baseNameMatch;
    }

    return workflowNames[0];
}

export function buildViewerOverlayAstPathCandidates(args: Record<string, unknown> | undefined): string[] {
    if (!args) {
        return [];
    }
    const astPath = typeof args[WorkflowDiagramMetadata.AST_PATH] === 'string'
        ? (args[WorkflowDiagramMetadata.AST_PATH] as string)
        : undefined;
    if (!astPath) {
        return [];
    }

    const candidates: string[] = [];
    const sourcePathRaw = typeof args['wf:sourcePath'] === 'string'
        ? String(args['wf:sourcePath']).trim()
        : '';
    if (sourcePathRaw !== '') {
        candidates.push(`${sourcePathRaw}::${astPath}`);
        const resolved = path.resolve(sourcePathRaw);
        if (resolved !== sourcePathRaw) {
            candidates.push(`${resolved}::${astPath}`);
        }
    }
    candidates.push(astPath);
    return candidates;
}

export function buildViewerOverlaySignatureCandidates(entry: {
    fromEntity?: unknown;
    outPort?: unknown;
    toEntity?: unknown;
    inPort?: unknown;
}): string[] {
    const normalizeEndpoint = (value: unknown): string => {
        if (typeof value === 'string' && value.trim() !== '') {
            return value.trim();
        }
        return 'boundary';
    };

    const endpointAliases = (value: unknown): string[] => {
        const normalized = normalizeEndpoint(value);
        const aliases = new Set<string>([normalized]);
        if (normalized === 'WF') {
            aliases.add('boundary');
        }
        if (normalized === 'boundary') {
            aliases.add('WF');
        }
        return [...aliases];
    };

    const outPort = typeof entry.outPort === 'string' ? entry.outPort : undefined;
    const inPort = typeof entry.inPort === 'string' ? entry.inPort : undefined;
    if (!outPort || !inPort) {
        return [];
    }

    const candidates: string[] = [];
    for (const fromEntity of endpointAliases(entry.fromEntity)) {
        for (const toEntity of endpointAliases(entry.toEntity)) {
            candidates.push(`${fromEntity}|${outPort}|${toEntity}|${inPort}`);
            // Older run overlays encode source-boundary edges as
            // `${boundaryPort}.Out --> target.inPort` instead of `WF.${boundaryPort}`.
            // We have to accept that legacy shape here because the persisted overlay
            // format does not carry a stronger boundary discriminator.
            if ((fromEntity === 'WF' || fromEntity === 'boundary') && outPort !== 'Out') {
                candidates.push(`${outPort}|Out|${toEntity}|${inPort}`);
            }
        }
    }
    return candidates;
}

export function buildViewerOverlayNodeIdentityCandidates(args: Record<string, unknown> | undefined): string[] {
    if (!args) {
        return [];
    }

    const candidates: string[] = [];
    const seen = new Set<string>();
    const add = (value: unknown): void => {
        if (typeof value !== 'string') {
            return;
        }
        const normalized = value.trim();
        if (normalized === '' || seen.has(normalized)) {
            return;
        }
        seen.add(normalized);
        candidates.push(normalized);
    };

    add(args['wf:entityInstanceName']);
    add(args[WorkflowDiagramMetadata.ENTITY_TYPE]);
    add(args[WorkflowDiagramMetadata.ENTITY_NAME]);
    return candidates;
}

export function resolveViewerOverlayActiveEntityName(
    active: Array<{ entityInstanceName?: string; entityInstancePath?: string[] }> | { entityInstanceName?: string; entityInstancePath?: string[] } | undefined,
    workflowName: string,
    navigationTrail: Array<{ sourceUri: string; workflowName: string; workflowInstanceName?: string }> = []
): string | undefined {
    if (Array.isArray(active)) {
        for (const entry of active) {
            const resolved = resolveSingleActiveEntity(entry, workflowName, navigationTrail);
            if (resolved) {
                return resolved;
            }
        }
        return undefined;
    }
    return resolveSingleActiveEntity(active, workflowName, navigationTrail);
}

export function resolveSingleActiveEntity(
    active: { entityInstanceName?: string; entityInstancePath?: string[] } | undefined,
    workflowName: string,
    navigationTrail: Array<{ sourceUri: string; workflowName: string; workflowInstanceName?: string }> = []
): string | undefined {
    const fallback = typeof active?.entityInstanceName === 'string'
        ? active.entityInstanceName.trim()
        : undefined;
    const activePath = Array.isArray(active?.entityInstancePath)
        ? active.entityInstancePath
            .map(part => typeof part === 'string' ? part.trim() : '')
            .filter((part): part is string => part !== '')
        : [];
    if (activePath.length === 0) {
        return fallback;
    }

    const resolveByInstancePath = (currentInstancePath: string[]): string | undefined => {
        if (currentInstancePath.length === 0 || currentInstancePath.length > activePath.length) {
            return undefined;
        }
        if (!currentInstancePath.every((part, index) => part === activePath[index])) {
            return undefined;
        }
        if (currentInstancePath.length < activePath.length) {
            return activePath[currentInstancePath.length];
        }
        return activePath[activePath.length - 1] ?? fallback;
    };

    const currentInstancePath = navigationTrail
        .map(entry => typeof entry.workflowInstanceName === 'string' ? entry.workflowInstanceName.trim() : '')
        .filter((name): name is string => name !== '');
    const instanceResolved = resolveByInstancePath(currentInstancePath);
    if (instanceResolved) {
        return instanceResolved;
    }

    const currentWorkflowPath = navigationTrail
        .map(entry => entry.workflowName.trim())
        .filter(name => name !== '');
    if (workflowName.trim() !== '' && currentWorkflowPath[currentWorkflowPath.length - 1] !== workflowName.trim()) {
        currentWorkflowPath.push(workflowName.trim());
    }

    let matchedPrefixLength = 0;
    for (let start = 0; start < currentWorkflowPath.length; start++) {
        const suffix = currentWorkflowPath.slice(start);
        if (suffix.length === 0 || suffix.length > activePath.length) {
            continue;
        }
        if (suffix.every((part, index) => part === activePath[index])) {
            matchedPrefixLength = suffix.length;
            break;
        }
    }

    if (matchedPrefixLength < activePath.length) {
        return activePath[matchedPrefixLength];
    }
    return activePath[activePath.length - 1] ?? fallback;
}

export function normalizeWorkflowReferenceName(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
        return undefined;
    }
    const afterDots = trimmed.split('.').pop() ?? trimmed;
    const parts = afterDots.split('__');
    return parts[parts.length - 1]?.trim() || undefined;
}
