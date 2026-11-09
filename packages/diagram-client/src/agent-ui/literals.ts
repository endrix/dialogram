/**
 * Literal helpers for the annotation editors: an argument value is the
 * source expression as written (`"bash"`, `["-lc", ""]`), and the editors show
 * and edit the value it denotes.
 */

export function stripQuotesIfStringLiteral(expr: string): string {
    const trimmed = (expr ?? '').trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
        const inner = trimmed.slice(1, -1);
        let out = '';
        for (let i = 0; i < inner.length; i++) {
            const ch = inner[i];
            if (ch !== '\\') {
                out += ch;
                continue;
            }
            const next = inner[i + 1];
            if (next === undefined) {
                out += '\\';
                continue;
            }
            if (next === 'n') {
                out += '\n';
                i++;
                continue;
            }
            if (next === 'r') {
                out += '\r';
                i++;
                continue;
            }
            if (next === 't') {
                out += '\t';
                i++;
                continue;
            }
            if (next === '"' || next === '\\') {
                out += next;
                i++;
                continue;
            }
            out += next;
            i++;
        }
        return out;
    }
    return trimmed;
}

export function toWfStringLiteral(value: string): string {
    const s = (value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t')
        .replace(/"/g, '\\"');
    return `"${s}"`;
}

export function normalizeMultilineStringForEditor(value: string): string {
    const normalized = (value ?? '').replace(/\r\n?/g, '\n');
    if (!normalized.includes('\n')) {
        return normalized;
    }

    const lines = normalized.split('\n');
    if (lines.length <= 1) {
        return normalized;
    }

    const trailing = lines.slice(1);
    const nonEmptyTrailing = trailing.filter(line => line.trim().length > 0);
    if (nonEmptyTrailing.length === 0) {
        return normalized;
    }

    const minIndent = nonEmptyTrailing.reduce((min, line) => {
        const m = line.match(/^[\t ]*/);
        const indent = m ? m[0].length : 0;
        return Math.min(min, indent);
    }, Number.POSITIVE_INFINITY);

    if (!Number.isFinite(minIndent) || minIndent <= 0) {
        return normalized;
    }

    const dedentedTrailing = trailing.map(line => {
        if (line.trim().length === 0) {
            return '';
        }
        const m = line.match(/^[\t ]*/);
        const indent = m ? m[0].length : 0;
        return line.slice(Math.min(indent, minIndent));
    });

    return [lines[0], ...dedentedTrailing].join('\n');
}

export function tryParseWfStringListExpr(expr: string): string[] | undefined {
    const trimmed = (expr ?? '').trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
        return undefined;
    }

    // Very small parser for list of *string literals* only: ["a", "b"]
    // Supports escaped \" and \\ inside strings.
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
        return [];
    }

    const items: string[] = [];
    let i = 0;
    const n = inner.length;
    const skipWs = () => {
        while (i < n && /\s/.test(inner[i])) i++;
    };

    const parseString = (): string | undefined => {
        if (inner[i] !== '"') {
            return undefined;
        }
        i++; // skip opening quote
        let out = '';
        while (i < n) {
            const ch = inner[i];
            if (ch === '"') {
                i++;
                return out;
            }
            if (ch === '\\') {
                const next = inner[i + 1];
                if (next === '"' || next === '\\') {
                    out += next;
                    i += 2;
                    continue;
                }
                // Unknown escape: keep as-is.
                out += ch;
                i++;
                continue;
            }
            out += ch;
            i++;
        }
        return undefined;
    };

    while (i < n) {
        skipWs();
        const s = parseString();
        if (s === undefined) {
            return undefined;
        }
        items.push(s);
        skipWs();
        if (i >= n) {
            break;
        }
        if (inner[i] === ',') {
            i++;
            continue;
        }
        // Unexpected token.
        return undefined;
    }
    return items;
}

export function serializeWfStringListExpr(items: string[]): string {
    const parts = (items ?? []).map(v => toWfStringLiteral(v));
    return `[${parts.join(', ')}]`;
}
