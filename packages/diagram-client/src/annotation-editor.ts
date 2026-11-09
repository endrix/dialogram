/**
 * Annotation editors: the property panel's contribution point for one
 * annotation's card.
 *
 * The panel draws a card for every annotation on the referenced definition: a
 * title, Save and Remove, and one free key/value row per argument. An editor
 * contributed for an annotation's name adds its own controls to that card, owns
 * the arguments it shows, and writes the annotation text on Save. A product
 * binds its editors in a feature module:
 *
 *     bind(AnnotationEditor).toConstantValue(myEditor);
 *
 * and passes the module to `startStockDiagram({ features })`. Editors bound
 * earlier come first, in the card and in the section header's quick-add
 * buttons.
 */
import type { IActionDispatcher } from '@eclipse-glsp/client';
import type { PropertyElement } from './property-model';

export const AnnotationEditor = Symbol.for('dialogram.AnnotationEditor');

export interface AnnotationEditor {
    /** The annotation this editor owns, without the `@`: `'agent'` edits `@agent(...)`. */
    readonly annotationName: string;

    /**
     * Arguments the editor shows with its own controls. The card's free
     * key/value rows skip them.
     */
    readonly reservedArgs: readonly string[];

    /**
     * Arguments the editor keeps in the card's map for its own state that are
     * not parameters of the annotation. Save leaves them out of `argUpdates`;
     * `formatAnnotation` decides whether the text carries them.
     */
    readonly guiOnlyArgs?: readonly string[];

    /**
     * Save sends the edited arguments as `argUpdates` beside the text, so the
     * server merges them into the source annotation and keeps the arguments
     * the editor does not manage. Without it, Save replaces the annotation
     * with the text.
     */
    readonly mergeArgUpdates?: boolean;

    /** A button in the Annotations header that adds this annotation from a template. */
    readonly quickAdd?: {
        readonly label: string;
        readonly title: string;
        readonly annotationText: string;
    };

    /**
     * The annotation text Save writes. `args` is the card's map as edited;
     * `pairs` is its trimmed, non-empty entries in map order. Without it,
     * Save writes `@name(key=value, ...)` from `pairs`.
     */
    formatAnnotation?(args: ReadonlyMap<string, string>, pairs: ReadonlyArray<readonly [string, string]>): string;

    /** Add the editor's controls to the card body. */
    render(context: AnnotationEditorContext): void;
}

export interface AnnotationEditorContext {
    /** The diagram element whose definition carries the annotation. */
    readonly elementId: string;
    /** The card's arguments. Save reads this map: an editor writes its edits here. */
    readonly args: Map<string, string>;
    /** The card body; the editor appends its controls, the card's free rows follow them. */
    readonly body: HTMLElement;
    readonly dispatcher: IActionDispatcher;
    /** The diagram's current model root, to look up `elementId` and its ports. */
    readonly root: { readonly index?: { getById(id: string): PropertyElement | undefined } } | undefined;
    /**
     * Whether the editor may ask the server to discover what it offers (it
     * may not when the panel redraws because a discovery answered).
     */
    readonly requestDiscovery: boolean;
    /** Click the card's Save. */
    save(): void;
}
