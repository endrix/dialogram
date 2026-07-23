// The CliRunDriver owns the per-entity agent-tool override state that used to
// live in extension-core's glsp-activation: the `setAgentToolConfig` /
// `getAgentToolConfig` commands mutate it, a memento-backed accessor persists
// it, and the `run` command consumes it when building the CLI args. These tests
// exercise all three through the toolkit vscode-mock's command registry and a
// faked run spawn.
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { resetRegisteredCommands } from './vscode-mock';

// Fake the CLI spawn so the run command completes deterministically without a
// real child process, capturing the invocation so we can assert the args that
// the agent-tool overrides produced.
const spawnCalls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
vi.mock('../src/process-control.js', () => ({
    spawnWorkflowProcess: (invocation: { cmd: string; args: string[]; cwd: string }) => {
        spawnCalls.push(invocation);
        const child: any = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        // Resolve the run on the next tick with a clean exit.
        setTimeout(() => child.emit('close', 0, null), 0);
        return child;
    },
    requestWorkflowStop: () => true
}));

// The read-only SSE stream is best-effort and irrelevant here; stub it out.
vi.mock('../src/run-event-stream-client.js', () => ({
    RunEventStreamClient: class {
        constructor(_opts: unknown) {}
        start(): void {}
        stop(): void {}
    }
}));

import { CliRunDriver, type CliRunDriverConfig, type AgentToolEntitySettings } from '../src/index';

const SET_CMD = 'test.setAgentToolConfig';
const GET_CMD = 'test.getAgentToolConfig';
const RUN_CMD = 'test.runWorkflow';
const STOP_CMD = 'test.stopWorkflow';

function makeOverrideState() {
    let stored: Record<string, AgentToolEntitySettings> | undefined;
    return {
        get: (): Record<string, AgentToolEntitySettings> | undefined => stored,
        update: (value: Record<string, AgentToolEntitySettings>): Thenable<void> => {
            stored = value;
            return Promise.resolve();
        },
        peek: (): Record<string, AgentToolEntitySettings> | undefined => stored
    };
}

function makeConfig(overrideState: CliRunDriverConfig['overrideState']): CliRunDriverConfig {
    return {
        settingsNamespace: 'wfLang',
        customEditorViewType: 'workflow.networkDiagram',
        cliCommandSettingKey: 'wfpyCommand',
        cliCommandDefault: 'fake-wfpy',
        cliPythonModule: undefined,
        runOutputDirSettingKey: 'runOutputDir',
        liveExecutionGlowSettingKey: 'liveExecutionGlow',
        agentToolsSettingKey: 'agentTools',
        agentToolAuthSettingKey: 'agentToolAuth',
        agentToolPolicySettingKey: 'agentToolPolicy',
        agentToolTimeoutMsSettingKey: 'agentToolTimeoutMs',
        agentToolRegistrySettingKey: 'agentToolRegistry',
        agentMcpBridgeCmdSettingKey: 'agentMcpBridgeCmd',
        runWorkflowCommandId: RUN_CMD,
        stopWorkflowCommandId: STOP_CMD,
        agentToolConfigCommands: { set: SET_CMD, get: GET_CMD },
        overrideState
    };
}

function makeHost() {
    const appended: string[] = [];
    return {
        overlay: { emitEvents: () => {} },
        requestRefresh: () => {},
        output: {
            show: () => {},
            append: (v: string) => void appended.push(v),
            appendLine: (v: string) => void appended.push(v)
        } as unknown as vscode.OutputChannel,
        appended
    };
}

function makeContext() {
    return { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext;
}

describe('CliRunDriver agent-tool overrides', () => {
    beforeEach(() => {
        spawnCalls.length = 0;
        resetRegisteredCommands();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('registers both config commands alongside run/stop', () => {
        const overrideState = makeOverrideState();
        const driver = new CliRunDriver(makeConfig(overrideState), makeHost() as any);
        const context = makeContext();
        driver.registerCommands(context);
        // run + stop + set + get
        expect(context.subscriptions.length).toBe(4);
    });

    it('set mutates + persists via the accessor, get reads current', async () => {
        const overrideState = makeOverrideState();
        const driver = new CliRunDriver(makeConfig(overrideState), makeHost() as any);
        driver.registerCommands(makeContext());

        await vscode.commands.executeCommand(SET_CMD, { entityName: 'stage-a', enabled: true, auth: 'allow-all' });
        expect(overrideState.peek()).toEqual({ 'stage-a': { enabled: true, auth: 'allow-all' } });

        const got = await vscode.commands.executeCommand(GET_CMD, 'stage-a');
        expect(got).toEqual({ enabled: true, auth: 'allow-all' });

        // Disabling removes the entry and re-persists.
        await vscode.commands.executeCommand(SET_CMD, { entityName: 'stage-a', enabled: false, auth: 'allow-all' });
        expect(overrideState.peek()).toEqual({});

        const gone = await vscode.commands.executeCommand(GET_CMD, 'stage-a');
        expect(gone).toEqual({ enabled: false, auth: 'deny-all' });
    });

    it('restores persisted overrides at registration time', async () => {
        const overrideState = makeOverrideState();
        await overrideState.update({ preset: { enabled: true, auth: 'policy' } });
        const driver = new CliRunDriver(makeConfig(overrideState), makeHost() as any);
        driver.registerCommands(makeContext());

        const got = await vscode.commands.executeCommand(GET_CMD, 'preset');
        expect(got).toEqual({ enabled: true, auth: 'policy' });
    });

    it('run spawn consumes the overrides map (args reflect an enabled override)', async () => {
        const overrideState = makeOverrideState();
        const driver = new CliRunDriver(makeConfig(overrideState), makeHost() as any);
        driver.registerCommands(makeContext());

        await vscode.commands.executeCommand(SET_CMD, { entityName: 'stage-a', enabled: true, auth: 'allow-all' });

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-driver-'));
        const file = path.join(dir, 'pipeline.py');
        fs.writeFileSync(file, '# fixture\n', 'utf8');

        await vscode.commands.executeCommand(RUN_CMD, { sourceUri: `file://${file}` });

        expect(spawnCalls.length).toBe(1);
        const args = spawnCalls[0].args;
        expect(args).toContain('--agent-tools');
        const authIdx = args.indexOf('--agent-tool-auth');
        expect(authIdx).toBeGreaterThanOrEqual(0);
        expect(args[authIdx + 1]).toBe('allow-all');
    });

    it('run spawn omits agent-tool flags when no override is enabled', async () => {
        const overrideState = makeOverrideState();
        const driver = new CliRunDriver(makeConfig(overrideState), makeHost() as any);
        driver.registerCommands(makeContext());

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-driver-'));
        const file = path.join(dir, 'pipeline.py');
        fs.writeFileSync(file, '# fixture\n', 'utf8');

        await vscode.commands.executeCommand(RUN_CMD, { sourceUri: `file://${file}` });

        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0].args).not.toContain('--agent-tools');
        expect(spawnCalls[0].args).not.toContain('--agent-tool-auth');
    });
});

// The driver now owns the `run.wf-viewer.live.json` file knowledge (name, schema,
// and out-dir resolution) that extension-core's editor provider used to read
// directly. `watchLiveOverlay` registers interest in a source URI and an
// always-on poll publishes the overlay signature through `onLiveOverlaySignature`;
// the provider consumes it to drive live-execution glow refreshes.
describe('CliRunDriver live-overlay signature', () => {
    it('publishes the overlay signature: undefined when absent, a string once written, changing on rewrite, undefined on removal', async () => {
        const driver = new CliRunDriver(makeConfig(makeOverrideState()), makeHost() as any);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-driver-overlay-'));
        const file = path.join(dir, 'pipeline.py');
        fs.writeFileSync(file, '# fixture\n', 'utf8');
        const outDir = path.join(dir, 'wf-out');
        fs.mkdirSync(outDir, { recursive: true });
        const overlayPath = path.join(outDir, 'run.wf-viewer.live.json');

        const events: Array<{ uri: string; signature: string | undefined }> = [];
        const sub = driver.onLiveOverlaySignature((uri, signature) => events.push({ uri, signature }));
        const watch = driver.watchLiveOverlay(vscode.Uri.file(file));

        // Directly drive the poll so the assertions stay deterministic (the same
        // work the 500ms always-on interval performs).
        const poll = (): Promise<void> => (driver as any).pollWatchedLiveOverlays();

        await poll();
        expect(events.at(-1)?.signature).toBeUndefined();

        fs.writeFileSync(
            overlayPath,
            JSON.stringify({ runId: 'r1', running: true, active: [{ entityInstanceName: 'stage-a', entityInstancePath: ['top', 'stage-a'], fireCount: 1 }] }),
            'utf8'
        );
        await poll();
        const firstSignature = events.at(-1)?.signature;
        expect(typeof firstSignature).toBe('string');
        expect(firstSignature).toContain('stage-a');

        fs.writeFileSync(
            overlayPath,
            JSON.stringify({ runId: 'r1', running: true, active: [{ entityInstanceName: 'stage-a', entityInstancePath: ['top', 'stage-a'], fireCount: 2 }] }),
            'utf8'
        );
        await poll();
        expect(typeof events.at(-1)?.signature).toBe('string');
        expect(events.at(-1)?.signature).not.toBe(firstSignature);

        fs.rmSync(overlayPath);
        await poll();
        expect(events.at(-1)?.signature).toBeUndefined();

        watch.dispose();
        sub.dispose();
    });

    it('stops polling a source once its watch subscription is disposed', async () => {
        const driver = new CliRunDriver(makeConfig(makeOverrideState()), makeHost() as any);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-driver-overlay-'));
        const file = path.join(dir, 'pipeline.py');
        fs.writeFileSync(file, '# fixture\n', 'utf8');

        const events: Array<string | undefined> = [];
        driver.onLiveOverlaySignature((_uri, signature) => events.push(signature));
        const watch = driver.watchLiveOverlay(vscode.Uri.file(file));
        watch.dispose();

        await (driver as any).pollWatchedLiveOverlays();
        expect(events.length).toBe(0);
    });

    it('never polls a non-file source URI', async () => {
        const driver = new CliRunDriver(makeConfig(makeOverrideState()), makeHost() as any);
        const events: Array<string | undefined> = [];
        driver.onLiveOverlaySignature((_uri, signature) => events.push(signature));

        driver.watchLiveOverlay(vscode.Uri.parse('untitled:Untitled-1'));

        await (driver as any).pollWatchedLiveOverlays();
        expect(events.length).toBe(0);
    });
});
