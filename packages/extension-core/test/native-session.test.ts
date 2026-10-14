/**
 * Opening an agent's session in its own CLI: the connector's `resume`
 * template with the session id, typed into a terminal in the session's
 * directory; no template, and the id is copied instead.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { clipboardWrites, createdTerminals } from './vscode-mock';
import { loadAcpConnectors, resolveChatAgent, resumeCommandFor } from '../src/extension/chat/acp-connectors';
import { copySessionId, openSessionNatively } from '../src/extension/chat/native-session';

const FILES = { user: 'wfpy/connectors.toml', workspace: '.wfpy/connectors.toml' };

beforeEach(() => {
    createdTerminals.length = 0;
    clipboardWrites.length = 0;
});

describe('resumeCommandFor', () => {
    it('puts the id in the template, quoted when it needs to be', () => {
        expect(resumeCommandFor('claude --resume {sessionId}', '3f2a-11')).toBe('claude --resume 3f2a-11');
        expect(resumeCommandFor('opencode -s {sessionId}', 'ses_ab12')).toBe('opencode -s ses_ab12');
        expect(resumeCommandFor('x {sessionId}', "a b'c")).toBe("x 'a b'\\''c'");
    });

    it('is undefined without a template, or one that never names the id', () => {
        expect(resumeCommandFor(undefined, 'id')).toBeUndefined();
        expect(resumeCommandFor('claude --continue', 'id')).toBeUndefined();
    });
});

describe('the connectors’ resume commands', () => {
    it('are known for claude and opencode, and a connectors file can set or clear one', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-session-'));
        try {
            const bin = path.join(dir, 'bin');
            fs.mkdirSync(bin);
            for (const name of ['claude-agent-acp', 'opencode', 'codex-acp']) {
                fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
            }
            const userFile = path.join(dir, 'connectors.toml');
            fs.writeFileSync(userFile, '[connectors.codex]\nresume = "codex resume {sessionId}"\n[connectors.opencode]\nresume = ""\n');
            const found = loadAcpConnectors({ files: FILES, workspaceDir: dir, userFile, workspaceFile: path.join(dir, 'none'), pathDirs: [bin] });
            const resume = Object.fromEntries(found.map(c => [c.name, c.resume]));
            expect(resume).toEqual({ claude: 'claude --resume {sessionId}', codex: 'codex resume {sessionId}', gemini: undefined, opencode: undefined });
            expect(resolveChatAgent('claude', found)?.resume).toBe('claude --resume {sessionId}');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('openSessionNatively', () => {
    it('types the command into a terminal in the session’s directory', async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cwd-'));
        try {
            const opened = await openSessionNatively({ agent: 'claude', sessionId: 'abc-1', resume: 'claude --resume {sessionId}', cwd });
            expect(opened).toBe(true);
            expect(createdTerminals).toHaveLength(1);
            expect(createdTerminals[0].options.cwd).toBe(cwd);
            expect(createdTerminals[0].sent).toEqual(['claude --resume abc-1']);
            expect(createdTerminals[0].shown).toBe(true);
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });

    it('opens without a directory that is gone', async () => {
        await openSessionNatively({ agent: 'opencode', sessionId: 'ses_1', resume: 'opencode -s {sessionId}', cwd: '/no/such/dir' });
        expect(createdTerminals[0].options.cwd).toBeUndefined();
        expect(createdTerminals[0].sent).toEqual(['opencode -s ses_1']);
    });

    it('copies the id when the connector has no command', async () => {
        expect(await openSessionNatively({ agent: 'gemini', sessionId: 'g-9' })).toBe(false);
        expect(createdTerminals).toHaveLength(0);
        expect(clipboardWrites).toEqual(['g-9']);
    });
});

describe('copySessionId', () => {
    it('writes the id to the clipboard', async () => {
        await copySessionId({ agent: 'claude', sessionId: 'abc-1' });
        expect(clipboardWrites).toEqual(['abc-1']);
    });
});
