/**
 * A run of the diagram runs the workflow the diagram shows and asks for its inputs: the command
 * palette's Run names no workflow, and a run without its inputs makes no token there and
 * "finishes" with nothing to show.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { resetRegisteredCommands } from './vscode-mock';

const spawns: string[][] = [];
vi.mock('../src/process-control.js', () => ({
    spawnWorkflowProcess: (invocation: { args: string[] }) => {
        spawns.push(invocation.args);
        const child: any = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setTimeout(() => child.emit('close', 0, null), 0);
        return child;
    },
    requestWorkflowStop: () => true
}));
vi.mock('../src/run-event-stream-client.js', () => ({
    RunEventStreamClient: class { constructor(_o: unknown) {} start(): void {} stop(): void {} }
}));

import { CliRunDriver, plannedRunOf, runFromChatCommandId, runInputValue, type CliRunDriverConfig, type PlannedRun } from '../src/cli-run-driver';

const RUN_CMD = 'test.inputs.runWorkflow';

let emitted: Array<{ uri: string; events: any[] }> = [];

function makeDriver(planRun?: CliRunDriverConfig['planRun']) {
    const config: CliRunDriverConfig = {
        settingsNamespace: 'wfLang', customEditorViewType: 'workflow.networkDiagram',
        cliCommandSettingKey: 'wfpyCommand', cliCommandDefault: 'fake-wfpy', cliPythonModule: undefined,
        runOutputDirSettingKey: 'runOutputDir', liveExecutionGlowSettingKey: 'liveExecutionGlow',
        agentToolsSettingKey: 'agentTools', agentToolAuthSettingKey: 'agentToolAuth',
        agentToolPolicySettingKey: 'agentToolPolicy', agentToolTimeoutMsSettingKey: 'agentToolTimeoutMs',
        agentToolRegistrySettingKey: 'agentToolRegistry', agentMcpBridgeCmdSettingKey: 'agentMcpBridgeCmd',
        runWorkflowCommandId: RUN_CMD, stopWorkflowCommandId: 'test.inputs.stop',
        agentToolConfigCommands: { set: 'test.inputs.set', get: 'test.inputs.get' },
        overrideState: { get: () => undefined, update: () => Promise.resolve() },
        elicitSocket: false,
        planRun
    };
    const driver = new CliRunDriver(config, {
        overlay: { emitEvents: (uri: string, events: any[]) => { emitted.push({ uri, events }); } },
        requestRefresh: () => {},
        output: { show: () => {}, append: () => {}, appendLine: () => {} }
    } as any);
    driver.registerCommands({ subscriptions: [] } as any);
    return driver;
}

const planned: PlannedRun = { workflowName: 'shout', inputs: [{ name: 'Text', type: 'str' }, { name: 'Doc', type: 'File' }] };
let typed: Array<string | undefined>;
let picked: string | undefined;
let finished: string[];
const originals: any = {};
const tempDirs: string[] = [];

beforeEach(() => {
    resetRegisteredCommands();
    spawns.length = 0;
    emitted = [];
    finished = [];
    typed = [];
    picked = '/data/in.txt';
    for (const key of ['showInformationMessage', 'showErrorMessage', 'showWarningMessage', 'showInputBox', 'showOpenDialog']) {
        originals[key] = (vscode.window as any)[key];
    }
    (vscode.window as any).showInformationMessage = async (message: string) => { finished.push(message); return undefined; };
    (vscode.window as any).showErrorMessage = async () => undefined;
    (vscode.window as any).showWarningMessage = async () => undefined;
    (vscode.window as any).showInputBox = vi.fn(async () => typed.shift());
    (vscode.window as any).showOpenDialog = vi.fn(async () => (picked ? [vscode.Uri.file(picked)] : undefined));
});
afterEach(() => {
    for (const [key, value] of Object.entries(originals)) {
        (vscode.window as any)[key] = value;
    }
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function sourceFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-inputs-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'wf.py');
    fs.writeFileSync(file, '# wf\n');
    return `file://${file}`;
}

async function run(args: Record<string, unknown>): Promise<any> {
    const result = await vscode.commands.executeCommand(RUN_CMD, args);
    if (spawns.length > 0) {
        await vi.waitFor(() => expect(finished).toContain('Workflow run finished.'), { timeout: 4000 });
    }
    return result;
}

const after = (args: string[], flag: string): string[] =>
    args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));

describe('a run of the diagram', () => {
    it("runs the plan's workflow when the caller names none, and asks for each input", async () => {
        const planRun = vi.fn(async () => planned);
        makeDriver(planRun);
        typed = ['hello'];
        await run({ sourceUri: sourceFile() });
        expect(planRun).toHaveBeenCalledWith(expect.anything(), undefined);
        expect(after(spawns[0], '--workflow')).toEqual(['shout']);
        // Text stays text; a File input is the file picked.
        expect(after(spawns[0], '--input')).toEqual(['Text="hello"', 'Doc=/data/in.txt']);
    });

    it('keeps the workflow its caller named, and takes the inputs it gives without asking', async () => {
        const planRun = vi.fn(async () => ({ ...planned, workflowName: 'other' }));
        makeDriver(planRun);
        await run({ sourceUri: sourceFile(), workflowName: 'shout', inputs: { Text: '42', Doc: '' } });
        expect(planRun).toHaveBeenCalledWith(expect.anything(), 'shout');
        expect(after(spawns[0], '--workflow')).toEqual(['shout']);
        // An empty value: no token on that input.
        expect(after(spawns[0], '--input')).toEqual(['Text="42"']);
        expect((vscode.window as any).showInputBox).not.toHaveBeenCalled();
    });

    it('asks for nothing a caller who cannot wait leaves out', async () => {
        makeDriver(async () => planned);
        await run({ sourceUri: sourceFile(), askInputs: false });
        expect(after(spawns[0], '--input')).toEqual([]);
        expect((vscode.window as any).showInputBox).not.toHaveBeenCalled();
    });

    it('is cancelled, and starts nothing, when the person cancels an input', async () => {
        makeDriver(async () => planned);
        typed = [undefined];
        const result = await run({ sourceUri: sourceFile() });
        expect(result).toEqual({ error: "Run cancelled: no value was given for the input 'Text'." });
        expect(spawns).toEqual([]);
    });

    it('offers the value given last time', async () => {
        makeDriver(async () => ({ workflowName: 'shout', inputs: [{ name: 'Text', type: 'str' }] }));
        const file = sourceFile();
        typed = ['first'];
        await run({ sourceUri: file });
        finished.length = 0;
        typed = ['second'];
        await run({ sourceUri: file });
        expect((vscode.window as any).showInputBox.mock.calls[1][0].value).toBe('first');
    });

    it('runs as before when the plan cannot say', async () => {
        makeDriver(async () => undefined);
        await run({ sourceUri: sourceFile() });
        expect(after(spawns[0], '--workflow')).toEqual([]);
        expect(after(spawns[0], '--input')).toEqual([]);
    });
});

describe('the plan of a run', () => {
    it("is the graph's workflow and its root inputs", () => {
        const graph = {
            id: 'wf:shout',
            nodes: [
                { id: 'wf:input:Doc', kind: 'wf-input', label: 'Doc', scope: 'scope:root', ports: [{ name: 'Doc', type: 'File' }] },
                { id: 'wf:output:Out', kind: 'wf-output', label: 'Out', scope: 'scope:root', ports: [{ name: 'Out', type: 'str' }] },
                { id: 'inner', kind: 'wf-input', label: 'X', scope: 'scope:sub', ports: [{ name: 'X' }] }
            ],
            subgraphs: [{ id: 'scope:root', kind: 'root' }, { id: 'scope:sub', kind: 'workflow' }]
        };
        expect(plannedRunOf(graph)).toEqual({ workflowName: 'shout', inputs: [{ name: 'Doc', type: 'File' }] });
        expect(plannedRunOf(undefined)).toBeUndefined();
    });

    it('quotes text, and leaves other values as typed', () => {
        expect(runInputValue('42', 'str')).toBe('"42"');
        expect(runInputValue('"already"', 'str')).toBe('"already"');
        expect(runInputValue('42', 'int')).toBe('42');
        expect(runInputValue('a.txt', 'File')).toBe('a.txt');
    });
});

describe("the chat's run", () => {
    const fromChat = (args: Record<string, unknown>) => vscode.commands.executeCommand<string>(runFromChatCommandId(RUN_CMD), args);
    const fileOf = (uri: string) => vscode.Uri.parse(uri).fsPath;

    it('starts nothing, and names the inputs, when one has no value', async () => {
        makeDriver(async () => planned);
        const said = await fromChat({ file: fileOf(sourceFile()), inputs: { Text: 'hi' } });
        expect(said).toContain('Not started: shout takes the input Doc (File)');
        expect(spawns).toEqual([]);
    });

    it("runs the plan's workflow with the values given, asking the person nothing, and says it finished", async () => {
        makeDriver(async () => planned);
        const said = await fromChat({ file: fileOf(sourceFile()), inputs: { Text: 'hi', Doc: '' }, waitSeconds: 5 });
        expect(after(spawns[0], '--workflow')).toEqual(['shout']);
        expect(after(spawns[0], '--input')).toEqual(['Text="hi"']);
        expect((vscode.window as any).showInputBox).not.toHaveBeenCalled();
        expect(said).toMatch(/^The run of shout finished/);
    });
});

describe('the end of a run', () => {
    it("closes the run's stream when the runtime did not, so no agent shows streaming for good", async () => {
        makeDriver(async () => undefined);
        await run({ sourceUri: sourceFile() });
        expect(emitted.flatMap(batch => batch.events).map(event => event.type)).toContain('run.stream.closing');
    });
});

