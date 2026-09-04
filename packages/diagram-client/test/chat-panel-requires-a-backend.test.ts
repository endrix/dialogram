/**
 * The chat panel boots only when the host can answer it.
 *
 * `workflowFeaturesModule` binds the panel as an `IDiagramStartup`, so GLSP
 * instantiates it eagerly rather than on first use. With no chat backend behind
 * the diagram that meant the panel opened by itself, sent its first message to
 * a host with no handler registered for it, logged an unknown-method error, and
 * gave up five seconds later — leaving a chat button that could never answer.
 *
 * A consumer that composes the stock features without configuring chat is a
 * normal thing to be. That module's own header calls it the stock product's
 * feature set and says a custom-view consumer brings its own, so the absence of
 * a backend has to read as "no panel" rather than as a panel that fails.
 *
 * The flag is derived by the platform from `DiagramProfile.chat`, never
 * supplied by a product, so the two halves cannot disagree. Absent is treated
 * as present, which keeps a host that predates the flag behaving as it did.
 */

import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The module kicks off a WASM fetch as it loads. Nothing here is about that.
vi.mock('../src/libavoid-loader', () => ({ preloadLibavoid: () => Promise.resolve() }));

type Identifier = { clientBehavior?: { chatBackend?: boolean } };

function withBehavior(behavior: Identifier['clientBehavior']): void {
    (globalThis as { diagramIdentifier?: Identifier }).diagramIdentifier = {
        clientBehavior: behavior
    };
}

afterEach(() => {
    delete (globalThis as { diagramIdentifier?: Identifier }).diagramIdentifier;
    vi.resetModules();
});

/**
 * The class names this module binds, without booting a real GLSP container.
 *
 * The chain is a proxy returning itself for every call, so it satisfies each
 * builder shape the module uses — `toSelf().inSingletonScope()`, `toService`,
 * `rebind(...).to(...)` — and the GLSP helpers that wrap them, without this
 * test having to know which form each binding takes.
 */
async function boundServices(): Promise<string[]> {
    // Imported inside, after the identifier is set: the module reads the
    // behaviour while its callback runs, and vi.resetModules re-runs it.
    const { workflowFeaturesModule } = await import('../src/stock-features.module');
    const names: string[] = [];
    const record = (value: unknown): void => {
        const name = (value as { name?: string })?.name;
        if (typeof name === 'string' && name !== '') {
            names.push(name);
        }
    };
    const chain: unknown = new Proxy(() => chain, {
        get: () => chain,
        apply: (_t, _this, args: unknown[]) => {
            args.forEach(record);
            return chain;
        }
    });
    const bind = (token: unknown): unknown => {
        record(token);
        return chain;
    };
    // Positional, which is the shape inversify's ContainerModule callback takes.
    (
        workflowFeaturesModule as unknown as {
            registry: (b: unknown, u: unknown, i: unknown, r: unknown) => void;
        }
    ).registry(bind, () => undefined, () => true, bind);
    return names;
}

describe('the stock feature module', () => {
    it('binds the chat panel when the host has a backend', async () => {
        withBehavior({ chatBackend: true });
        expect(await boundServices()).toContain('ChatPanel');
    });

    it('treats an absent flag as a backend, so an older host is unaffected', async () => {
        withBehavior({});
        expect(await boundServices()).toContain('ChatPanel');
    });

    it('does not bind it when the host has none', async () => {
        withBehavior({ chatBackend: false });
        const bound = await boundServices();
        expect(bound).not.toContain('ChatPanel');
        // The rest of the feature set is untouched: this narrows one binding,
        // it does not disable the module.
        expect(bound).toContain('PropertyPanel');
        expect(bound).toContain('WorkflowNavigationUi');
    });
});
