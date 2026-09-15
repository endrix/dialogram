// The property panel's connector list comes from the CLI (`wfpy connectors
// --json`): a real child here, a script standing in for the CLI, so what is
// tested is the spawn, the parse and the fallbacks, not a mock of them.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverAcpConnectors, resetAcpConnectorsCache, resolveChatAgent, splitCommand } from '../src/acp-connectors';

let dir: string;
function fakeCli(body: string): string {
    const file = path.join(dir, `cli-${Math.random().toString(36).slice(2)}.js`);
    fs.writeFileSync(file, body);
    return file;
}

const LISTING = {
    user_file: '/home/u/.config/wfpy/connectors.toml',
    workspace_file: null,
    connectors: [
        { name: 'opencode', available: true, source: 'discovered', command: 'opencode acp', http_api: true, model: null, mode: null },
        { name: 'claude', available: false, source: 'discovered', command: 'claude-agent-acp', http_api: false, model: 'sonnet', mode: null },
        { name: 'mine', available: true, source: 'user', command: 'my-acp --flag' }
    ]
};
const PARSED = [
    { name: 'opencode', available: true, source: 'discovered', command: 'opencode acp', httpApi: true, model: null, mode: null },
    { name: 'claude', available: false, source: 'discovered', command: 'claude-agent-acp', httpApi: false, model: 'sonnet', mode: null },
    { name: 'mine', available: true, source: 'user', command: 'my-acp --flag', httpApi: false, model: null, mode: null }
];

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-connectors-'));
    resetAcpConnectorsCache();
});
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('discoverAcpConnectors', () => {
    it('runs the CLI with the given arguments and parses its JSON listing', async () => {
        const cli = fakeCli(`
            const args = process.argv.slice(2);
            if (args.join(' ') !== 'connectors --json --workspace ${dir.replace(/\\\\/g, '\\\\\\\\')}') { process.stderr.write('bad args ' + args.join(' ')); process.exit(2); }
            process.stdout.write(${JSON.stringify(JSON.stringify(LISTING))});
        `);
        const found = await discoverAcpConnectors({
            cmd: process.execPath, argsPrefix: [cli], args: ['connectors', '--json', '--workspace', dir], cwd: dir
        });
        expect(found).toEqual(PARSED);
    });

    it('is undefined when the CLI has no such command, or prints no JSON', async () => {
        const failing = fakeCli(`process.stderr.write('usage: wfpy ...'); process.exit(2);`);
        expect(await discoverAcpConnectors({ cmd: process.execPath, argsPrefix: [failing], args: ['connectors'], cwd: dir })).toBeUndefined();
        const garbage = fakeCli(`process.stdout.write('not json');`);
        expect(await discoverAcpConnectors({ cmd: process.execPath, argsPrefix: [garbage], args: ['connectors'], cwd: dir })).toBeUndefined();
        expect(await discoverAcpConnectors({ cmd: path.join(dir, 'no-such-cli'), argsPrefix: [], args: ['connectors'], cwd: dir })).toBeUndefined();
    });

    it('caches a listing per command and workspace', async () => {
        const counter = path.join(dir, 'count');
        const cli = fakeCli(`
            const fs = require('node:fs');
            const n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1 : 1;
            fs.writeFileSync(${JSON.stringify(counter)}, String(n));
            process.stdout.write(JSON.stringify({ connectors: [{ name: 'c' + n, available: true, source: 'discovered', command: 'c' }] }));
        `);
        const opts = { cmd: process.execPath, argsPrefix: [cli], args: ['connectors', '--json'], cwd: dir };
        const first = await discoverAcpConnectors(opts);
        const second = await discoverAcpConnectors(opts);
        expect(first?.[0].name).toBe('c1');
        expect(second?.[0].name).toBe('c1');
        const elsewhere = path.join(dir, 'elsewhere');
        fs.mkdirSync(elsewhere);
        const other = await discoverAcpConnectors({ ...opts, cwd: elsewhere });
        expect(other?.[0].name).toBe('c2');
        resetAcpConnectorsCache();
        expect((await discoverAcpConnectors(opts))?.[0].name).toBe('c3');
    });
});

describe('resolveChatAgent', () => {
    it('spawns the named connector as its command, with the HTTP API only where it has one', () => {
        expect(resolveChatAgent('opencode', PARSED)).toEqual({ name: 'opencode', argv: ['opencode', 'acp'], httpApi: true });
        expect(resolveChatAgent('mine', PARSED)).toEqual({ name: 'mine', argv: ['my-acp', '--flag'], httpApi: false });
        expect(resolveChatAgent('', PARSED)?.name).toBe('opencode');
    });

    it('says why a connector cannot be used', () => {
        expect(() => resolveChatAgent('claude', PARSED)).toThrow(/not available.*claude-agent-acp.*PATH/);
        expect(() => resolveChatAgent('nope', PARSED)).toThrow(/not known.*known: opencode, claude, mine/);
    });

    it('keeps opencode, and only opencode, when the runtime lists nothing', () => {
        expect(resolveChatAgent('opencode', undefined)).toBeUndefined();
        expect(resolveChatAgent('', undefined)).toBeUndefined();
        expect(() => resolveChatAgent('claude', undefined)).toThrow(/lists no ACP connectors/);
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
