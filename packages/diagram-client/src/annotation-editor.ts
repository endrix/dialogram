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
 * and passes the module to `startStockDiagram({ features })`. There is one
 * editor per annotation name: a later binding for a name replaces the earlier
 * one, so a module that loads later can replace an editor an earlier one
 * bound (the stock diagram binds none). The section header's quick-add buttons follow the order in
 * which the names were first bound.
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
     * not parameters of the annotation. Save leaves them out of the text and
     * of `argUpdates`: `formatAnnotation` gets them in `args` but not in
     * `pairs`.
     */
    readonly guiOnlyArgs?: readonly string[];

    /**
     * Save sends what the card changed beside the text, so the server merges
     * it into the source annotation and keeps every other argument as the
     * source has it:
     * - `argUpdates`: the arguments set or edited since the card was drawn.
     *   The map is taken when `render` returns, so the defaults an editor
     *   fills in while drawing are not written unless changed; a value it
     *   sets later (after a pick, an answer, a timer) counts as changed.
     * - `argRemovals`: the arguments the producer gave that the card still
     *   showed with a value after drawing, and no longer has. An argument the
     *   editor takes out of the map while drawing is one it does not manage:
     *   Save never removes it, so an editor keeps in the map every argument
     *   it shows. Sent only when there is one, and passed on only to a
     *   producer that declares `features.mergeArgRemovals`; another keeps
     *   them, and says so.
     *
     * A Save that changed nothing sends nothing, and its button says so. A
     * save the editor makes while drawing compares with what was loaded.
     * Without it, Save replaces the annotation with the text.
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
     * `pairs` is its trimmed, non-empty entries in map order, without the
     * GUI-only ones. Without it, Save writes `@name(key=value, ...)` from
     * `pairs`.
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
