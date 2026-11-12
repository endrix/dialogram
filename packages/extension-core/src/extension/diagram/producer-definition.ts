/**
 * "Go to definition" on a diagram element whose producer named the definition.
 *
 * An element's navigation target is, by default, where it is written in the
 * file on screen, and the host asks the language tooling to find the
 * definition from there. A producer that resolved the name itself (a runtime
 * that imported the module, a compiler that elaborated the design) marks its
 * target as the definition (`REFERENCED_IS_DEFINITION`, sent on as
 * `wf:navigateTargetIsDefinition`). That answer is the interpreter's own; the
 * language tooling may be configured for another interpreter or other import
 * roots, and can name a different declaration of the same name without any
 * sign that it did. So the producer's target is opened as it is.
 */

/** The target is the definition itself, named by the producer. */
export const NAVIGATE_TARGET_IS_DEFINITION_ARG = 'wf:navigateTargetIsDefinition';

/**
 * Whether the target is the producer's own definition and can be opened: so
 * nothing else is asked. A file that is gone is not one (the diagram may be
 * older than the file system), and asking is then all that is left.
 */
export async function producerNamedDefinition<U extends { scheme: string }>(
    args: Record<string, unknown> | undefined,
    target: U,
    stat: (uri: U) => PromiseLike<unknown>
): Promise<boolean> {
    if (args?.[NAVIGATE_TARGET_IS_DEFINITION_ARG] !== true) {
        return false;
    }
    if (target.scheme !== 'file') {
        return true;
    }
    try {
        await stat(target);
        return true;
    } catch {
        return false;
    }
}
