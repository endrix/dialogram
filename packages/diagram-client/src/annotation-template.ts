/**
 * Annotation templates: the annotation wizard's contribution point.
 *
 * The wizard (the Annotations header's "Wizard…") adds or updates an
 * annotation from a template, or from a name and arguments typed in ("Custom
 * annotation…"). A template asks for what it needs and composes the
 * annotation's text. A product binds its templates in a feature module:
 *
 *     bind(AnnotationTemplate).toConstantValue(myTemplate);
 *
 * and passes the module to `startStockDiagram({ features })`. There is one
 * template per annotation name: a later binding for a name replaces the
 * earlier one, so a product's module, which loads after the stock one, can
 * replace a stock template. The wizard lists them in the order the names were
 * first bound, before its own "Custom annotation…" entry.
 */

export const AnnotationTemplate = Symbol.for('dialogram.AnnotationTemplate');

/** The wizard's own entry: a template of this name is ignored. */
export const CUSTOM_ANNOTATION_ENTRY = 'custom';

export interface AnnotationTemplate {
    /** The annotation the template writes, without the `@`. */
    readonly annotationName: string;
    /** The wizard's menu entry. */
    readonly label: string;
    readonly description?: string;
    /**
     * Ask for the template's arguments and compose the annotation's text, or
     * resolve to `undefined` when the person cancels.
     */
    compose(context: AnnotationTemplateContext): Promise<string | undefined>;
}

export interface AnnotationTemplateContext {
    /** The diagram element whose definition gets the annotation. */
    readonly elementId: string;
    /** The definition's annotation of this name, if it has one already. */
    readonly existing: {
        readonly name: string;
        readonly arguments?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    } | undefined;
}
