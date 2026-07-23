import { describe, expect, it, vi } from 'vitest';
import { SlashCommandRegistry, type ChatCommandContribution } from '../src/extension/chat/slash-commands';

const noopCtx = { file: '/tmp/wf.py', uri: 'file:///tmp/wf.py', sessionId: 's1', selectedNodeIds: [] };

function makeRegistry(extra: ChatCommandContribution[] = []) {
    return new SlashCommandRegistry([
        {
            command: 'create-task',
            description: 'Create a new task node',
            usage: '<name>',
            modes: ['build'],
            handler: async () => ({ success: true })
        },
        { command: 'ask', description: 'Pass-through suggestion' },
        ...extra
    ]);
}

describe('SlashCommandRegistry.parse', () => {
    it('parses command, positionals and key=value args (quotes stripped)', () => {
        const r = makeRegistry();
        expect(r.parse('/create-task reader type="file"')).toEqual({
            command: 'create-task',
            args: { _positional: ['reader'], type: 'file' }
        });
    });

    it('returns null for non-slash input and for malformed slash input', () => {
        const r = makeRegistry();
        expect(r.parse('hello world')).toBeNull();
        expect(r.parse('/bad!cmd x')).toBeNull(); // legacy: falls through to the agent
    });
});

describe('SlashCommandRegistry.resolve', () => {
    it('resolves a known command with args', () => {
        const r = makeRegistry();
        const hit = r.resolve('/create-task reader', 'build');
        expect(hit?.contribution.command).toBe('create-task');
        expect(hit?.args).toEqual({ _positional: ['reader'] });
    });

    it('returns null for natural language', () => {
        expect(makeRegistry().resolve('make me a task', 'build')).toBeNull();
    });

    it('throws the legacy unknown-command error', () => {
        expect(() => makeRegistry().resolve('/nope', 'build')).toThrowError(
            'Unknown command: nope. Type /help for available commands.'
        );
    });

    it('throws the legacy mode-mismatch error', () => {
        expect(() => makeRegistry().resolve('/create-task x', 'plan')).toThrowError(
            "Command 'create-task' requires build mode. Switch to build mode to use this command."
        );
    });

    it('treats a contribution without modes as available in both modes', () => {
        const r = makeRegistry();
        expect(r.resolve('/ask something', 'plan')?.contribution.command).toBe('ask');
        expect(r.resolve('/ask something', 'build')?.contribution.command).toBe('ask');
    });
});

describe('help', () => {
    it('lists mode-filtered commands including auto-provided /help', () => {
        const list = makeRegistry().listForMode('plan').map(c => c.command);
        expect(list).toContain('ask');
        expect(list).toContain('help');
        expect(list).not.toContain('create-task'); // build-only
    });

    it('/help resolves to a handler returning info text', async () => {
        const hit = makeRegistry().resolve('/help', 'build');
        const result = await hit!.contribution.handler!({}, noopCtx);
        expect(result.success).toBe(true);
        expect(result.info).toContain('/create-task');
        expect(result.info).toContain('Create a new task node');
    });
});
