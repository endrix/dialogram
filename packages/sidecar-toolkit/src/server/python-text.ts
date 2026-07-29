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

/** One port declared on a workflow type: identifier name + best-effort direction. */
export interface PythonPortInfo {
    name: string;
    direction: 'in' | 'out' | 'unknown';
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePortDirection(raw: string | undefined): 'in' | 'out' | 'unknown' {
    if (!raw) {
        return 'unknown';
    }
    const value = raw.trim().toLowerCase();
    if (value === 'in' || value === 'input') {
        return 'in';
    }
    if (value === 'out' || value === 'output') {
        return 'out';
    }
    return 'unknown';
}

/**
 * Extract the ports declared on a top-level Python class `typeName`, as `<Name> = [...]Port[...](...)`
 * assignments (directly in the class body or nested under a `class Ports:` block). Operates on the
 * RAW source (not the comment/string-stripped body) so a `direction="in"/"out"` kwarg survives.
 * Best-effort and dependency-free: used only to enrich the agent create-node confirmation with the
 * created node's port names so the next create-edges can address them by name. Returns [] when the
 * class is not found in this source text (e.g. a type defined in another module).
 */
export function extractTypePorts(sourceText: string, typeName: string): PythonPortInfo[] {
    const lines = sourceText.split(/\r?\n/);
    const classRe = new RegExp(`^(\\s*)class\\s+${escapeRegExp(typeName)}\\b`);

    let classIndent = -1;
    let startIndex = -1;
    for (let index = 0; index < lines.length; index += 1) {
        const match = classRe.exec(lines[index]);
        if (match) {
            classIndent = match[1].length;
            startIndex = index + 1;
            break;
        }
    }
    if (startIndex < 0) {
        return [];
    }

    // Port declaration: `<Name> = [pkg.]?[Input|Output]?Port[ ... ` — captures the identifier and an
    // optional Input/Output type prefix that also implies direction.
    const portRe = /^\s*([A-Za-z_]\w*)\s*=\s*(?:[A-Za-z_][\w.]*\.)?(Input|Output)?Port\s*\[/;
    const directionKwargRe = /\bdirection\s*=\s*["']([A-Za-z]+)["']/;

    const ports: PythonPortInfo[] = [];
    const seen = new Set<string>();
    for (let index = startIndex; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.trim() === '') {
            continue;
        }
        const indent = line.length - line.trimStart().length;
        if (indent <= classIndent) {
            break; // dedented out of the class block
        }
        const match = portRe.exec(line);
        if (!match || seen.has(match[1])) {
            continue;
        }
        seen.add(match[1]);
        const prefixDirection = match[2] === 'Input' ? 'in' : match[2] === 'Output' ? 'out' : undefined;
        const kwarg = directionKwargRe.exec(line);
        ports.push({
            name: match[1],
            direction: prefixDirection ?? normalizePortDirection(kwarg?.[1])
        });
    }
    return ports;
}
