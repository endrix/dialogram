import { describe, it, expect } from 'vitest';
import { OPENCODE_CONFIG_CONTENT, withOpencodeCodeModeOff } from '../src/extension/opencode-code-mode.js';

const config = (env: NodeJS.ProcessEnv) => JSON.parse(env[OPENCODE_CONFIG_CONTENT]!);

describe("opencode 2's Code Mode, off for the chat", () => {
  it('denies execute in a config of its own when the environment has none', () => {
    const env = { PATH: '/bin' };
    const result = withOpencodeCodeModeOff(env);
    expect(result.outcome).toBe('off');
    expect(config(result.env)).toEqual({ permission: { execute: 'deny' } });
    expect(result.env.PATH).toBe('/bin');
    // The environment given is not changed.
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('treats an empty value as none', () => {
    const result = withOpencodeCodeModeOff({ [OPENCODE_CONFIG_CONTENT]: '  ' });
    expect(result.outcome).toBe('off');
    expect(config(result.env)).toEqual({ permission: { execute: 'deny' } });
  });

  it("adds execute to the user's own config, keeping the rest of it, the deny last", () => {
    const own = { model: 'm/x', permission: { '*': 'allow', bash: 'ask' }, mcp: { s: { type: 'remote', url: 'u' } } };
    const result = withOpencodeCodeModeOff({ [OPENCODE_CONFIG_CONTENT]: JSON.stringify(own) });
    expect(result.outcome).toBe('off');
    const next = config(result.env);
    expect(next).toEqual({ ...own, permission: { '*': 'allow', bash: 'ask', execute: 'deny' } });
    // opencode reads a permission's rules in order, the last that matches deciding.
    expect(Object.keys(next.permission)).toEqual(['*', 'bash', 'execute']);
  });

  it("adds a permission to a user's config that has none", () => {
    const result = withOpencodeCodeModeOff({ [OPENCODE_CONFIG_CONTENT]: '{"model":"m/x"}' });
    expect(config(result.env)).toEqual({ model: 'm/x', permission: { execute: 'deny' } });
  });

  it("keeps the user's own permission.execute, whatever it says", () => {
    for (const execute of ['allow', 'ask', 'deny', { '*': 'allow' }]) {
      const text = JSON.stringify({ permission: { execute } });
      const env = { [OPENCODE_CONFIG_CONTENT]: text };
      const result = withOpencodeCodeModeOff(env);
      expect(result.outcome).toBe('user-says');
      expect(result.env).toBe(env);
      expect(result.env[OPENCODE_CONFIG_CONTENT]).toBe(text);
    }
  });

  it('leaves a value that does not parse as JSON as it is, and says so in one line', () => {
    const jsonc = '{\n  // mine\n  "permission": { "bash": "ask" },\n}';
    const env = { [OPENCODE_CONFIG_CONTENT]: jsonc };
    const result = withOpencodeCodeModeOff(env);
    expect(result.outcome).toBe('left-as-is');
    expect(result.env).toBe(env);
    expect(result.env[OPENCODE_CONFIG_CONTENT]).toBe(jsonc);
    expect(result.note).toContain(OPENCODE_CONFIG_CONTENT);
    expect(result.note).not.toContain('\n');
  });

  it('leaves a value that is not an object, or whose permission is one rule for every tool, as it is', () => {
    for (const text of ['[1]', '"allow"', 'null', '{"permission":"allow"}', '{"permission":["x"]}']) {
      const env = { [OPENCODE_CONFIG_CONTENT]: text };
      const result = withOpencodeCodeModeOff(env);
      expect(result.outcome).toBe('left-as-is');
      expect(result.env).toBe(env);
    }
  });
});
