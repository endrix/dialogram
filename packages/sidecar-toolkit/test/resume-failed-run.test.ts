/**
 * The agent that fixed a failed run proposes resuming it: its chat tool runs
 * the driver's command, which asks the person, then resumes the run from its
 * last completed step -- where it failed -- with what ran before replayed.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { resetRegisteredCommands } from './vscode-mock';

/** Each spawn: the first fails (leaving a record and a three-step trace), later ones succeed. */
const spawns: string[][] = [];
vi.mock('../src/process-control.js', () => ({
    spawnWorkflowProcess: (invocation: { args: string[] }) => {
        spawns.push(invocation.args);
        const child: any = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        const fails = spawns.length === 1;
        if (fails) {
            const outDir = invocation.args[invocation.args.indexOf('--out-dir') + 1];
            const runDir = path.join(outDir, 'r1');
            fs.mkdirSync(runDir, { recursive: true });
            const now = new Date().toISOString();
            fs.writeFileSync(path.join(outDir, 'run-log.jsonl'), JSON.stringify({
                runId: 'r1', workflowName: 'top', sourcePath: invocation.args[invocation.args.indexOf('run') + 1],
                startedAt: now, finishedAt: now, outDir: runDir
            }) + '\n');
            fs.writeFileSync(path.join(runDir, 'run.wf-run.json'), JSON.stringify({
                error: { message: 'ValueError: no', entityInstancePath: ['m', 'x'] }
            }));
            fs.writeFileSync(path.join(runDir, 'run.wf-queues.json'), JSON.stringify({
                version: 1,
                steps: [1, 2, 3].map(step => ({ step, actorInstanceName: 'a', journalSeq: step }))
            }));
        }
        setTimeout(() => child.emit('close', fails ? 1 : 0, null), 0);
        return child;
    },
    requestWorkflowStop: () => true
}));
vi.mock('../src/run-event-stream-client.js', () => ({
    RunEventStreamClient: class { constructor(_o: unknown) {} start(): void {} stop(): void {} }
}));

import { CliRunDriver, resumeFailedRunCommandId, type CliRunDriverConfig } from '../src/index';
import { resumeFailedRunTool } from '../src/sidecar-diagram-profile';

const RUN_CMD = 'test.resume.runWorkflow';

function makeDriver(canResume = true) {
    const config: CliRunDriverConfig = {
        settingsNamespace: 'wfLang', customEditorViewType: 'workflow.networkDiagram',
        cliCommandSettingKey: 'wfpyCommand', cliCommandDefault: 'fake-wfpy', cliPythonModule: undefined,
        runOutputDirSettingKey: 'runOutputDir', liveExecutionGlowSettingKey: 'liveExecutionGlow',
        agentToolsSettingKey: 'agentTools', agentToolAuthSettingKey: 'agentToolAuth',
        agentToolPolicySettingKey: 'agentToolPolicy', agentToolTimeoutMsSettingKey: 'agentToolTimeoutMs',
        agentToolRegistrySettingKey: 'agentToolRegistry', agentMcpBridgeCmdSettingKey: 'agentMcpBridgeCmd',
        runWorkflowCommandId: RUN_CMD, stopWorkflowCommandId: 'test.resume.stop',
        agentToolConfigCommands: { set: 'test.resume.set', get: 'test.resume.get' },
        overrideState: { get: () => undefined, update: () => Promise.resolve() },
        ...(canResume ? { cliResumeArgs: (dir: string, step: number) => ['--resume-from', dir, '--at-step', String(step)] } : {}),
        elicitSocket: false
    };
    const driver = new CliRunDriver(config, {
        overlay: { emitEvents: () => {} },
        requestRefresh: () => {},
        output: { show: () => {}, append: () => {}, appendLine: () => {} }
    } as any);
    driver.registerCommands({ subscriptions: [] } as any);
    return driver;
}

let answer: string | undefined;
let asked: string[];
const originals: any = {};

beforeEach(() => {
    resetRegisteredCommands();
    spawns.length = 0;
    asked = [];
    originals.info = (vscode.window as any).showInformationMessage;
    originals.error = (vscode.window as any).showErrorMessage;
    (vscode.window as any).showInformationMessage = async (message: string) => {
        asked.push(message);
        return message.startsWith("The chat's fix") ? answer : undefined;
    };
    (vscode.window as any).showErrorMessage = async () => undefined;
});
afterEach(() => {
    (vscode.window as any).showInformationMessage = originals.info;
    (vscode.window as any).showErrorMessage = originals.error;
});

async function failRun(): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-failed-'));
    const file = path.join(dir, 'top.py');
    fs.writeFileSync(file, '# top\n');
    await vscode.commands.executeCommand(RUN_CMD, { sourceUri: `file://${file}`, workflowName: 'top' });
    return file;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

describe('resuming a failed run when the agent proposes it', () => {
    it('asks the person, then resumes from the last completed step', async () => {
        makeDriver();
        const file = await failRun();
        answer = 'Resume';

        const result = await vscode.commands.executeCommand<string>(resumeFailedRunCommandId(RUN_CMD), { file });
        await settle();

        expect(asked.some(q => q.includes('Resume the run of top from where it failed (x (in m))'))).toBe(true);
        expect(result).toContain('resuming from where it failed');
        const resumed = spawns[1];
        expect(resumed.slice(resumed.indexOf('--resume-from'))).toEqual(
            expect.arrayContaining(['--resume-from', '--at-step', '3'])
        );
    });

    it('does not resume when the person says not now', async () => {
        makeDriver();
        const file = await failRun();
        answer = 'Not now';

        const result = await vscode.commands.executeCommand<string>(resumeFailedRunCommandId(RUN_CMD), { file });
        await settle();

        expect(result).toContain('chose not to resume');
        expect(spawns).toHaveLength(1);
    });

    it('finds the failed run from a nested workflow’s file too', async () => {
        makeDriver();
        await failRun();
        answer = 'Resume';

        await vscode.commands.executeCommand(resumeFailedRunCommandId(RUN_CMD), { file: '/w/layers/nested.py' });
        await settle();

        expect(spawns).toHaveLength(2);
    });

    it('has nothing to resume once the workflow has run clean', async () => {
        makeDriver();
        const file = await failRun();
        answer = 'Resume';
        await vscode.commands.executeCommand(resumeFailedRunCommandId(RUN_CMD), { file });
        await settle(); // the resumed run succeeds

        const again = await vscode.commands.executeCommand<string>(resumeFailedRunCommandId(RUN_CMD), { file });
        expect(again).toContain('no failed run to resume');
    });

    it('says so when the runtime cannot resume', async () => {
        makeDriver(false);
        const file = await failRun();
        const result = await vscode.commands.executeCommand<string>(resumeFailedRunCommandId(RUN_CMD), { file });
        expect(result).toContain('cannot resume');
    });
});

describe('the chat tool', () => {
    it('runs the driver’s command with the session’s file and returns its answer', async () => {
        const tool = resumeFailedRunTool(RUN_CMD);
        const calls: unknown[] = [];
        vscode.commands.registerCommand(resumeFailedRunCommandId(RUN_CMD), async (args: unknown) => {
            calls.push(args);
            return 'The run is resuming from where it failed.';
        });

        expect(tool.name).toBe('resume_failed_run');
        expect(await tool.handler('/w/top.py', {})).toBe('The run is resuming from where it failed.');
        expect(calls).toEqual([{ file: '/w/top.py' }]);
    });
});
