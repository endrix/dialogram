/**
 * DI token for the neutral {@link DiagramModelSource} binding.
 *
 * The concrete model source now lives in the language toolkit package; core only knows the
 * neutral interface and this token. Storage resolves the bound model source through it (see
 * `source-model-storage.ts`); `server-module.ts` binds it from a consumer-supplied factory.
 */
export const DIAGRAM_MODEL_SOURCE = Symbol('DIAGRAM_MODEL_SOURCE');
