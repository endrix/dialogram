import * as fs from 'node:fs/promises';

function countParenDelta(line: string): number {
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

export function extractDecoratedDefinitionNames(sourceText: string, decoratorName: string): string[] {
    const lines = sourceText.split(/\r?\n/);
    const names: string[] = [];
    const seen = new Set<string>();

    let pendingDecorators: string[] = [];
    let decoratorParenDepth = 0;
    let pendingDecoratorIndent: number | undefined;

    const clearPending = (): void => {
        pendingDecorators = [];
        decoratorParenDepth = 0;
        pendingDecoratorIndent = undefined;
    };

    const decoratorPattern = new RegExp(`^@\\s*(?:[A-Za-z_][A-Za-z0-9_]*\\s*\\.)*${decoratorName}\\b`);
    const hasDecorator = (): boolean => pendingDecorators.some(line => decoratorPattern.test(line.trim()));

    for (const line of lines) {
        const trimmed = line.trim();
        const indent = line.length - line.trimStart().length;

        if (pendingDecorators.length > 0 && decoratorParenDepth > 0) {
            decoratorParenDepth = Math.max(0, decoratorParenDepth + countParenDelta(line));
            continue;
        }

        if (trimmed.startsWith('@')) {
            if (indent !== 0) {
                clearPending();
                continue;
            }
            pendingDecorators.push(trimmed);
            decoratorParenDepth = Math.max(0, countParenDelta(line));
            pendingDecoratorIndent = indent;
            continue;
        }

        const defMatch = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
        if (defMatch) {
            const name = defMatch[1];
            if (
                pendingDecorators.length > 0
                && pendingDecoratorIndent === 0
                && hasDecorator()
                && !seen.has(name)
            ) {
                names.push(name);
                seen.add(name);
            }
            clearPending();
            continue;
        }

        if (trimmed === '' || trimmed.startsWith('#')) {
            if (trimmed === '') {
                clearPending();
            }
            continue;
        }

        if (pendingDecorators.length > 0) {
            clearPending();
        }
    }

    return names;
}

export async function hasRequestedDecoratedDefinition(
    filePath: string,
    decoratorName: string,
    requestedName?: string,
    readFile: (path: string) => Promise<string> = async path => fs.readFile(path, 'utf-8')
): Promise<boolean> {
    const sourceText = await readFile(filePath);
    const names = extractDecoratedDefinitionNames(sourceText, decoratorName);
    if (names.length === 0) {
        return false;
    }
    if (!requestedName || requestedName.trim() === '') {
        return true;
    }
    return names.includes(requestedName.trim());
}