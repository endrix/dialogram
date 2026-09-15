// The human port from the IDE: the driver forwards the shell's ACP connector
// and permission settings to `wfpy run`, listens for the run's questions on a
// Unix socket it names with `--elicit-socket`, and answers each through the
// host's `askUser`. The spawn is faked; the socket is real, driven from the
// test as wfpy would drive it: one JSON object a line, an answer per question.
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { resetRegisteredCommands } from './vscode-mock';

const spawnCalls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
let finishRun: (() => void) | undefined;
vi.mock('../src/process-control.js', () => ({
    spawnWorkflowProcess: (invocation: { cmd: string; args: string[]; cwd: string }) => {
        spawnCalls.push(invocation);
        const child: any = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        // The run ends when the test says so, so the socket is alive meanwhile.
        finishRun = () => child.emit('close', 0, null);
        return child;
    },
    requestWorkflowStop: () => true
}));
vi.mock('../src/run-event-stream-client.js', () => ({
    RunEventStreamClient: class {
        constructor(_opts: unknown) {}
        start(): void {}
        stop(): void {}
    }
}));

import { CliRunDriver, type CliRunDriverConfig, type RunQuestion, type RunAnswer } from '../src/index';

const RUN_CMD = 'test.runWorkflow';

function makeConfig(extra: Partial<CliRunDriverConfig> = {}): CliRunDriverConfig {
    let stored: Record<string, any> | undefined;
    return {
        settingsNamespace: 'wfpy',
        customEditorViewType: 'test.editor',
        cliCommandSettingKey: 'cliCommand',
        cliCommandDefault: 'fake-wfpy',
        runOutputDirSettingKey: 'runOutputDir',
        liveExecutionGlowSettingKey: 'liveExecutionGlow',
        agentToolsSettingKey: 'agentTools',
        agentToolAuthSettingKey: 'agentToolAuth',
        agentToolPolicySettingKey: 'agentToolPolicy',
        agentToolTimeoutMsSettingKey: 'agentToolTimeoutMs',
        agentToolRegistrySettingKey: 'agentToolRegistry',
        agentMcpBridgeCmdSettingKey: 'agentMcpBridgeCmd',
        runWorkflowCommandId: RUN_CMD,
        stopWorkflowCommandId: 'test.stopWorkflow',
        agentToolConfigCommands: { set: 'test.set', get: 'test.get' },
        overrideState: {
            get: () => stored,
            update: (value: Record<string, any>) => { stored = value; return Promise.resolve(); }
        },
        ...extra
    };
}

function makeHost(askUser?: (q: RunQuestion, sourceUri: string) => Promise<RunAnswer | undefined>) {
    const appended: string[] = [];
    return {
        overlay: { emitEvents: () => {} },
        requestRefresh: () => {},
        output: {
            show: () => {},
            append: (v: string) => void appended.push(v),
            appendLine: (v: string) => void appended.push(v)
        } as unknown as vscode.OutputChannel,
        askUser,
        appended
    };
}

function settings(values: Record<string, unknown>) {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
        get: <T>(key: string, defaultValue?: T): T | undefined => (key in values ? (values[key] as T) : defaultValue)
    } as any);
}

function fixtureFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-driver-elicit-'));
    const file = path.join(dir, 'pipeline.py');
    fs.writeFileSync(file, '# fixture\n', 'utf8');
    return file;
}

function startRun(driver: CliRunDriver, file: string): Promise<unknown> {
    driver.registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    return vscode.commands.executeCommand(RUN_CMD, { sourceUri: `file://${file}` });
}

async function ask(socketPath: string, questions: object[]): Promise<any[]> {
    // wfpy's side: one connection, one question at a time, one JSON line each way.
    const conn = net.connect(socketPath);
    await new Promise<void>((resolve, reject) => { conn.once('connect', resolve); conn.once('error', reject); });
    const replies: any[] = [];
    let buffer = '';
    for (const q of questions) {
        conn.write(JSON.stringify(q) + '\n');
        const line = await new Promise<string>((resolve) => {
            const onData = (chunk: Buffer) => {
                buffer += chunk.toString('utf8');
                const nl = buffer.indexOf('\n');
                if (nl >= 0) {
                    const one = buffer.slice(0, nl);
                    buffer = buffer.slice(nl + 1);
                    conn.off('data', onData);
                    resolve(one);
                }
            };
            conn.on('data', onData);
        });
        replies.push(JSON.parse(line));
    }
    conn.end();
    return replies;
}

describe('CliRunDriver: the ACP connector, the permission policy and the human port', () => {
    beforeEach(() => {
        spawnCalls.length = 0;
        finishRun = undefined;
        resetRegisteredCommands();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('forwards the connector and permission settings, and names a socket', async () => {
        settings({ 'acp.connector': 'claude', 'acp.permissions': 'reject' });
        const driver = new CliRunDriver(makeConfig({ acpConnectorSettingKey: 'acp.connector', acpPermissionsSettingKey: 'acp.permissions' }), makeHost() as any);
        const run = startRun(driver, fixtureFile());
        await vi.waitFor(() => expect(spawnCalls.length).toBe(1));
        const args = spawnCalls[0].args;
        expect(args.slice(args.indexOf('--acp-connector'), args.indexOf('--acp-connector') + 2)).toEqual(['--acp-connector', 'claude']);
        expect(args[args.indexOf('--agent-cli-acp-permissions') + 1]).toBe('reject');
        const socketPath = args[args.indexOf('--elicit-socket') + 1];
        expect(socketPath).toMatch(/acp-elicit-.*\.sock$/);
        expect(fs.existsSync(socketPath)).toBe(true);
        finishRun!();
        await run;
        expect(fs.existsSync(socketPath)).toBe(false);      // the socket goes with the run
    });

    it('passes nothing for settings a shell does not have or leaves empty', async () => {
        settings({ 'acp.connector': '', 'acp.permissions': '' });
        const driver = new CliRunDriver(makeConfig({ acpConnectorSettingKey: 'acp.connector', acpPermissionsSettingKey: 'acp.permissions', elicitSocket: false }), makeHost() as any);
        const run = startRun(driver, fixtureFile());
        await vi.waitFor(() => expect(spawnCalls.length).toBe(1));
        expect(spawnCalls[0].args).not.toContain('--acp-connector');
        expect(spawnCalls[0].args).not.toContain('--agent-cli-acp-permissions');
        expect(spawnCalls[0].args).not.toContain('--elicit-socket');
        finishRun!();
        await run;
    });

    it('answers the run\'s questions through the host, one JSON line each', async () => {
        settings({});
        const asked: RunQuestion[] = [];
        const answers = ['Reject', undefined];
        const host = makeHost(async (q) => {
            asked.push(q);
            const a = answers[asked.length - 1];
            return a === undefined ? { declined: true, reason: 'user said no' } : { answer: a };
        });
        const driver = new CliRunDriver(makeConfig(), host as any);
        const run = startRun(driver, fixtureFile());
        await vi.waitFor(() => expect(spawnCalls.length).toBe(1));
        const socketPath = spawnCalls[0].args[spawnCalls[0].args.indexOf('--elicit-socket') + 1];
        const replies = await ask(socketPath, [
            { type: 'question', id: 1, agent: 'planner', model: 'opus', question: 'Write core/cpu.py',
              context: 'The agent asks permission for this tool call.', choices: ['Always Allow', 'Allow', 'Reject'], timeout_ms: 600000 },
            { type: 'question', id: 2, agent: 'planner', question: 'Proceed?', choices: null }
        ]);
        expect(replies).toEqual([{ id: 1, answer: 'Reject' }, { id: 2, declined: true, reason: 'user said no' }]);
        expect(asked[0].question).toBe('Write core/cpu.py');
        expect(asked[0].choices).toEqual(['Always Allow', 'Allow', 'Reject']);
        expect(host.appended.some((l) => l.includes('Agent planner: Write core/cpu.py'))).toBe(true);
        finishRun!();
        await run;
    });
});
