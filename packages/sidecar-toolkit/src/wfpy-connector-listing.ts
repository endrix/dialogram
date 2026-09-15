/**
 * The connector listing for a product whose CLI is not wfpy: wfpy knows the
 * ACP connectors (`wfpy connectors --json`), and in this project every
 * product's CLI lives in the same venv as wfpy, so wfpy beside the product's
 * resolved CLI is the listing command, and wfpy on the PATH the fallback.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';

export interface ConnectorListing {
    cmd: string;
    args: string[];
}

/** `wfpy connectors --json --workspace <dir>`, wfpy taken from beside `cliCommand`
 *  when it names a path whose directory holds one, else from the PATH. */
export function wfpyConnectorListing(cliCommand: string, workspaceDir: string, exists: (p: string) => boolean = existsSync): ConnectorListing {
    const args = ['connectors', '--json', '--workspace', workspaceDir];
    const trimmed = cliCommand.trim();
    if (trimmed.includes('/') || trimmed.includes('\\')) {
        const sibling = path.join(path.dirname(trimmed), process.platform === 'win32' ? 'wfpy.exe' : 'wfpy');
        if (exists(sibling)) {
            return { cmd: sibling, args };
        }
    }
    return { cmd: 'wfpy', args };
}
