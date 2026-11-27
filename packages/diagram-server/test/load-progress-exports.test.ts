/**
 * What a product with a model storage of its own imports from the package to
 * take part in the session's loads: the signal that says nobody waits any
 * more, the dispatcher that raises it, and the reporter that tells the
 * diagram what the load is doing and when the wait is over.
 *
 * The barrel itself is read as text: importing it loads the VS Code server
 * integration, which needs the `vscode` module a test does not have.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as cancellation from '../src/server/load-cancellation';
import * as dispatcher from '../src/server/load-cancelling-dispatcher';
import * as progress from '../src/server/load-progress';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server');

describe('the package, for a product’s own model storage', () => {
    it('re-exports the load cancellation, its dispatcher and the load-progress reporter', () => {
        const barrel = readFileSync(path.join(SERVER, 'index.ts'), 'utf8');
        for (const module of ['./load-cancellation', './load-cancelling-dispatcher', './load-progress']) {
            expect(barrel).toContain(`export * from '${module}';`);
        }
        expect(readFileSync(path.join(SERVER, '../index.ts'), 'utf8')).toContain("export * from './server/index';");
    });

    it('has the names a storage uses in those modules', () => {
        const exported: Record<string, unknown> = { ...cancellation, ...dispatcher, ...progress };
        for (const name of [
            'LoadCancellation', 'LoadAbandoned', 'isLoadAbandoned', 'LoadCancellingActionDispatcher',
            'LoadProgressReporter', 'LOAD_PROGRESS_SINK', 'LOAD_PHASE_WORDS', 'isBackgroundLoad', 'counted', 'tellLoading'
        ]) {
            expect(exported[name], name).toBeDefined();
        }
    });
});
