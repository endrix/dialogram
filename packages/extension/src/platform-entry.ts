/**
 * Entry point for the platform bundle (`dist/platform.cjs`).
 *
 * This bundle is the ONE realm that owns the diagram runtime: extension-core's
 * GLSP server + chat backend AND the sidecar-toolkit's profile assembly. Both
 * are compiled together by a single esbuild pass, so they share ONE copy of
 * inversify, ONE set of DI Symbol identities and ONE reflect-metadata store.
 *
 * WHY THE TOOLKIT LIVES HERE (the cross-bundle DI identity fix): the toolkit's
 * `createSidecarDiagramProfile` constructs inversify `ContainerModule`s and
 * DI-decorated operation-handler classes. Those objects are resolved by the
 * platform's GLSP container, which also lives in this bundle. If a consumer
 * shell assembled the profile inside ITS OWN bundle instead, the handler classes
 * would carry injection metadata registered against a DIFFERENT inversify/Symbol
 * realm; resolved here they would have no metadata and their `@inject`ed
 * `sidecar` would be undefined — exactly the production `TypeError` at
 * `operationType`. Assembling the profile through this entry keeps every
 * DI-decorated class in the same realm as the container that resolves it.
 *
 * `packages/extension/src` is the SHELL of the Dialogram host extension, so it
 * is permitted to import the toolkit (the neutrality gates cover the neutral
 * core packages, not this shell). The toolkit itself is product-token-free.
 */
export * from '@dialogram/extension-core';
export { createSidecarDiagramProfile } from '@dialogram/sidecar-toolkit';
