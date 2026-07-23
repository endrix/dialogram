/**
 * Records the DI registrations performed by one or more `ContainerModule`s
 * WITHOUT constructing a real GLSP container (which cannot load headlessly — the
 * GLSP browser bundle imports `.css`). It runs each module's `registry`
 * callback against a fake inversify context and captures every `bind`/`rebind`
 * plus the `configure*`/`bindAsService` helper calls routed through the shared
 * `@eclipse-glsp/client` stub sink.
 *
 * This is the oracle for the container-parity test: the union of registrations
 * from the split neutral-base + stock modules must equal the union from the old
 * monolith (`workflowDiagramModule`). Comparison is order-insensitive within the
 * union (see `sortEntries`) because splitting one module into three inevitably
 * reorders the multi-bindings (e.g. IDiagramStartup) relative to each other; the
 * SET of bindings — which is what determines DI behaviour, each identifier being
 * bound exactly once and multi-listeners being independent — is preserved
 * exactly, and that is what this asserts.
 */
import type { ContainerModule } from 'inversify';
import { __setRegistrationSink, type RegistrationEntry } from './glsp-stub';

function nameOf(value: unknown): string {
    if (typeof value === 'function') {
        return (value as { name?: string }).name || 'anonymous';
    }
    if (typeof value === 'symbol') {
        return value.toString();
    }
    return String(value);
}

interface FakeBindingSyntax {
    to(target: unknown): FakeBindingSyntax;
    toSelf(): FakeBindingSyntax;
    toService(target: unknown): FakeBindingSyntax;
    toConstantValue(value: unknown): FakeBindingSyntax;
    toDynamicValue(): FakeBindingSyntax;
    inSingletonScope(): FakeBindingSyntax;
    inTransientScope(): FakeBindingSyntax;
    whenTargetNamed(): FakeBindingSyntax;
}

function makeRecordingContext(entries: RegistrationEntry[]): {
    bind: (id: unknown) => FakeBindingSyntax;
    unbind: () => void;
    isBound: () => boolean;
    rebind: (id: unknown) => FakeBindingSyntax;
} {
    const chain = (entry: RegistrationEntry): FakeBindingSyntax => {
        entries.push(entry);
        const syntax: FakeBindingSyntax = {
            to(target) {
                entry.to = nameOf(target);
                return syntax;
            },
            toSelf() {
                entry.to = 'self';
                return syntax;
            },
            toService(target) {
                entry.to = `service:${nameOf(target)}`;
                return syntax;
            },
            toConstantValue(value) {
                entry.to = `const:${nameOf(value)}`;
                return syntax;
            },
            toDynamicValue() {
                entry.to = 'dynamic';
                return syntax;
            },
            inSingletonScope() {
                entry.scope = 'singleton';
                return syntax;
            },
            inTransientScope() {
                entry.scope = 'transient';
                return syntax;
            },
            whenTargetNamed() {
                return syntax;
            }
        };
        return syntax;
    };
    return {
        bind: (id: unknown) => chain({ op: 'bind', id: nameOf(id) }),
        unbind: () => undefined,
        // The one `isBound` branch in the modules (ICopyPasteHandler) must resolve
        // identically for old and new — a fresh container has nothing bound.
        isBound: () => false,
        rebind: (id: unknown) => chain({ op: 'rebind', id: nameOf(id) })
    };
}

/**
 * Run each module's registry against a recording context and return the captured
 * registrations, sorted so the comparison is order-insensitive.
 */
export function recordModuleRegistrations(modules: ContainerModule[]): RegistrationEntry[] {
    const entries: RegistrationEntry[] = [];
    __setRegistrationSink(entry => entries.push(entry));
    try {
        const ctx = makeRecordingContext(entries);
        for (const module of modules) {
            const registry = (module as unknown as {
                registry: (
                    bind: unknown,
                    unbind: unknown,
                    isBound: unknown,
                    rebind: unknown
                ) => void;
            }).registry;
            registry(ctx.bind, ctx.unbind, ctx.isBound, ctx.rebind);
        }
    } finally {
        __setRegistrationSink(undefined);
    }
    return sortEntries(entries);
}

/** Stable, canonical ordering so parity is asserted on the SET, not the sequence. */
export function sortEntries(entries: RegistrationEntry[]): RegistrationEntry[] {
    return [...entries]
        .map(entry => JSON.stringify(entry, Object.keys(entry).sort()))
        .sort()
        .map(json => JSON.parse(json) as RegistrationEntry);
}
