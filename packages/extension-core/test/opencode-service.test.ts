import { describe, it, expect, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  OpencodeServiceClient,
  opencodeApiRunner,
  probeOpencodeFlavour,
  type ApiResult,
} from '../src/extension/opencode-service.js';

/** A runner answering `opencode api` calls from a table of `METHOD path` keys. */
function fakeApi(answers: Record<string, ApiResult | ((args: string[]) => ApiResult)>) {
  const calls: string[][] = [];
  const run = vi.fn(async (args: string[]) => {
    calls.push(args);
    const answer = answers[`${args[0]} ${args[1]}`];
    if (!answer) return { code: 1, stdout: '', stderr: 'HTTP 404 Not Found' };
    return typeof answer === 'function' ? answer(args) : answer;
  });
  return { run, calls };
}

const json = (body: unknown): ApiResult => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });

describe('OpencodeServiceClient (opencode 2)', () => {
  it('lists the user messages oldest first, following the cursor to an empty page', async () => {
    const base = '/api/session/ses_1/message';
    const { run, calls } = fakeApi({
      [`GET ${base}?order=asc&type=user&limit=200`]: json({
        data: [
          { id: 'msg_1', type: 'user', text: '  first  ', time: { created: 1 } },
          { id: 'msg_2', type: 'user', text: '', files: [{ mime: 'image/png' }, { mime: 'text/plain' }, { mime: 'image/jpeg' }] },
        ],
        cursor: { previous: null, next: 'c1' },
      }),
      [`GET ${base}?type=user&limit=200&cursor=c1`]: json({
        data: [{ id: 'msg_3', type: 'user', text: 'third' }],
        cursor: { next: 'c2' },
      }),
      [`GET ${base}?type=user&limit=200&cursor=c2`]: json({ data: [], cursor: { next: null } }),
    });

    const messages = await new OpencodeServiceClient(run).listMessages('ses_1');

    expect(messages).toEqual([
      { id: 'msg_1', role: 'user', text: 'first' },
      { id: 'msg_2', role: 'user', text: '', images: 2 },
      { id: 'msg_3', role: 'user', text: 'third' },
    ]);
    expect(calls).toHaveLength(3);
  });

  it('stops on a page that repeats what it already listed, and skips other message types', async () => {
    const page = json({
      data: [
        { id: 'msg_1', type: 'user', text: 'a' },
        { id: 'msg_x', type: 'synthetic', text: '<system-update>' },
      ],
      cursor: { next: 'again' },
    });
    const { run, calls } = fakeApi({
      'GET /api/session/ses_1/message?order=asc&type=user&limit=200': page,
      'GET /api/session/ses_1/message?type=user&limit=200&cursor=again': page,
    });

    const messages = await new OpencodeServiceClient(run).listMessages('ses_1');

    expect(messages).toEqual([{ id: 'msg_1', role: 'user', text: 'a' }]);
    expect(calls).toHaveLength(2);
  });

  it('reverts by staging the revert, and unreverts by clearing it', async () => {
    const { run, calls } = fakeApi({
      'POST /api/session/ses_1/revert/stage': json({ data: { messageID: 'msg_2' } }),
      'DELETE /api/session/ses_1/revert': { code: 0, stdout: '', stderr: '' },
    });
    const client = new OpencodeServiceClient(run);

    await client.revert('ses_1', 'msg_2');
    await client.unrevert('ses_1');

    expect(calls).toEqual([
      ['POST', '/api/session/ses_1/revert/stage', '--data', JSON.stringify({ messageID: 'msg_2' })],
      ['DELETE', '/api/session/ses_1/revert'],
    ]);
  });

  it('reads the reverted state from the session, and an unreadable session as not reverted', async () => {
    const { run } = fakeApi({
      'GET /api/session/ses_r': json({ data: { id: 'ses_r', revert: { messageID: 'msg_2' } } }),
      'GET /api/session/ses_n': json({ data: { id: 'ses_n' } }),
    });
    const client = new OpencodeServiceClient(run);

    await expect(client.isReverted('ses_r')).resolves.toBe(true);
    await expect(client.isReverted('ses_n')).resolves.toBe(false);
    await expect(client.isReverted('ses_gone')).resolves.toBe(false);
  });

  it('a refused call says what opencode answered', async () => {
    const { run } = fakeApi({});
    await expect(new OpencodeServiceClient(run).revert('ses_1', 'msg_1')).rejects.toThrow(
      'opencode api POST /api/session/ses_1/revert/stage -> HTTP 404 Not Found',
    );
  });

  it('session ids are encoded into the path', async () => {
    const { run, calls } = fakeApi({});
    await new OpencodeServiceClient(run).unrevert('a/b').catch(() => undefined);
    expect(calls[0][1]).toBe('/api/session/a%2Fb/revert');
  });
});

describe('the opencode flavour and api runner, with a stand-in binary', () => {
  async function withBinary(script: string, test: (bin: string) => Promise<void>) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dialogram-opencode-'));
    const bin = path.join(dir, 'opencode');
    await writeFile(bin, `#!/bin/sh\n${script}\n`);
    await chmod(bin, 0o755);
    try {
      await test(bin);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('an acp whose help offers --port is 1.x; one whose help does not is 2', async () => {
    await withBinary('echo "  --port      port to listen on"', async (bin) => {
      await expect(probeOpencodeFlavour(bin, ['acp'], process.env)).resolves.toBe('own-port');
    });
    await withBinary('echo "  --login    Run auth login instead of starting the server"', async (bin) => {
      await expect(probeOpencodeFlavour(bin, ['acp'], process.env)).resolves.toBe('service');
    });
  });

  it('a help that cannot be read counts as 2, so the chat starts without the flags', async () => {
    await expect(probeOpencodeFlavour('/nonexistent/opencode', ['acp'], process.env)).resolves.toBe('service');
  });

  it('runs `opencode api` with its arguments and reports a failure with its stderr', async () => {
    await withBinary('if [ "$2" = "GET" ]; then echo "{\\"args\\": \\"$*\\"}"; else echo "HTTP 409 Conflict" >&2; exit 1; fi', async (bin) => {
      const run = opencodeApiRunner(bin, process.env);
      const ok = await run(['GET', '/api/session/x']);
      expect(ok.code).toBe(0);
      expect(JSON.parse(ok.stdout)).toEqual({ args: 'api GET /api/session/x' });
      const refused = await run(['POST', '/api/session/x/revert/stage']);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr.trim()).toBe('HTTP 409 Conflict');
    });
  });
});
