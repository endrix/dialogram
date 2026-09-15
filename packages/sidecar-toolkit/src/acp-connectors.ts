/**
 * The ACP connectors the runtime knows: what an agent node may name, offered
 * by the property panel. Asked of the CLI (`wfpy connectors --json`), which
 * is the one place that knows what the machine has on its PATH and what the
 * user or the workspace declared. Cached briefly per command and workspace,
 * since every diagram open would otherwise spawn it.
 */
import * as path from 'node:path';
import { runChildProcess } from './run-child-process.js';

export interface AcpConnectorInfo {
    name: string;
    available: boolean;
    source: string;
    command: string;
    /** The process also serves opencode's HTTP API (revert, message ids). */
    httpApi: boolean;
    model?: string | null;
    mode?: string | null;
}

/** What the chat spawns for a connector (extension-core `AcpAgentSpec`). */
export interface ChatAgentSpec {
    name: string;
    argv: string[];
    httpApi: boolean;
}

export interface DiscoverAcpConnectorsOptions {
    cmd: string;
    argsPrefix: string[];
    /** The CLI's own arguments, e.g. `['connectors', '--json', '--workspace', dir]`. */
    args: string[];
    cwd: string;
    timeoutMs?: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<AcpConnectorInfo[] | undefined> }>();

function parseConnectors(stdout: string): AcpConnectorInfo[] | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return undefined;
    }
    const rows = Array.isArray(parsed) ? parsed : (parsed as { connectors?: unknown })?.connectors;
    if (!Array.isArray(rows)) {
        return undefined;
    }
    const out: AcpConnectorInfo[] = [];
    for (const row of rows) {
        if (!row || typeof row !== 'object' || typeof (row as { name?: unknown }).name !== 'string') {
            continue;
        }
        const r = row as Record<string, unknown>;
        out.push({
            name: String(r.name),
            available: Boolean(r.available),
            source: typeof r.source === 'string' ? r.source : 'discovered',
            command: typeof r.command === 'string' ? r.command : '',
            httpApi: Boolean(r.http_api ?? r.httpApi),
            model: typeof r.model === 'string' ? r.model : null,
            mode: typeof r.mode === 'string' ? r.mode : null
        });
    }
    return out;
}

/** Run the CLI's connector listing and parse it; `undefined` when the CLI has
 *  no such command, fails, or times out, so a caller falls back to nothing. */
export async function discoverAcpConnectors(options: DiscoverAcpConnectorsOptions): Promise<AcpConnectorInfo[] | undefined> {
    const key = JSON.stringify([options.cmd, options.argsPrefix, options.args, options.cwd]);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.value;
    }
    const value = (async () => {
        const result = await runChildProcess(options.cmd, [...options.argsPrefix, ...options.args], {
            cwd: options.cwd,
            timeoutMs: options.timeoutMs ?? 8000
        });
        if (result.spawnError || result.timedOut || result.code !== 0) {
            return undefined;
        }
        return parseConnectors(result.stdout);
    })();
    cache.set(key, { at: Date.now(), value });
    return value;
}

/**
 * Split a connector's command line the way the runtime does (shlex): words on
 * whitespace, quotes grouping, a backslash escaping. The commands are short
 * (`opencode acp`, `gemini --experimental-acp`), so this is all they need.
 */
export function splitCommand(command: string): string[] {
    const out: string[] = [];
    let cur = '';
    let quote: string | undefined;
    let has = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote) {
            if (ch === quote) quote = undefined;
            else if (ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
            else cur += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            has = true;
        } else if (ch === '\\' && i + 1 < command.length) {
            cur += command[++i];
            has = true;
        } else if (/\s/.test(ch)) {
            if (has) out.push(cur);
            cur = '';
            has = false;
        } else {
            cur += ch;
            has = true;
        }
    }
    if (has) out.push(cur);
    return out;
}

/**
 * The agent the chat spawns for the connector a setting names. The listing is
 * the runtime's (`discoverAcpConnectors`); `undefined` there means the runtime
 * cannot list connectors, which only `opencode` survives (the chat's own
 * default). Throws with the reason a reader can act on.
 */
export function resolveChatAgent(name: string, connectors: AcpConnectorInfo[] | undefined): ChatAgentSpec | undefined {
    const wanted = name.trim() || 'opencode';
    if (!connectors) {
        if (wanted === 'opencode') return undefined;
        throw new Error(`the runtime lists no ACP connectors, so "${wanted}" cannot be resolved (only opencode works without a listing)`);
    }
    const found = connectors.find((c) => c.name === wanted);
    if (!found) {
        const known = connectors.map((c) => c.name).join(', ') || 'none';
        throw new Error(`ACP connector "${wanted}" is not known to the runtime (known: ${known}); declare it in the connectors file or pick another`);
    }
    if (!found.available) {
        throw new Error(`ACP connector "${wanted}" is not available: "${found.command}" is not on the PATH`);
    }
    const argv = splitCommand(found.command);
    if (argv.length === 0) {
        throw new Error(`ACP connector "${wanted}" has an empty command`);
    }
    return { name: found.name, argv, httpApi: found.httpApi };
}

/** For tests and for a settings change: forget what was discovered. */
export function resetAcpConnectorsCache(): void {
    cache.clear();
}

/** The directory the listing is asked for: the source file's. */
export function workspaceDirFor(sourcePath: string): string {
    return path.dirname(sourcePath);
}
