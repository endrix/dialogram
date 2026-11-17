import type { BuildOptions, Plugin } from 'esbuild';

/** esbuild's `alias` for `@dialogram/<pkg>[/<subpath>]`: each package with a `src` folder, to it. */
export function dialogramAlias(packagesDir: string): Record<string, string>;

/**
 * `options` built the way the platform builds: the alias, the refusal of an unmapped `@dialogram/`
 * path after the build's own plugins, and (unless `inMemory`) the writer first among them.
 */
export function dialogramBuild(
    options: BuildOptions,
    platform: { packagesDir: string; relativeTo?: string; inMemory?: boolean }
): BuildOptions & { write: false; plugins: Plugin[] };

/** Refuses an import of a `@dialogram/` path `alias` does not map, rather than resolve it elsewhere. */
export function dialogramPackagesOnly(alias: Record<string, string>): Plugin;

/** esbuild's helper for standard decorators, by its kind names, which survive `--minify`. */
export const STANDARD_DECORATOR_HELPER: RegExp;

/** The modules of a bundle's text compiled with standard decorators. */
export function standardDecoratorsIn(text: string): string[];

/** For a build with `write: false`: writes outputs that keep legacy decorators, fails otherwise. */
export function writeLegacyDecoratorBundles(options?: { relativeTo?: string }): Plugin;
