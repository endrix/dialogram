/**
 * One request in, one answer out, and every way a sidecar can fail described
 * the same way wherever it was asked from.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const child = vi.hoisted(() => ({
    runChildProcess: vi.fn(),
    describeChildFailure: vi.fn()
}));
vi.mock('../src/run-child-process.js', () => child);

import { invokeSidecar } from '../src/sidecar-transport.js';

const REQUEST = { command: 'x-sidecar', file: '/ws/flow.py', op: 'x.createNode', args: { name: 'n' } };

function answers(stdout: string, extra: Record<string, unknown> = {}) {
    child.runChildProcess.mockResolvedValue({ code: 0, stdout, stderr: '', timedOut: false, spawnError: undefined, ...extra });
    child.describeChildFailure.mockReturnValue(extra.failure);
}

afterEach(() => {
    vi.clearAllMocks();
});

describe('invokeSidecar', () => {
    it('writes the request as one JSON line and reads the answer', async () => {
        answers('{"status":"ok","diagnostic":{"graph":{}}}\n');
        const result = await invokeSidecar(REQUEST);
        expect(result).toEqual({ ok: true, response: { status: 'ok', diagnostic: { graph: {} } } });
        const [command, args, options] = child.runChildProcess.mock.calls[0];
        expect(command).toBe('x-sidecar');
        expect(args).toEqual([]);
        expect(options.input).toBe(JSON.stringify({ file: '/ws/flow.py', op: 'x.createNode', args: { name: 'n' } }) + '\n');
        // From the file's package root (its directory, outside any package), first on PYTHONPATH.
        expect(options.cwd).toBe('/ws');
        expect(String(options.env.PYTHONPATH).startsWith('/ws')).toBe(true);
    });

    it('reads a pretty-printed answer whole, and the last line when a sidecar logs above its answer', async () => {
        answers('{\n  "status": "ok",\n  "diagnostic": {}\n}\n');
        expect((await invokeSidecar(REQUEST)).response).toEqual({ status: 'ok', diagnostic: {} });
        answers('loading plugins...\n{"status":"ok"}\n');
        expect((await invokeSidecar(REQUEST)).ok).toBe(true);
    });

    it('takes no answer as success and a rejected request as the sidecar said it', async () => {
        answers('');
        expect(await invokeSidecar(REQUEST)).toEqual({ ok: true });
        answers('{"status":"error","message":"name taken","diagnostic":{"code":"name_exists"}}');
        expect(await invokeSidecar(REQUEST)).toMatchObject({ ok: false, failure: 'rejected', message: 'name taken', code: 'name_exists' });
        answers('{"status":"error"}');
        expect((await invokeSidecar(REQUEST)).message).toBe('Sidecar rejected x.createNode.');
        answers('not json');
        expect(await invokeSidecar(REQUEST)).toMatchObject({ failure: 'invalid-json', message: 'Sidecar returned invalid JSON while handling x.createNode.' });
    });

    it('describes a child that failed as the child-process module does, with the op, and says when it timed out', async () => {
        answers('', { code: 2, stderr: 'Traceback: boom\n', failure: 'x-sidecar: Traceback: boom' });
        expect(await invokeSidecar(REQUEST)).toEqual({
            ok: false,
            failure: 'exit',
            message: 'x-sidecar: Traceback: boom (while handling x.createNode)',
            stderr: 'Traceback: boom',
            timedOut: false
        });
        answers('', { code: null, timedOut: true, failure: 'x-sidecar: no response after 60s' });
        expect(await invokeSidecar(REQUEST)).toMatchObject({ ok: false, failure: 'timeout', message: 'x-sidecar: no response after 60s (while handling x.createNode)', timedOut: true });
        answers('', { code: null, spawnError: new Error('ENOENT'), failure: 'x-sidecar: failed to start: ENOENT' });
        expect(await invokeSidecar(REQUEST)).toMatchObject({ failure: 'start', message: 'x-sidecar: failed to start: ENOENT (while handling x.createNode)' });
    });

    it('passes the deadline through, and never throws', async () => {
        answers('{"status":"ok"}');
        await invokeSidecar({ ...REQUEST, timeoutMs: 20_000 });
        expect(child.runChildProcess.mock.calls[0][2].timeoutMs).toBe(20_000);
        child.runChildProcess.mockRejectedValue(new Error('spawn exploded'));
        expect(await invokeSidecar(REQUEST)).toEqual({ ok: false, failure: 'start', message: 'spawn exploded' });
    });
});
