import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

export default defineConfig({
    resolve: {
        alias: {
            vscode: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'test/vscode-mock.ts'),
            '@dialogram/shared': path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../shared/src/index.ts'),
            // Map to the src DIRECTORY (not index.ts) so deep subpath imports like
            // '@dialogram/diagram-server/server/graph-load-request-options' resolve to the neutral
            // modules directly, skipping the GLSP server barrel (which loads vscode-integration/node
            // and would fail collection under vitest).
            '@dialogram/diagram-server': path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../diagram-server/src'),
            '@dialogram/extension-core': path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension-core/src/index.ts')
        }
    },
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts']
    }
});
