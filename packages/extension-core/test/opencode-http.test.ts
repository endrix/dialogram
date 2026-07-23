import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpencodeHttpClient } from '../src/extension/opencode-http.js';

describe('OpencodeHttpClient', () => {
  const base = 'http://127.0.0.1:9999';
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ok = (body: unknown) =>
    ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;

  it('revert posts messageID as JSON to the revert route', async () => {
    fetchMock.mockResolvedValue(ok({}));
    const client = new OpencodeHttpClient(base);

    await client.revert('ses_1', 'msg_abc');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${base}/session/ses_1/revert`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ messageID: 'msg_abc' });
  });

  it('unrevert posts to the unrevert route with no body', async () => {
    fetchMock.mockResolvedValue(ok({}));
    const client = new OpencodeHttpClient(base);

    await client.unrevert('ses_1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${base}/session/ses_1/unrevert`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('listMessages flattens info + concatenated text parts', async () => {
    fetchMock.mockResolvedValue(
      ok([
        { info: { id: 'msg_1', role: 'user' }, parts: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] },
        { info: { id: 'msg_2', role: 'assistant' }, parts: [{ type: 'tool', text: 'ignored' }, { type: 'text', text: 'hi' }] },
        { info: null, parts: [] },
      ])
    );
    const client = new OpencodeHttpClient(base);

    const messages = await client.listMessages('ses_1');

    expect(messages).toEqual([
      { id: 'msg_1', role: 'user', text: 'hello world' },
      { id: 'msg_2', role: 'assistant', text: 'hi' },
    ]);
  });

  it('isReverted reflects the session revert marker', async () => {
    const client = new OpencodeHttpClient(base);

    fetchMock.mockResolvedValueOnce(ok({ id: 'ses_1', revert: { messageID: 'msg_1' } }));
    expect(await client.isReverted('ses_1')).toBe(true);

    fetchMock.mockResolvedValueOnce(ok({ id: 'ses_1' }));
    expect(await client.isReverted('ses_1')).toBe(false);
  });
});
