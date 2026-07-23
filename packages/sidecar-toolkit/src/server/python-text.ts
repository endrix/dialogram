// TECH DEBT: regex Python rewriting — migrate into sidecar CST ops.
//
// This module is the clearly-marked regex corner: it parses/rewrites Python source text with
// regular expressions rather than the sidecar's libcst CST. It exists only to support the sidecar
// operation handlers' local heuristics (project type discovery, decorator detection, string-literal
// escaping) until those move behind proper CST-backed sidecar operations.

export type PythonDefinition = {
    name: string;
    kind: 'class' | 'function';
    decorators: string[];
    bodyText: string;
};

function countParenDelta(line: string): number {
    let delta = 0;
    const sanitizedLine = stripPythonCommentsAndStrings(line);
    for (const ch of sanitizedLine) {
        if (ch === '(') {
            delta += 1;
        } else if (ch === ')') {
            delta -= 1;
        }
    }
    return delta;
}

export function stripPythonCommentsAndStrings(sourceText: string): string {
    return sourceText
        .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, match => ' '.repeat(match.length))
        .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, match => ' '.repeat(match.length))
        .replace(/#.*$/gm, '');
}

export function hasDecorator(decorators: string[], decoratorName: string): boolean {
    const pattern = new RegExp(`^@\\s*(?:[A-Za-z_][A-Za-z0-9_]*\\s*\\.)*${decoratorName}\\b`);
    return decorators.some(line => pattern.test(line.trim()));
}

export function extractTopLevelPythonDefinitions(sourceText: string): PythonDefinition[] {
    const lines = sourceText.split(/\r?\n/);
    const definitions: Array<{ name: string; kind: 'class' | 'function'; decorators: string[]; line: number }> = [];

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
            pendingDecorators[pendingDecorators.length - 1] += ` ${trimmed}`;
            decoratorParenDepth = Math.max(0, decoratorParenDepth + countParenDelta(line));
            continue;
        }

        if (trimmed.startsWith('@')) {
            pendingDecorators.push(trimmed);
            decoratorParenDepth = Math.max(0, countParenDelta(line));
            continue;
        }

        const classMatch = /^class\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmed);
        if (classMatch) {
            definitions.push({
                name: classMatch[1],
                kind: 'class',
                decorators: [...pendingDecorators],
                line: index
            });
            clearPendingDecorators();
            continue;
        }

        const functionMatch = /^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(trimmed);
        if (functionMatch) {
            definitions.push({
                name: functionMatch[1],
                kind: 'function',
                decorators: [...pendingDecorators],
                line: index
            });
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
        const bodyEnd = index + 1 < definitions.length ? definitions[index + 1].line : lines.length;
        return {
            ...definition,
            bodyText: stripPythonCommentsAndStrings(lines.slice(definition.line + 1, bodyEnd).join('\n'))
        };
    });
}

/** Escape a JS string for safe embedding inside a single-quoted Python string literal. */
export function escapePythonStringLiteral(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
