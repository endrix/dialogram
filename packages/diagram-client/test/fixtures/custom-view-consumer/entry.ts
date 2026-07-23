/**
 * The external consumer's webview entry — the analog of mlir's `webview-app.ts`.
 *
 * It imports `createDiagramContainer` from the PACKAGE ROOT (`@dialogram/diagram-client`,
 * resolved via the workspace symlink → `src/index.ts`), exactly as a `file:` /
 * published-package consumer would, and composes it with a consumer feature
 * module. The consumer-build test bundles THIS file with esbuild (IIFE, browser,
 * jsx-factory=svg, fonts inlined) to prove the library builds inside a consumer's
 * own bundle. The IIFE is only built, never executed, so acquiring the VS Code
 * API / touching the DOM here is neither required nor done.
 */
import 'reflect-metadata';
import { createDiagramContainer } from '@dialogram/diagram-client';
import { customDemoModule } from './custom-module';

/** Build the container from the library base + the consumer's custom module. */
export function bootstrapConsumerDiagram(clientId: string): unknown {
    return createDiagramContainer({ clientId, features: [customDemoModule] });
}

// Reference the export so esbuild's tree-shaking keeps the whole graph in the
// bundle (the build assertion checks the emitted size / symbol presence).
(globalThis as { __consumerBootstrap?: unknown }).__consumerBootstrap = bootstrapConsumerDiagram;
