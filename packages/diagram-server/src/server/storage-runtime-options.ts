import type { EntityPaletteItemSpec, NodeFamilySpec } from '@dialogram/shared';
/**
 * Neutral runtime options the source-model storage (and tool palette) need.
 *
 * These are the only product-shaped values core still reads directly: the VS Code settings
 * namespace to look configuration up under, and the operation-prefix string carried to the client
 * on the graph model (so the client can tell which language runtime produced the diagram). Both are
 * supplied as plain data by the consuming extension — core hardcodes NO product literals.
 */
export interface StorageRuntimeOptions {
    /** VS Code settings namespace (e.g. the `xxxLang` configuration section). */
    settingsNamespace: string;
    /** Operation-prefix identifier surfaced to the client on the graph model root args. */
    operationPrefix: string;
    /**
     * Selects the alternate entity-palette layout (a reduced entity vocabulary) instead of the
     * default one. Supplied by the consuming extension; core hardcodes no product discriminator.
     */
    useAlternateEntityPalette?: boolean;
    /**
     * Extra entries for the Entities palette, contributed by the product.
     *
     * Plain data on purpose. The two lists above are the platform's own, and a
     * product cannot add to them without editing that file — which is how a
     * neutral platform ends up learning every product's vocabulary. A profile
     * describes an entry instead, and the platform builds it.
     */
    entityPaletteItems?: EntityPaletteItemSpec[];
    /**
     * The node families the product recognises — see `NodeFamilySpec`.
     * The class is derived from each annotation, so core names none.
     */
    nodeFamilies?: NodeFamilySpec[];
}

export const STORAGE_RUNTIME_OPTIONS = Symbol('StorageRuntimeOptions');
