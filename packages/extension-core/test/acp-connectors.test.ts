// The platform reads the connectors the way the runtime does: the known agents,
// available when on the PATH; the user's file; the workspace's file at the
// project root, each overriding the last by name. Real files and a real
// PATH directory here, so what is tested is the reading, not a mock of it.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    createAcpAgentResolver,
    loadAcpConnectors,
    resolveChatAgent,
    splitCommand,
    userConnectorsFile,
    workspaceRoot
} from '../src/extension/chat/acp-connectors';

const FILES = { user: 'wfpy/connectors.toml', workspace: '.wfpy/connectors.toml' };
let dir: string;
let bin: string;
function executable(name: string): string {
    const file = path.join(bin, name);
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    return file;
}
function write(file: string, text: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-connectors-'));
    bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
});
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadAcpConnectors', () => {
    it('knows the four agents, available when their command is on the PATH', () => {
        executable('opencode');
        const found = loadAcpConnectors({ files: FILES, workspaceDir: dir, userFile: path.join(dir, 'none'), workspaceFile: path.join(dir, 'none'), pathDirs: [bin] });
        expect(found.map(c => [c.name, c.available, c.source, c.command, c.httpApi])).toEqual([
            ['claude', false, 'discovered', 'claude-agent-acp', false],
            ['codex', false, 'discovered', 'codex-acp', false],
            ['gemini', false, 'discovered', 'gemini --experimental-acp', false],
            ['opencode', true, 'discovered', 'opencode acp', true]
        ]);
    });

    it("applies the user's file, then the workspace's at the project root, by name", () => {
        executable('opencode');
        const mine = executable('my-acp');
        const userFile = write(path.join(dir, 'config', 'wfpy', 'connectors.toml'), `
[connectors.claude]
model = "sonnet"
[connectors.mine]
command = "${mine} --flag"
env = { API_KEY = "k" }
`);
        const root = path.join(dir, 'project');
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });
        write(path.join(root, '.wfpy', 'connectors.toml'), `
[connectors.opencode]
command = "${path.join(bin, 'opencode')} acp"
[connectors.mine]
mode = "plan"
`);
        const sub = path.join(root, 'flows', 'deep');
        fs.mkdirSync(sub, { recursive: true });

        const found = loadAcpConnectors({ files: FILES, workspaceDir: sub, userFile, pathDirs: [bin] });
        const by = Object.fromEntries(found.map(c => [c.name, c]));
        expect(by.claude).toMatchObject({ source: 'user', available: false, command: 'claude-agent-acp', model: 'sonnet', mode: null });
        expect(by.mine).toMatchObject({ source: 'workspace', available: true, command: `${mine} --flag`, mode: 'plan', env: { API_KEY: 'k' } });
        expect(by.opencode).toMatchObject({ source: 'workspace', available: true, command: `${path.join(bin, 'opencode')} acp`, httpApi: true });
        expect(found.map(c => c.name)).toEqual(['claude', 'codex', 'gemini', 'mine', 'opencode']);
    });

    it('names the file and the line when one does not parse, or a connector has no command', () => {
        const bad = write(path.join(dir, 'bad.toml'), '[connectors.x]\ncommand = "oops');
        expect(() => loadAcpConnectors({ files: FILES, workspaceDir: dir, userFile: bad, workspaceFile: path.join(dir, 'none'), pathDirs: [] }))
            .toThrow(new RegExp(`${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: line 2: unterminated string`));
        const empty = write(path.join(dir, 'empty.toml'), '[connectors.x]\nmodel = "m"');
        expect(() => loadAcpConnectors({ files: FILES, workspaceDir: dir, userFile: empty, workspaceFile: path.join(dir, 'none'), pathDirs: [] }))
            .toThrow(/connector 'x' names no command/);
    });
});

describe('the files', () => {
    it('finds the project root by pyproject.toml or .git, walking up', () => {
        const root = path.join(dir, 'p');
        write(path.join(root, 'pyproject.toml'), '');
        fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
        expect(workspaceRoot(path.join(root, 'a', 'b'))).toBe(root);
        expect(workspaceRoot(path.join(root, 'a', 'b', 'flow.py'))).toBe(root);
        expect(workspaceRoot(dir)).toBeUndefined();
    });

    it("locates the user's file under XDG_CONFIG_HOME, else ~/.config", () => {
        expect(userConnectorsFile(FILES.user, { XDG_CONFIG_HOME: '/x' })).toBe(path.join('/x', 'wfpy', 'connectors.toml'));
        expect(userConnectorsFile(FILES.user, {})).toBe(path.join(os.homedir(), '.config', 'wfpy', 'connectors.toml'));
    });

    it('reads the workspace file the declaration names, and no other', () => {
        const root = path.join(dir, 'p');
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });
        write(path.join(root, '.wfpy', 'connectors.toml'), '[connectors.a]\ncommand = "a"');
        write(path.join(root, '.other', 'connectors.toml'), '[connectors.b]\ncommand = "b"');
        const names = (files: typeof FILES) =>
            loadAcpConnectors({ files, workspaceDir: root, userFile: path.join(dir, 'none'), pathDirs: [] }).map(c => c.name);
        expect(names(FILES)).toContain('a');
        expect(names(FILES)).not.toContain('b');
        expect(names({ ...FILES, workspace: '.other/connectors.toml' })).toContain('b');
    });
});

describe('resolveChatAgent', () => {
    const listed = [
        { name: 'claude', available: false, source: 'discovered', command: 'claude-agent-acp', httpApi: false, model: 'sonnet', mode: null },
        { name: 'mine', available: true, source: 'user', command: 'my-acp --flag', httpApi: false, model: null, mode: null, env: { A: 'b' } },
        { name: 'opencode', available: true, source: 'discovered', command: 'opencode acp', httpApi: true, model: null, mode: null }
    ];

    it('spawns the named connector as its command, with the HTTP API only where it has one', () => {
        expect(resolveChatAgent('opencode', listed)).toEqual({ name: 'opencode', argv: ['opencode', 'acp'], httpApi: true, env: undefined });
        expect(resolveChatAgent('mine', listed)).toEqual({ name: 'mine', argv: ['my-acp', '--flag'], httpApi: false, env: { A: 'b' } });
        expect(resolveChatAgent('', listed)?.name).toBe('opencode');
    });

    it('says why a connector cannot be used', () => {
        expect(() => resolveChatAgent('claude', listed)).toThrow(/not available.*claude-agent-acp.*PATH/);
        expect(() => resolveChatAgent('nope', listed)).toThrow(/not known \(known: claude, mine, opencode\)$/);
        expect(() => resolveChatAgent('nope', listed, FILES)).toThrow(/declare it in .*wfpy\/connectors\.toml or the workspace's \.wfpy\/connectors\.toml/);
        expect(resolveChatAgent('opencode', undefined)).toBeUndefined();
        expect(() => resolveChatAgent('claude', undefined)).toThrow(/no ACP connectors could be listed/);
    });

    it('resolves the chat agent from the setting for a workspace', async () => {
        // The vscode mock's settings answer with the default: an empty name,
        // which is the chat's opencode, taken from what the workspace sees.
        executable('opencode');
        process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
        const xdg = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = path.join(dir, 'no-config');
        try {
            const resolve = createAcpAgentResolver('mlir', { settingKey: 'acp.connector', files: FILES });
            await expect(resolve(dir)).resolves.toMatchObject({ name: 'opencode', argv: ['opencode', 'acp'], httpApi: true });
        } finally {
            if (xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = xdg;
        }
    });
});

describe('splitCommand', () => {
    it('splits words, quotes and escapes the way the runtime does', () => {
        expect(splitCommand('opencode acp')).toEqual(['opencode', 'acp']);
        expect(splitCommand('  gemini   --experimental-acp ')).toEqual(['gemini', '--experimental-acp']);
        expect(splitCommand('"/opt/my tools/acp" --name \'a b\' c\\ d')).toEqual(['/opt/my tools/acp', '--name', 'a b', 'c d']);
        expect(splitCommand('')).toEqual([]);
    });
});
