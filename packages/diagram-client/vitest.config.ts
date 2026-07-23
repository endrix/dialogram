import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            '@dialogram/shared': path.resolve(__dirname, '../shared/src/index.ts'),
            // GLSP's browser bundle imports `.css` at load and cannot be required
            // under node; the handler logic under test uses none of its runtime
            // values, so alias to a minimal stub for the node test run.
            '@eclipse-glsp/client': path.resolve(__dirname, 'test/glsp-stub.ts'),
            '@eclipse-glsp/sprotty': path.resolve(__dirname, 'test/glsp-stub.ts')
        }
    },
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts']
    }
});
