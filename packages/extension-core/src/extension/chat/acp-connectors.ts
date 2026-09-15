/**
 * The ACP connectors, for every dialogram product: what the chat spawns and
 * what an agent node may name (the property panel's list). Read the way the
 * product's runtime reads them, in the platform itself so no product needs
 * that runtime on the PATH to know them:
 *
 *  1. the known agents, available when their command is on the PATH
 *     (`opencode acp`, Zed's `claude-agent-acp` for Claude Code, `codex-acp`,
 *     `gemini --experimental-acp`);
 *  2. the user's connectors file, under `$XDG_CONFIG_HOME` (`~/.config`),
 *     adding or overriding;
 *  3. the workspace's connectors file, under the project root (the first
 *     directory up with a `pyproject.toml` or a `.git`), overriding both.
 *
 * The product names the two files ({@link AcpConnectorConfig.files}), since
 * they are its runtime's. One TOML table per connector: `command` (split as
 * a shell would), `model`, `mode`, `http_api`, `env`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { agentInstallDirs, type AcpAgentSpec } from "../acp-client.js";
import { parseTomlSubset, type TomlTable, type TomlValue } from "./toml-subset.js";

/**
 * A product's declaration on its chat config: the setting, under the
 * profile's settings namespace, naming the chat's connector (user level,
 * workspace override), and the runtime's two connectors files. Empty, or
 * `opencode`, is the chat's own default.
 */
export interface AcpConnectorConfig {
    /** e.g. `'acp.connector'` for `<namespace>.acp.connector`. */
    settingKey: string;
    /** The connectors files the product's runtime reads, as relative paths:
     *  `user` under `$XDG_CONFIG_HOME` (`~/.config`), `workspace` under the
     *  project root. */
    files: AcpConnectorFiles;
}

export interface AcpConnectorFiles {
    user: string;
    workspace: string;
}

export interface AcpConnectorInfo {
    name: string;
    /** The command's first word resolves on the PATH (with the agents' usual install dirs). */
    available: boolean;
    /** discovered | user | workspace */
    source: string;
    command: string;
    /** The process also serves opencode's HTTP API (revert, message ids). */
    httpApi: boolean;
    model?: string | null;
    mode?: string | null;
    env?: Record<string, string>;
}

/** What the chat spawns for a connector: {@link AcpAgentSpec}. */
export type ChatAgentSpec = AcpAgentSpec & { httpApi: boolean };

/** The agents known without being told; the same table as the runtime's. */
export const KNOWN_CONNECTORS: Readonly<Record<string, { command: string; httpApi: boolean }>> = {
    opencode: { command: "opencode acp", httpApi: true },
    claude: { command: "claude-agent-acp", httpApi: false },
    codex: { command: "codex-acp", httpApi: false },
    gemini: { command: "gemini --experimental-acp", httpApi: false },
};

export interface LoadAcpConnectorsOptions {
    /** The runtime's two connectors files, relative ({@link AcpConnectorFiles}). */
    files: AcpConnectorFiles;
    /** Where the workspace file is looked for: the source file's directory. */
    workspaceDir: string;
    /** Overrides, for tests: the two files resolved, and the PATH to probe. */
    userFile?: string;
    workspaceFile?: string;
    pathDirs?: string[];
}

/** The user's file: `$XDG_CONFIG_HOME/<relative>`, `~/.config` without the variable. */
export function userConnectorsFile(relative: string, env: NodeJS.ProcessEnv = process.env): string {
    const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    return path.join(base, relative);
}

/** The project root above `start`: the first directory up with a
 *  `pyproject.toml` or a `.git`, else undefined. */
export function workspaceRoot(start: string): string | undefined {
    let current = path.resolve(start);
    try {
        if (fs.statSync(current).isFile()) {
            current = path.dirname(current);
        }
    } catch {
        // A directory that does not exist yet has no root.
    }
    for (;;) {
        if (isFile(path.join(current, "pyproject.toml")) || exists(path.join(current, ".git"))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
}

export function workspaceConnectorsFile(root: string | undefined, relative: string): string | undefined {
    return root ? path.join(root, relative) : undefined;
}

/** The directory the listing is asked for: the source file's. */
export function workspaceDirFor(sourcePath: string): string {
    return path.dirname(sourcePath);
}

/**
 * Every connector a workspace sees: discovered, then the user's file, then
 * the workspace's, later ones overriding earlier ones by name. Throws on a
 * file that does not parse, naming it.
 */
export function loadAcpConnectors(options: LoadAcpConnectorsOptions): AcpConnectorInfo[] {
    const pathDirs = options.pathDirs ?? defaultPathDirs();
    const found = new Map<string, AcpConnectorInfo>();
    for (const [name, spec] of Object.entries(KNOWN_CONNECTORS)) {
        const argv = splitCommand(spec.command);
        found.set(name, {
            name, source: "discovered", available: isOnPath(argv[0], pathDirs),
            command: spec.command, httpApi: spec.httpApi, model: null, mode: null,
        });
    }
    const userFile = options.userFile ?? userConnectorsFile(options.files.user);
    for (const [name, table] of readConnectorsFile(userFile)) {
        found.set(name, fromTable(name, table, "user", found.get(name), userFile, pathDirs));
    }
    const wsFile = options.workspaceFile ?? workspaceConnectorsFile(workspaceRoot(options.workspaceDir), options.files.workspace);
    for (const [name, table] of readConnectorsFile(wsFile)) {
        found.set(name, fromTable(name, table, "workspace", found.get(name), wsFile!, pathDirs));
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The connectors a product's declaration sees for a workspace directory;
 *  `undefined` when a file is unreadable (logged), so a caller that only
 *  lists falls back to nothing. */
export async function listAcpConnectors(config: AcpConnectorConfig, workspaceDir: string): Promise<AcpConnectorInfo[] | undefined> {
    try {
        return loadAcpConnectors({ files: config.files, workspaceDir });
    } catch (err) {
        console.warn("[dialogram] ACP connectors:", err instanceof Error ? err.message : String(err));
        return undefined;
    }
}

/**
 * The chat's agent for a workspace, from a product's declaration: the
 * connector its setting names (read at the workspace's scope), resolved in
 * the connectors that workspace sees. Rejects with the reason the chat
 * shows as its connection error.
 */
export function createAcpAgentResolver(
    settingsNamespace: string,
    config: AcpConnectorConfig
): (cwd: string) => Promise<AcpAgentSpec | undefined> {
    return async (cwd: string) => {
        const name = (vscode.workspace
            .getConfiguration(settingsNamespace, vscode.Uri.file(cwd))
            .get<string>(config.settingKey, "") ?? "").trim();
        return resolveChatAgent(name, loadAcpConnectors({ files: config.files, workspaceDir: cwd }), config.files);
    };
}

/**
 * The agent the chat spawns for the connector a setting names. Throws with
 * the reason a reader can act on.
 */
export function resolveChatAgent(name: string, connectors: AcpConnectorInfo[] | undefined, files?: AcpConnectorFiles): ChatAgentSpec | undefined {
    const wanted = name.trim() || "opencode";
    if (!connectors) {
        if (wanted === "opencode") return undefined;
        throw new Error(`no ACP connectors could be listed, so "${wanted}" cannot be resolved (only opencode works without a listing)`);
    }
    const found = connectors.find((c) => c.name === wanted);
    if (!found) {
        const known = connectors.map((c) => c.name).join(", ") || "none";
        const where = files ? `; declare it in ${userConnectorsFile(files.user)} or the workspace's ${files.workspace}` : "";
        throw new Error(`ACP connector "${wanted}" is not known (known: ${known})${where}`);
    }
    if (!found.available) {
        throw new Error(`ACP connector "${wanted}" is not available: "${found.command}" is not on the PATH`);
    }
    const argv = splitCommand(found.command);
    if (argv.length === 0) {
        throw new Error(`ACP connector "${wanted}" has an empty command`);
    }
    return { name: found.name, argv, httpApi: found.httpApi, env: found.env };
}

/**
 * Split a connector's command line the way the runtime does (shlex): words on
 * whitespace, quotes grouping, a backslash escaping.
 */
export function splitCommand(command: string): string[] {
    const out: string[] = [];
    let cur = "";
    let quote: string | undefined;
    let has = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote) {
            if (ch === quote) quote = undefined;
            else if (ch === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
            else cur += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            has = true;
        } else if (ch === "\\" && i + 1 < command.length) {
            cur += command[++i];
            has = true;
        } else if (/\s/.test(ch)) {
            if (has) out.push(cur);
            cur = "";
            has = false;
        } else {
            cur += ch;
            has = true;
        }
    }
    if (has) out.push(cur);
    return out;
}

/** `shlex.join`: what a listing shows for an argv. */
export function joinCommand(argv: string[]): string {
    return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
}

// ── files ──────────────────────────────────────────────────────────────

function readConnectorsFile(file: string | undefined): Array<[string, TomlTable]> {
    if (!file || !isFile(file)) {
        return [];
    }
    let data: TomlTable;
    try {
        data = parseTomlSubset(fs.readFileSync(file, "utf8"));
    } catch (err) {
        throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const tables = data.connectors;
    if (tables === undefined) {
        return [];
    }
    if (!isTable(tables)) {
        throw new Error(`${file}: \`connectors\` must be a table of tables`);
    }
    return Object.entries(tables).map(([name, table]) => {
        if (!isTable(table)) {
            throw new Error(`${file}: connector '${name}' must be a table`);
        }
        return [name, table];
    });
}

function fromTable(
    name: string, table: TomlTable, source: string, base: AcpConnectorInfo | undefined, file: string, pathDirs: string[]
): AcpConnectorInfo {
    const command = table.command !== undefined ? String(table.command) : base?.command ?? "";
    const argv = splitCommand(command);
    if (argv.length === 0) {
        throw new Error(`${file}: connector '${name}' names no command`);
    }
    const env: Record<string, string> = { ...(base?.env ?? {}) };
    if (table.env !== undefined) {
        if (!isTable(table.env)) {
            throw new Error(`${file}: connector '${name}': env must be a table`);
        }
        for (const [k, v] of Object.entries(table.env)) env[k] = String(v);
    }
    const str = (v: TomlValue | undefined, fallback: string | null | undefined): string | null =>
        v === undefined ? fallback ?? null : v === null ? null : String(v);
    return {
        name,
        source,
        available: isOnPath(argv[0], pathDirs),
        command: joinCommand(argv),
        httpApi: table.http_api !== undefined ? Boolean(table.http_api) : base?.httpApi ?? false,
        model: str(table.model, base?.model),
        mode: str(table.mode, base?.mode),
        env: Object.keys(env).length ? env : undefined,
    };
}

// ── the PATH ───────────────────────────────────────────────────────────

/** The PATH the chat spawns with: the agents' install dirs ahead of the process's. */
export function defaultPathDirs(env: NodeJS.ProcessEnv = process.env): string[] {
    const sep = process.platform === "win32" ? ";" : ":";
    const inherited = (env.PATH ?? env.Path ?? "").split(sep).filter(Boolean);
    return [...agentInstallDirs(), ...inherited];
}

/** `shutil.which`: the command resolves as an executable file. */
export function isOnPath(command: string, pathDirs: string[]): boolean {
    if (!command) {
        return false;
    }
    const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
    const candidates = (file: string) => exts.map((e) => file + e);
    if (command.includes("/") || (process.platform === "win32" && command.includes("\\"))) {
        return candidates(command).some(isExecutable);
    }
    return pathDirs.some((dir) => candidates(path.join(dir, command)).some(isExecutable));
}

function isExecutable(file: string): boolean {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function exists(p: string): boolean {
    return fs.existsSync(p);
}

function isTable(v: TomlValue | undefined): v is TomlTable {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
