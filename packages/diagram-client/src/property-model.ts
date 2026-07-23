/**
 * Typed view of the diagram model elements the properties panel renders.
 *
 * The panel historically passed elements around as `any`, reading args via stringy
 * keys with no compiler help. This is the first step of typing that surface: a
 * structural `PropertyElement` (a superset of the sprotty/GLSP element shape the
 * panel actually touches) plus small typed arg accessors. It is intentionally
 * permissive — `args` values stay `unknown` and are narrowed at the read site — so
 * methods can adopt it incrementally without a big-bang rewrite.
 */

/** Loosely-typed element args bag (keys like `wf:capacity`, `wf:from`, …). */
export type PropertyArgs = Record<string, unknown>;

/** The subset of a diagram element the properties panel reads. */
export interface PropertyElement {
    id: string;
    type: string;
    args?: PropertyArgs;
    sourceId?: string;
    targetId?: string;
    parent?: PropertyElement;
    children?: PropertyElement[];
}

/** Read a string arg, or undefined when absent/not a (non-empty) string. */
export function readStringArg(args: PropertyArgs | undefined, key: string): string | undefined {
    const value = args?.[key];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Read a finite-number arg, or undefined when absent/not a finite number. */
export function readNumberArg(args: PropertyArgs | undefined, key: string): number | undefined {
    const value = args?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Read a boolean arg (strict `=== true`). */
export function readBoolArg(args: PropertyArgs | undefined, key: string): boolean {
    return args?.[key] === true;
}
