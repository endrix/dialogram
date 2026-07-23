import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            vscode: path.resolve(__dirname, 'test/vscode-mock.ts'),
            '@dialogram/shared': path.resolve(__dirname, '../shared/src/index.ts'),
            // Map to the src DIRECTORY so deep subpath imports (e.g. the toolkit's
            // '@dialogram/diagram-server/server/graph-load-request-options') resolve while the bare
            // specifier still resolves to src/index.ts.
            '@dialogram/diagram-server': path.resolve(__dirname, '../diagram-server/src'),
            '@dialogram/diagram-client': path.resolve(__dirname, '../diagram-client/src/index.ts'),
            '@dialogram/extension-core': path.resolve(__dirname, 'src/index.ts')
        }
    },
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
        },
    }
});
