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
            // Before the bare package: the extension's entry (`packages/extension/src/main.ts`)
            // imports the API contract by this subpath, and a test goes through that entry.
            '@dialogram/extension-core/api': path.resolve(__dirname, 'src/api.ts'),
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
