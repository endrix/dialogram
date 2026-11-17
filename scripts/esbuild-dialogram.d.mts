import type { Plugin } from 'esbuild';

/** esbuild's `alias` for `@dialogram/<pkg>[/<subpath>]`: each package with a `src` folder, to it. */
export function dialogramAlias(packagesDir: string): Record<string, string>;

/** esbuild's helper for standard decorators, by its kind names, which survive `--minify`. */
export const STANDARD_DECORATOR_HELPER: RegExp;

/** The modules of a bundle's text compiled with standard decorators. */
export function standardDecoratorsIn(text: string): string[];

/** For a build with `write: false`: writes outputs that keep legacy decorators, fails otherwise. */
export function writeLegacyDecoratorBundles(options?: { relativeTo?: string }): Plugin;
