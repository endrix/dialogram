/**
 * A run that fails: the driver says where, and -- with a chat behind the
 * diagram -- offers "Fix with AI", which starts a plan-mode chat session whose
 * first message is the failure: its path, error, traceback and run directory.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { resetRegisteredCommands } from './vscode-mock';

vi.mock('../src/process-control.js', () => ({
    spawnWorkflowProcess: (invocation: { cmd: string; args: string[]; cwd: string }) => {
        const child: any = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        // The run, as the runtime would leave it: a log line and a failed record.
        const outDir = invocation.args[invocation.args.indexOf('--out-dir') + 1];
        const runDir = path.join(outDir, 'r1');
        fs.mkdirSync(runDir, { recursive: true });
        const source = invocation.args[invocation.args.indexOf('run') + 1];
        const now = new Date().toISOString();
        fs.writeFileSync(path.join(outDir, 'run-log.jsonl'), JSON.stringify({
            runId: 'r1', workflowName: 'top', sourcePath: source, startedAt: now, finishedAt: now, outDir: runDir
        }) + '\n');
        fs.writeFileSync(path.join(runDir, 'run.wf-run.json'), JSON.stringify({
            error: { message: 'ValueError: deep down', entityInstanceName: 'x', entityInstancePath: ['m', 'i', 'x'] }
        }));
        setTimeout(() => {
            child.stderr.emit('data', Buffer.from('Traceback (most recent call last):\nValueError: deep down\n'));
            child.emit('close', 1, null);
        }, 0);
        return child;
    },
    requestWorkflowStop: () => true
}));
vi.mock('../src/run-event-stream-client.js', () => ({
    RunEventStreamClient: class { constructor(_o: unknown) {} start(): void {} stop(): void {} }
}));

import { CliRunDriver, type CliRunDriverConfig } from '../src/index';

const RUN_CMD = 'test.fix.runWorkflow';

function makeDriver(startChatTask?: (task: any, uri: string) => Promise<boolean>) {
    const config: CliRunDriverConfig = {
        settingsNamespace: 'wfLang', customEditorViewType: 'workflow.networkDiagram',
        cliCommandSettingKey: 'wfpyCommand', cliCommandDefault: 'fake-wfpy', cliPythonModule: undefined,
        runOutputDirSettingKey: 'runOutputDir', liveExecutionGlowSettingKey: 'liveExecutionGlow',
        agentToolsSettingKey: 'agentTools', agentToolAuthSettingKey: 'agentToolAuth',
        agentToolPolicySettingKey: 'agentToolPolicy', agentToolTimeoutMsSettingKey: 'agentToolTimeoutMs',
        agentToolRegistrySettingKey: 'agentToolRegistry', agentMcpBridgeCmdSettingKey: 'agentMcpBridgeCmd',
        runWorkflowCommandId: RUN_CMD, stopWorkflowCommandId: 'test.fix.stop',
        agentToolConfigCommands: { set: 'test.fix.set', get: 'test.fix.get' },
        overrideState: { get: () => undefined, update: () => Promise.resolve() },
        cliResumeArgs: (dir, step) => ['--resume-from', dir, '--at-step', String(step)],
        elicitSocket: false
    };
    const host: any = {
        overlay: { emitEvents: () => {} },
        requestRefresh: () => {},
        output: { show: vi.fn(), append: () => {}, appendLine: () => {} },
        ...(startChatTask ? { startChatTask } : {})
    };
    const driver = new CliRunDriver(config, host);
    driver.registerCommands({ subscriptions: [] } as any);
    return { driver, host };
}

let original: any;
let shown: Array<{ message: string; actions: string[] }>;
let answer: string | undefined;

beforeEach(() => {
    resetRegisteredCommands();
    shown = [];
    original = (vscode.window as any).showErrorMessage;
    (vscode.window as any).showErrorMessage = async (message: string, ...actions: string[]) => {
        shown.push({ message, actions });
        return answer;
    };
});
afterEach(() => {
    (vscode.window as any).showErrorMessage = original;
});

async function failRun(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-with-ai-'));
    const file = path.join(dir, 'top.py');
    fs.writeFileSync(file, '# top\n');
    await vscode.commands.executeCommand(RUN_CMD, { sourceUri: `file://${file}`, workflowName: 'top' });
    // The offer is made without holding the run command up.
    await new Promise(resolve => setTimeout(resolve, 20));
}

describe('a run that fails', () => {
    it('says where it failed, and offers to fix it with the chat', async () => {
        answer = undefined;
        makeDriver(async () => true);
        await failRun();

        expect(shown).toHaveLength(1);
        expect(shown[0].message).toBe('Run failed in x (in m › i): ValueError: deep down');
        expect(shown[0].actions).toEqual(['Fix with AI', 'Show Output']);
    });

    it('starts a plan-mode chat task with the failure when the offer is taken', async () => {
        answer = 'Fix with AI';
        const startChatTask = vi.fn(async () => true);
        makeDriver(startChatTask);
        await failRun();

        expect(startChatTask).toHaveBeenCalledTimes(1);
        const [task, uri] = startChatTask.mock.calls[0] as any[];
        expect(uri).toMatch(/top\.py$/);
        expect(task.mode).toBe('plan');
        expect(task.name).toBe('Fix: x (in m › i)');
        expect(task.prompt).toContain('instance path `m/i/x`');
        expect(task.prompt).toContain('Traceback (most recent call last):');
        expect(task.prompt).toContain('resumed from where it failed');
    });

    it('offers no fix without a chat behind the diagram', async () => {
        answer = undefined;
        makeDriver(undefined);
        await failRun();

        expect(shown[0].actions).toEqual(['Show Output']);
    });
});
