/**
 * The GLSP-MCP usage hint reaches the ASSEMBLED session context. The chat
 * runtime supplies a per-file hint provider; the ACP client folds its result
 * into the once-per-session workflow context blocks. When the provider returns
 * text the assembled context carries it; when it returns undefined nothing leaks.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('@agentclientprotocol/sdk', () => ({
    ClientSideConnection: vi.fn(),
    ndJsonStream: vi.fn()
}));
vi.mock('node:fs/promises', () => ({
    stat: vi.fn(async () => ({ mtimeMs: 1 })),
    readFile: vi.fn(async () => 'x = 1'),
    writeFile: vi.fn(),
    mkdir: vi.fn()
}));

import { ACPClientService } from '../src/extension/acp-client.js';

const SENTINEL = 'GLSP-HINT-SENTINEL query-elements';

function seed(client: ACPClientService): void {
    (client as any).sessions.set('s1', { id: 's1', workflowFile: '/tmp/a.py' });
}

async function assembledText(client: ACPClientService): Promise<string> {
    const blocks: any[] = await (client as any).buildWorkflowContextBlocks('s1');
    return blocks
        .filter(b => b?.type === 'text')
        .map(b => b.text)
        .join('\n');
}

describe('buildWorkflowContextBlocks GLSP hint', () => {
    it('includes the hint text when the hint provider returns one', async () => {
        const client = new ACPClientService();
        client.setGlspToolHintProvider(() => SENTINEL);
        seed(client);
        expect(await assembledText(client)).toContain(SENTINEL);
    });

    it('omits any hint when the provider returns undefined', async () => {
        const client = new ACPClientService();
        client.setGlspToolHintProvider(() => undefined);
        seed(client);
        expect(await assembledText(client)).not.toContain('GLSP-HINT-SENTINEL');
    });
});
