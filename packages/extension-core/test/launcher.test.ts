import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    ALLOWED_PROGRAMS_KEY,
    ALWAYS,
    START,
    allowedToStart,
    expandLauncherArguments,
    expandPathPattern,
    followFile,
    launcherWords,
    launcherWorkingDirectory,
    notAProgram,
    patternSegments,
    quoteWord,
    startDetached,
    type ProgramMemory
} from '../src/extension/diagram/launcher';

// A folder token the way a run leaves one: the files a viewer names sit a
// fixed number of levels down, under names it does not know.
let root: string;
let token: string;

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-'));
    token = path.join(root, 'out');
    for (const file of [
        'objects/p/d/base/tech.lyt',
        'results/p/d/base/final.gds',
        'results/p/d/base/final.def',
        'results/p/d/.hidden/final.gds',
        'reports/p/d/base/drc.lyrdb'
    ]) {
        fs.mkdirSync(path.dirname(path.join(token, file)), { recursive: true });
        fs.writeFileSync(path.join(token, file), '');
    }
});

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('launcherWords', () => {
    it('takes strings as they are, Uris and file:// strings as paths, and flattens lists', () => {
        expect(launcherWords(['prog', vscode.Uri.file('/a/b.gds'), ['-m', 'file:///c/d.lyrdb'], undefined]))
            .toEqual(['prog', '/a/b.gds', '-m', '/c/d.lyrdb']);
    });

    it('refuses what is not a word', () => {
        expect(() => launcherWords(['prog', 3])).toThrow(/cannot pass a number/);
    });
});

describe('expandPathPattern', () => {
    it('matches one name per wildcard segment', () => {
        expect(expandPathPattern(`${token}/results/*/*/*/final.gds`))
            .toEqual([path.join(token, 'results/p/d/base/final.gds')]);
    });

    it('lets a wildcard skip a name starting with a dot, as a shell does', () => {
        expect(expandPathPattern(`${token}/results/p/d/*/final.gds`))
            .toEqual([path.join(token, 'results/p/d/base/final.gds')]);
        expect(expandPathPattern(`${token}/results/p/d/.*/final.gds`))
            .toEqual([path.join(token, 'results/p/d/.hidden/final.gds')]);
    });

    it('matches several files, sorted, and nothing when nothing is there', () => {
        expect(expandPathPattern(`${token}/results/p/d/base/final.*`))
            .toEqual([path.join(token, 'results/p/d/base/final.def'), path.join(token, 'results/p/d/base/final.gds')]);
        expect(expandPathPattern(`${token}/results/*/*/*/missing.gds`)).toEqual([]);
    });

    it('takes regex characters in a name literally', () => {
        expect(expandPathPattern(`${token}/results/p/d/base/final?gds`))
            .toEqual([path.join(token, 'results/p/d/base/final.gds')]);
        expect(expandPathPattern(`${token}/results/p/d/base/fin(al).gds*`)).toEqual([]);
    });
});

describe('expandLauncherArguments', () => {
    it('passes options through and replaces patterns by their matches', () => {
        expect(expandLauncherArguments([
            '-nn', `${token}/objects/*/*/*/tech.lyt`,
            `${token}/results/*/*/*/final.gds`,
            '-m', `${token}/reports/*/*/*/drc.lyrdb`
        ])).toEqual([
            '-nn', path.join(token, 'objects/p/d/base/tech.lyt'),
            path.join(token, 'results/p/d/base/final.gds'),
            '-m', path.join(token, 'reports/p/d/base/drc.lyrdb')
        ]);
    });

    it('says which pattern matched nothing, and which path does not exist', () => {
        expect(() => expandLauncherArguments([`${token}/results/*/*/*/missing.gds`]))
            .toThrow(`nothing matches ${token}/results/*/*/*/missing.gds`);
        expect(() => expandLauncherArguments(['/does/not/exist.gds'])).toThrow('/does/not/exist.gds does not exist');
    });

    it('leaves a relative word alone: it may be a value, not a path', () => {
        expect(expandLauncherArguments(['-rd', 'name=value'])).toEqual(['-rd', 'name=value']);
    });
});

describe('launcherWorkingDirectory', () => {
    it('is the configured folder, relative to the workspace folder or with ${workspaceFolder}', () => {
        expect(launcherWorkingDirectory(token, [], undefined)).toBe(token);
        expect(launcherWorkingDirectory('out/results', [], root)).toBe(path.join(token, 'results'));
        expect(launcherWorkingDirectory('${workspaceFolder}/out', [], root)).toBe(token);
    });

    it('refuses a configured folder that does not exist', () => {
        expect(() => launcherWorkingDirectory('/does/not/exist', [], undefined)).toThrow(/does not exist/);
    });

    it('is otherwise the first file\'s folder, or none', () => {
        const gds = path.join(token, 'results/p/d/base/final.gds');
        expect(launcherWorkingDirectory('', ['-nn', gds], undefined)).toBe(path.dirname(gds));
        expect(launcherWorkingDirectory(undefined, ['-z'], undefined)).toBeUndefined();
    });
});

describe('quoteWord', () => {
    it('quotes only what a shell would need quoted', () => {
        expect(quoteWord('/a/b-c.gds')).toBe('/a/b-c.gds');
        expect(quoteWord('a b')).toBe(`'a b'`);
        expect(quoteWord(`it's`)).toBe(`'it'\\''s'`);
    });
});

describe('the launcher, after its review', () => {
    it('splits a Windows path under its root, a drive or a share', () => {
        expect(patternSegments('C:\\run\\out\\*\\x.gds', path.win32)).toEqual({ root: 'C:\\', segments: ['run', 'out', '*', 'x.gds'] });
        expect(patternSegments('\\\\host\\share\\out\\*.gds', path.win32)).toEqual({ root: '\\\\host\\share\\', segments: ['out', '*.gds'] });
        expect(patternSegments('/run/out/*/x.gds', path.posix)).toEqual({ root: '/', segments: ['run', 'out', '*', 'x.gds'] });
    });

    it('reads a relative pattern from where the program starts', () => {
        expect(expandPathPattern('results/*/*/*/final.gds', token)).toEqual([path.join(token, 'results/p/d/base/final.gds')]);
        expect(expandLauncherArguments(['results/*/*/*/final.gds'], token)).toEqual([path.join(token, 'results/p/d/base/final.gds')]);
    });

    it('keeps a pattern’s ? when the path comes as a file URI', () => {
        expect(launcherWords([`file://${token}/results/p/d/base/final.gd?`])).toEqual([`${token}/results/p/d/base/final.gd?`]);
    });

    it('refuses a file that is not a program, the token a viewer with no args hands it', () => {
        const data = path.join(token, 'results/p/d/base/final.gds');
        expect(notAProgram(data)).toMatch(/is not a program/);
        expect(notAProgram(token)).toMatch(/is a folder/);
        expect(notAProgram(process.execPath)).toBeUndefined();
        expect(notAProgram('klayout')).toBeUndefined();
    });

    it('says a working directory relative to a workspace folder has none to be relative to', () => {
        expect(() => launcherWorkingDirectory('${workspaceFolder}/flow', [], undefined)).toThrow(/there is none/);
        expect(() => launcherWorkingDirectory('flow', [], undefined)).toThrow(/there is none/);
    });

    it('asks before a program starts, with its command line, and remembers "always" for that program', async () => {
        const store: Record<string, unknown> = {};
        const memory: ProgramMemory = {
            get: <T>(key: string, fallback: T) => (store[key] as T) ?? fallback,
            update: async (key, value) => { store[key] = value; }
        };
        const asked: string[][] = [];
        const answers: (string | undefined)[] = [undefined, START, `${ALWAYS} klayout`];
        const ask = async (message: string, detail: string, ...items: string[]) => { asked.push([message, detail, ...items]); return answers.shift(); };
        expect(await allowedToStart('/usr/bin/klayout', 'klayout -nn x.gds', memory, ask)).toBe(false);  // dismissed
        expect(asked[0]).toEqual(['Start klayout?', 'A workflow in this workspace asks to run:\n\nklayout -nn x.gds', START, `${ALWAYS} klayout`]);
        expect(await allowedToStart('/usr/bin/klayout', 'c', memory, ask)).toBe(true);   // once
        expect(store[ALLOWED_PROGRAMS_KEY]).toBeUndefined();
        expect(await allowedToStart('/usr/bin/klayout', 'c', memory, ask)).toBe(true);   // always
        expect(store[ALLOWED_PROGRAMS_KEY]).toEqual(['/usr/bin/klayout']);
        expect(await allowedToStart('/usr/bin/klayout', 'c', memory, ask)).toBe(true);
        expect(asked).toHaveLength(3);                                                    // not asked again
        expect(await allowedToStart('/tmp/other', 'c', memory, async () => undefined)).toBe(false);
    });

    it('starts a program that outlives the process that started it, and follows its output', async () => {
        const marker = path.join(root, 'outlived.txt');
        const script = "process.stdout.write('first\\n'); setTimeout(() => { process.stdout.write('héllo later\\n'); require('fs').writeFileSync(process.argv[1], 'done'); }, 300);";
        const { child, log } = startDetached(process.execPath, ['-e', script, marker], root);
        const seen: string[] = [];
        const stop = followFile(log, text => seen.push(text), 50);
        await new Promise<void>(resolve => child.on('exit', () => resolve()));
        stop();
        expect(seen.join('')).toBe('first\nhéllo later\n');
        expect(fs.readFileSync(marker, 'utf8')).toBe('done');
        // Its output is a file, not a pipe into this process: nothing to break when this one ends.
        expect(child.stdout).toBeNull();
        expect(child.stderr).toBeNull();
        fs.rmSync(path.dirname(log), { recursive: true, force: true });
    });
});
