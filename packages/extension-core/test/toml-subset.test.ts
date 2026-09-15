// The TOML a connectors file uses, read without a dependency: what wfpy's
// documented example and a few plausible variations contain.
import { describe, expect, it } from 'vitest';
import { parseTomlSubset } from '../src/extension/chat/toml-subset';

describe('parseTomlSubset', () => {
    it("reads wfpy's documented connectors file", () => {
        const text = `
# the agents
[connectors.claude]
command = "claude-agent-acp"      # argv, split as a shell would
model = "sonnet"                  # a session config option the agent offers
mode = "acceptEdits"              # a session mode the agent offers
http_api = false                  # OpenCode's HTTP API beside ACP

[connectors.opencode]
command = "/opt/opencode/bin/opencode acp"
`;
        expect(parseTomlSubset(text)).toEqual({
            connectors: {
                claude: { command: 'claude-agent-acp', model: 'sonnet', mode: 'acceptEdits', http_api: false },
                opencode: { command: '/opt/opencode/bin/opencode acp' }
            }
        });
    });

    it('reads env as a sub-table or an inline table, quoted keys, arrays, numbers, escapes and literal strings', () => {
        const text = `
[connectors."my agent"]
command = 'my-acp --flag'
env = { API_KEY = "k", "X.Y" = "v" }
timeout = 1_000
ratio = 1.5
tags = ["a", "b",
  "c"]

[connectors.other]
command = "other \\"quoted\\" \\\\ end"

[connectors.other.env]
HOME = "/h"
`;
        expect(parseTomlSubset(text)).toEqual({
            connectors: {
                'my agent': { command: 'my-acp --flag', env: { API_KEY: 'k', 'X.Y': 'v' }, timeout: 1000, ratio: 1.5, tags: ['a', 'b', 'c'] },
                other: { command: 'other "quoted" \\ end', env: { HOME: '/h' } }
            }
        });
    });

    it('reads dotted keys and multi-line strings', () => {
        expect(parseTomlSubset('connectors.x.command = "c"\nnote = """\nline\\\n  joined"""')).toEqual({
            connectors: { x: { command: 'c' } },
            note: 'linejoined'
        });
    });

    it('says what is wrong, with the line', () => {
        expect(() => parseTomlSubset('[connectors.a]\ncommand = "unterminated')).toThrow(/line 2: unterminated string/);
        expect(() => parseTomlSubset('a = 1\na = 2')).toThrow(/line 2: 'a' is defined twice/);
        expect(() => parseTomlSubset('[[connectors]]')).toThrow(/array of tables/);
        expect(() => parseTomlSubset('a = "x" b = 1')).toThrow(/line 1: unexpected 'b'/);
    });
});
