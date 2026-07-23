import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

export default defineConfig({
    resolve: {
        alias: {
            vscode: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'test/vscode-mock.ts'),
            '@dialogram/shared': path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../shared/src/index.ts')
        }
    },
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts']
    }
});
