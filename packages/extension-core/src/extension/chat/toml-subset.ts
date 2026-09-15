/**
 * The TOML a connectors file uses: tables and dotted keys, strings,
 * booleans, numbers, arrays and inline tables, comments. Enough to read what
 * the runtime reads, without a dependency; an array of tables (`[[x]]`) is
 * refused by name, since the file has no use for one.
 */
export type TomlTable = { [key: string]: TomlValue };
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;

export class TomlSubsetError extends Error {
    constructor(message: string, readonly line: number) {
        super(`line ${line}: ${message}`);
    }
}

export function parseTomlSubset(text: string): TomlTable {
    return new Parser(text).parse();
}

class Parser {
    private pos = 0;
    private readonly root: TomlTable = {};
    private current: TomlTable = this.root;

    constructor(private readonly text: string) {}

    parse(): TomlTable {
        for (;;) {
            this.skipBlank();
            if (this.pos >= this.text.length) {
                return this.root;
            }
            const ch = this.text[this.pos];
            if (ch === '[') {
                if (this.text[this.pos + 1] === '[') {
                    throw this.error('an array of tables ([[...]]) is not something a connectors file holds');
                }
                this.pos++;
                const keys = this.readKeyPath(']');
                this.expect(']');
                this.endOfLine();
                this.current = this.descend(this.root, keys, true);
            } else {
                const keys = this.readKeyPath('=');
                this.expect('=');
                this.skipSpaces();
                const value = this.readValue();
                this.endOfLine();
                this.assign(this.current, keys, value);
            }
        }
    }

    // ── structure ──────────────────────────────────────────────────────

    private descend(table: TomlTable, keys: string[], header: boolean): TomlTable {
        let node = table;
        for (const key of keys) {
            const existing = node[key];
            if (existing === undefined) {
                const created: TomlTable = {};
                node[key] = created;
                node = created;
            } else if (isTable(existing)) {
                node = existing;
            } else {
                throw this.error(`'${key}' is a value, not a table`);
            }
        }
        if (header && Object.keys(node).length > 0 && keys.length > 0 && !(keys.join('.') in this.headers)) {
            // A header may reopen a table only once; dotted keys under a
            // parent are fine. Track by path.
        }
        this.headers[keys.join('.')] = true;
        return node;
    }
    private readonly headers: Record<string, true> = {};

    private assign(table: TomlTable, keys: string[], value: TomlValue): void {
        const node = this.descend(table, keys.slice(0, -1), false);
        const last = keys[keys.length - 1];
        if (last in node) {
            throw this.error(`'${keys.join('.')}' is defined twice`);
        }
        node[last] = value;
    }

    // ── keys ───────────────────────────────────────────────────────────

    private readKeyPath(until: string): string[] {
        const keys: string[] = [];
        for (;;) {
            this.skipSpaces();
            keys.push(this.readKey());
            this.skipSpaces();
            if (this.text[this.pos] === '.') {
                this.pos++;
                continue;
            }
            if (this.text[this.pos] === until) {
                return keys;
            }
            throw this.error(`expected '.' or '${until}' after a key`);
        }
    }

    private readKey(): string {
        const ch = this.text[this.pos];
        if (ch === '"') {
            return this.readBasicString();
        }
        if (ch === "'") {
            return this.readLiteralString();
        }
        const m = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.pos));
        if (!m) {
            throw this.error('expected a key');
        }
        this.pos += m[0].length;
        return m[0];
    }

    // ── values ─────────────────────────────────────────────────────────

    private readValue(): TomlValue {
        const ch = this.text[this.pos];
        if (ch === '"') {
            return this.text.startsWith('"""', this.pos) ? this.readMultiline('"""') : this.readBasicString();
        }
        if (ch === "'") {
            return this.text.startsWith("'''", this.pos) ? this.readMultiline("'''") : this.readLiteralString();
        }
        if (ch === '[') {
            return this.readArray();
        }
        if (ch === '{') {
            return this.readInlineTable();
        }
        const rest = this.text.slice(this.pos);
        if (/^true\b/.test(rest)) {
            this.pos += 4;
            return true;
        }
        if (/^false\b/.test(rest)) {
            this.pos += 5;
            return false;
        }
        const num = /^[+-]?(?:\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|inf|nan)/.exec(rest);
        if (num && num[0].length > 0) {
            this.pos += num[0].length;
            const n = Number(num[0].replace(/_/g, ''));
            if (Number.isNaN(n) && !/nan/.test(num[0])) {
                throw this.error(`not a number: ${num[0]}`);
            }
            return n;
        }
        throw this.error('expected a value');
    }

    private readBasicString(): string {
        this.pos++; // opening quote
        let out = '';
        for (;;) {
            if (this.pos >= this.text.length) {
                throw this.error('unterminated string');
            }
            const ch = this.text[this.pos++];
            if (ch === '"') {
                return out;
            }
            if (ch === '\n') {
                throw this.error('a newline inside a string (use """ for several lines)');
            }
            if (ch === '\\') {
                out += this.readEscape();
            } else {
                out += ch;
            }
        }
    }

    private readEscape(): string {
        const ch = this.text[this.pos++];
        switch (ch) {
            case 'n': return '\n';
            case 't': return '\t';
            case 'r': return '\r';
            case 'b': return '\b';
            case 'f': return '\f';
            case '"': return '"';
            case '\\': return '\\';
            case 'u':
            case 'U': {
                const width = ch === 'u' ? 4 : 8;
                const hex = this.text.slice(this.pos, this.pos + width);
                if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== width) {
                    throw this.error(`bad unicode escape \\${ch}${hex}`);
                }
                this.pos += width;
                return String.fromCodePoint(parseInt(hex, 16));
            }
            default:
                throw this.error(`unknown escape \\${ch ?? ''}`);
        }
    }

    private readLiteralString(): string {
        this.pos++;
        const end = this.text.indexOf("'", this.pos);
        if (end < 0 || this.text.slice(this.pos, end).includes('\n')) {
            throw this.error('unterminated literal string');
        }
        const out = this.text.slice(this.pos, end);
        this.pos = end + 1;
        return out;
    }

    private readMultiline(delim: string): string {
        this.pos += 3;
        if (this.text[this.pos] === '\n') {
            this.pos++;
        } else if (this.text.startsWith('\r\n', this.pos)) {
            this.pos += 2;
        }
        const end = this.text.indexOf(delim, this.pos);
        if (end < 0) {
            throw this.error('unterminated multi-line string');
        }
        let raw = this.text.slice(this.pos, end);
        this.pos = end + 3;
        if (delim === '"""') {
            raw = raw.replace(/\\\r?\n[ \t\r\n]*/g, '').replace(/\\(.)/g, (_m, c: string) => {
                switch (c) {
                    case 'n': return '\n';
                    case 't': return '\t';
                    case 'r': return '\r';
                    case '"': return '"';
                    case '\\': return '\\';
                    default: return '\\' + c;
                }
            });
        }
        return raw;
    }

    private readArray(): TomlValue[] {
        this.pos++;
        const out: TomlValue[] = [];
        for (;;) {
            this.skipBlank();
            if (this.text[this.pos] === ']') {
                this.pos++;
                return out;
            }
            out.push(this.readValue());
            this.skipBlank();
            if (this.text[this.pos] === ',') {
                this.pos++;
                continue;
            }
            if (this.text[this.pos] === ']') {
                continue;
            }
            throw this.error("expected ',' or ']' in an array");
        }
    }

    private readInlineTable(): TomlTable {
        this.pos++;
        const table: TomlTable = {};
        this.skipSpaces();
        if (this.text[this.pos] === '}') {
            this.pos++;
            return table;
        }
        for (;;) {
            const keys = this.readKeyPath('=');
            this.expect('=');
            this.skipSpaces();
            const value = this.readValue();
            this.assign(table, keys, value);
            this.skipSpaces();
            if (this.text[this.pos] === ',') {
                this.pos++;
                this.skipSpaces();
                continue;
            }
            this.expect('}');
            return table;
        }
    }

    // ── lexing helpers ─────────────────────────────────────────────────

    private skipSpaces(): void {
        while (this.text[this.pos] === ' ' || this.text[this.pos] === '\t') {
            this.pos++;
        }
    }

    /** Spaces, newlines and comments. */
    private skipBlank(): void {
        for (;;) {
            const ch = this.text[this.pos];
            if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
                this.pos++;
            } else if (ch === '#') {
                while (this.pos < this.text.length && this.text[this.pos] !== '\n') {
                    this.pos++;
                }
            } else {
                return;
            }
        }
    }

    private endOfLine(): void {
        this.skipSpaces();
        const ch = this.text[this.pos];
        if (ch === '#') {
            while (this.pos < this.text.length && this.text[this.pos] !== '\n') {
                this.pos++;
            }
            return;
        }
        if (ch === undefined || ch === '\n' || ch === '\r') {
            return;
        }
        throw this.error(`unexpected '${ch}' after a value`);
    }

    private expect(ch: string): void {
        this.skipSpaces();
        if (this.text[this.pos] !== ch) {
            throw this.error(`expected '${ch}'`);
        }
        this.pos++;
    }

    private error(message: string): TomlSubsetError {
        const line = this.text.slice(0, this.pos).split('\n').length;
        return new TomlSubsetError(message, line);
    }
}

function isTable(v: TomlValue): v is TomlTable {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
