import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    expandLauncherArguments,
    expandPathPattern,
    launcherWords,
    launcherWorkingDirectory,
    quoteWord
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
