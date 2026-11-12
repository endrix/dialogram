/**
 * The Python language server's import paths, from the sidecar's interpreter:
 * what is added to `python.analysis.extraPaths`, and when nothing is.
 */
import { describe, expect, it } from 'vitest';
import {
    PythonAnalysisPaths, extraPathsToAdd, parsePythonEnvironment,
    type AnalysisFolder, type PythonAnalysisHost, type PythonEnvironment
} from '../src/python-analysis-paths';

const FOLDER = '/w/project';
const environment: PythonEnvironment = {
    prefix: '/w/project/.venv',
    roots: ['/w/project/flows', '/w/project', '/w/shared'],
    libraryPaths: ['/w/project/.venv/lib/python3.14/site-packages', '/opt/wfpy/src']
};

describe('the entries added to a folder\'s extraPaths', () => {
    it('are the import roots, relative inside the folder, the folder itself left out', () => {
        expect(extraPathsToAdd({ folder: FOLDER, existing: [], environment, sameInterpreter: true }))
            .toEqual(['flows', '/w/shared']);
    });

    it('include where packages are installed when the editor runs another interpreter', () => {
        expect(extraPathsToAdd({ folder: FOLDER, existing: [], environment, sameInterpreter: false }))
            .toEqual(['flows', '/w/shared', '.venv/lib/python3.14/site-packages', '/opt/wfpy/src']);
    });

    it('leave out what is there already, however it is written', () => {
        const existing = ['./flows/', '${workspaceFolder}/.venv/lib/python3.14/site-packages', '/w/shared', 'other'];
        expect(extraPathsToAdd({ folder: FOLDER, existing, environment, sameInterpreter: false })).toEqual(['/opt/wfpy/src']);
    });

    it('take a folder opened through a link, and a drive letter of another case, as the folder', () => {
        const linked = { roots: ['/real/project', '/real/project/flows'], libraryPaths: [] };
        expect(extraPathsToAdd({ folder: '/w/link', folderRealPath: '/real/project', existing: ['flows/sub'], environment: linked, sameInterpreter: true }))
            .toEqual(['flows']);
        const windows = { roots: ['C:/proj', 'C:/proj/flows', 'C:/proj/Lib'], libraryPaths: [] };
        expect(extraPathsToAdd({ folder: 'c:/proj', existing: ['FLOWS'], environment: windows, sameInterpreter: true, platform: 'win32' }))
            .toEqual(['Lib']);
    });

    it('add a path once that the interpreter names twice', () => {
        const twice = { ...environment, roots: ['/w/shared', '/w/shared/'], libraryPaths: ['/w/shared'] };
        expect(extraPathsToAdd({ folder: FOLDER, existing: [], environment: twice, sameInterpreter: false })).toEqual(['/w/shared']);
    });
});

describe('a sidecar\'s answer', () => {
    it('is read with its absolute paths only', () => {
        expect(parsePythonEnvironment({ interpreter: '/v/bin/python', prefix: '/v', roots: ['/a', 'rel', 3], libraryPaths: ['/s'] }))
            .toEqual({ prefix: '/v', roots: ['/a'], libraryPaths: ['/s'] });
        expect(parsePythonEnvironment({ roots: ['/a'] })).toEqual({ roots: ['/a'], libraryPaths: [] });
    });

    it('is nothing when it has another shape', () => {
        expect(parsePythonEnvironment(undefined)).toBeUndefined();
        expect(parsePythonEnvironment({ code: 'unknown_op' })).toBeUndefined();
    });
});

function host(over: Partial<PythonAnalysisHost> = {}) {
    const folder: AnalysisFolder = { path: FOLDER, name: 'project' };
    const state = {
        extraPaths: ['kept'] as string[], writes: [] as string[][], added: [] as string[][], lacking: [] as string[][],
        asked: 0, disabled: 0, logs: [] as string[]
    };
    const stand: PythonAnalysisHost = {
        folderOf: file => (file.startsWith(FOLDER) ? folder : undefined),
        enabled: () => true,
        languageServerInstalled: () => true,
        environmentOf: async () => { state.asked += 1; return environment; },
        selectedPrefix: async () => '/w/project/.venv',
        pyrightConfigPaths: async () => undefined,
        pyprojectSetsExtraPaths: async () => false,
        extraPaths: () => state.extraPaths,
        writeExtraPaths: async (_folder, paths) => { state.writes.push(paths); state.extraPaths = paths; },
        notifyAdded: (_folder, added) => { state.added.push(added); },
        notifyLacking: (_folder, lacking) => { state.lacking.push(lacking); },
        disable: async () => { state.disabled += 1; },
        log: message => { state.logs.push(message); },
        ...over
    };
    return { state, paths: new PythonAnalysisPaths(stand) };
}

describe('a source file whose diagram is opened', () => {
    it('has its import roots added after what the folder has, and says so once', async () => {
        const { state, paths } = host();
        await paths.consider(`${FOLDER}/flows/main.py`);
        expect(state.writes).toEqual([['kept', 'flows', '/w/shared']]);
        expect(state.added).toEqual([['flows', '/w/shared']]);
        // Again, and another file of the folder: asked once each, nothing left to add, nothing said.
        await paths.consider(`${FOLDER}/flows/main.py`);
        await paths.consider(`${FOLDER}/flows/other.py`);
        expect(state.asked).toBe(2);
        expect(state.writes).toHaveLength(1);
        expect(state.added).toHaveLength(1);
    });

    it('gets the installed packages too when the editor is known to have another interpreter', async () => {
        const other = host({ selectedPrefix: async () => '/usr' });
        await other.paths.consider(`${FOLDER}/flows/main.py`);
        expect(other.state.writes[0]).toEqual(['kept', 'flows', '/w/shared', '.venv/lib/python3.14/site-packages', '/opt/wfpy/src']);
        // Not told which (the Python extension still starting): the roots only.
        const unknown = host({ selectedPrefix: async () => undefined });
        await unknown.paths.consider(`${FOLDER}/flows/main.py`);
        expect(unknown.state.writes[0]).toEqual(['kept', 'flows', '/w/shared']);
    });

    it('is left alone outside a folder, with the setting off, or with no language server: the sidecar is not asked', async () => {
        for (const over of [{ enabled: () => false }, { languageServerInstalled: () => false }] as Partial<PythonAnalysisHost>[]) {
            const { state, paths } = host(over);
            await paths.consider(`${FOLDER}/flows/main.py`);
            expect([state.asked, state.writes.length]).toEqual([0, 0]);
        }
        const { state, paths } = host();
        await paths.consider('/elsewhere/main.py');
        expect([state.asked, state.writes.length]).toEqual([0, 0]);
    });

    it('is left alone when the sidecar has no answer, and asked again the next time it is opened', async () => {
        let answers = false;
        const { state, paths } = host({ environmentOf: async () => { state.asked += 1; return answers ? environment : undefined; } });
        await paths.consider(`${FOLDER}/flows/main.py`);
        expect(state.writes).toEqual([]);
        answers = true;
        await paths.consider(`${FOLDER}/flows/main.py`);
        expect(state.asked).toBe(2);
        expect(state.writes).toHaveLength(1);
    });

    it('leaves a pyrightconfig.json to its author, who is told once what it lacks', async () => {
        const { state, paths } = host({ pyrightConfigPaths: async () => ['flows'] });
        await paths.consider(`${FOLDER}/flows/main.py`);
        await paths.consider(`${FOLDER}/flows/other.py`);
        expect(state.writes).toEqual([]);
        expect(state.lacking).toEqual([['/w/shared']]);
        // One that has them all, or cannot be read: nothing written, nothing said.
        for (const configured of [['flows', '/w/shared'], 'unreadable'] as const) {
            const quiet = host({ pyrightConfigPaths: async () => configured as string[] | 'unreadable' });
            await quiet.paths.consider(`${FOLDER}/flows/main.py`);
            expect([quiet.state.writes.length, quiet.state.lacking.length]).toEqual([0, 0]);
        }
    });

    it('leaves a folder whose pyproject.toml sets the paths', async () => {
        const { state, paths } = host({ pyprojectSetsExtraPaths: async () => true });
        await paths.consider(`${FOLDER}/flows/main.py`);
        expect(state.writes).toEqual([]);
        expect(state.logs.join()).toContain('pyproject.toml');
    });

    it('does not throw when the write fails, and takes the next file', async () => {
        let fail = true;
        const { state, paths } = host({ writeExtraPaths: async (_folder, list) => { if (fail) { fail = false; throw new Error('read-only'); } state.writes.push(list); } });
        await paths.consider(`${FOLDER}/flows/main.py`);
        expect(state.logs.join()).toContain('read-only');
        await paths.consider(`${FOLDER}/flows/other.py`);
        expect(state.writes).toHaveLength(1);
    });

    it('is considered again after its settings changed', async () => {
        const { state, paths } = host();
        await paths.consider(`${FOLDER}/flows/main.py`);
        paths.forget();
        await paths.consider(`${FOLDER}/flows/main.py`);
        expect(state.asked).toBe(2);
    });

    it('turns the setting off when the notice is answered so', async () => {
        const { state, paths } = host({ notifyAdded: (_folder, _added, stop) => { void stop(); } });
        await paths.consider(`${FOLDER}/flows/main.py`);
        expect(state.disabled).toBe(1);
    });
});
