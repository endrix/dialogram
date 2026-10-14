/**
 * The chat panel's "open in the agent's CLI" and "copy session id": the
 * runtime opens the chat's own agent's session, in the session's directory.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatRuntime } from '../src/extension/chat/chat-runtime';
import { clipboardWrites, createdTerminals } from './vscode-mock';

function makeRuntime(cwd: string, connectorResume?: (connector: string, cwd: string) => string | undefined) {
    const memento = {
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        update: async (): Promise<void> => undefined,
        keys: (): string[] => []
    };
    const runtime = new ChatRuntime(
        { workspaceState: memento } as any,
        { key: 'test', displayName: 'Test', settingsSection: 'test.chat', connectorResume } as any,
        () => undefined,
        () => true
    );
    (runtime as any).acp = {
        agent: 'claude',
        resumeTemplate: 'claude --resume {sessionId}',
        sessionCwd: (id: string) => (id === 'abc-1' ? cwd : undefined)
    };
    return runtime;
}

beforeEach(() => {
    createdTerminals.length = 0;
    clipboardWrites.length = 0;
});

describe('opening the chat’s session natively', () => {
    it('opens a terminal running the agent’s resume command in the session’s directory', async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-native-'));
        try {
            await makeRuntime(cwd).handleMessage('file:///w/top.py', { type: 'chat.openSessionNatively', data: { sessionId: 'abc-1' } });
            expect(createdTerminals).toHaveLength(1);
            expect(createdTerminals[0].options.cwd).toBe(cwd);
            expect(createdTerminals[0].sent).toEqual(['claude --resume abc-1']);
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });

    it('copies the id, and ignores a message without one', async () => {
        const runtime = makeRuntime('/w');
        await runtime.handleMessage('file:///w/top.py', { type: 'chat.copySessionId', data: { sessionId: 'abc-1' } });
        await runtime.handleMessage('file:///w/top.py', { type: 'chat.openSessionNatively', data: {} });
        expect(clipboardWrites).toEqual(['abc-1']);
        expect(createdTerminals).toHaveLength(0);
    });
});

describe('opening a run agent\u2019s session natively', () => {
    it('uses the connector the firing named, as the workspace\u2019s connectors declare it', async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'run-native-'));
        try {
            const asked: string[][] = [];
            const runtime = makeRuntime('/elsewhere', (connector, dir) => {
                asked.push([connector, dir]);
                return connector === 'opencode' ? 'opencode -s {sessionId}' : undefined;
            });
            await runtime.handleMessage('file:///w/top.py', {
                type: 'chat.openAgentSession',
                data: { sessionId: 'ses_1', connector: 'opencode', cwd }
            });
            expect(asked).toEqual([['opencode', cwd]]);
            expect(createdTerminals[0].options.cwd).toBe(cwd);
            expect(createdTerminals[0].sent).toEqual(['opencode -s ses_1']);
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });

    it('falls back to the known connectors without a resolver, and copies without a connector', async () => {
        const runtime = makeRuntime('/w');
        await runtime.handleMessage('file:///w/top.py', { type: 'chat.openAgentSession', data: { sessionId: 'c1', connector: 'claude' } });
        expect(createdTerminals[0].sent).toEqual(['claude --resume c1']);

        await runtime.handleMessage('file:///w/top.py', { type: 'chat.openAgentSession', data: { sessionId: 'x9' } });
        expect(createdTerminals).toHaveLength(1);
        expect(clipboardWrites).toEqual(['x9']);
    });

    it('copies a run agent\u2019s session id', async () => {
        await makeRuntime('/w').handleMessage('file:///w/top.py', { type: 'chat.copyAgentSession', data: { sessionId: 'c1', connector: 'claude' } });
        expect(clipboardWrites).toEqual(['c1']);
    });
});
