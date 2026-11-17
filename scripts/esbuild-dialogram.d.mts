import type { BuildOptions, BuildResult, Plugin } from 'esbuild';

/** esbuild's `alias` for `@dialogram/<pkg>[/<subpath>]`: each `@dialogram/` package with a `src` folder, to it. */
export function dialogramAlias(packagesDir: string): Record<string, string>;

/**
 * `options` built the way the platform builds: the alias, the refusal of an unmapped, non-external
 * `@dialogram/` path after the build's own plugins, the decorator check first, and (unless
 * `inMemory`) the write last. `options.write` is refused.
 */
export function dialogramBuild(
    options: BuildOptions,
    platform: { packagesDir: string; relativeTo?: string; inMemory?: boolean; onWritten?: (result: BuildResult) => void | Promise<void> }
): BuildOptions & { write: false; alias: Record<string, string>; plugins: Plugin[] };

/** Refuses an import of a `@dialogram/` path `alias` does not map and the build does not keep external. */
export function dialogramPackagesOnly(alias: Record<string, string>): Plugin;

/** esbuild's helper for standard decorators, by its kind names, which survive `--minify`. */
export const STANDARD_DECORATOR_HELPER: RegExp;

/** The modules of a bundle's text compiled with standard decorators. */
export function standardDecoratorsIn(text: string): string[];

/** Fails a build whose code output has a module compiled with standard decorators; writes nothing. */
export function legacyDecoratorsOnly(options?: { relativeTo?: string; written?: boolean }): Plugin;

/** For a build with `write: false`, last among its plugins: writes the changed outputs of a build no `onEnd` failed, then calls `onWritten`. */
export function writeBundles(options?: { write?: boolean; relativeTo?: string; onWritten?: (result: BuildResult) => void | Promise<void> }): Plugin;

/** Ends a one-shot build of several bundles: sets the exit code for a failure, prints what esbuild did not. */
export function reportBuilds(results: PromiseSettledResult<unknown>[]): boolean;
