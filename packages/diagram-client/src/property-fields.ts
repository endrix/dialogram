/**
 * Typed lit-html building blocks for the properties panel.
 *
 * This is the first piece of the panel's "strangler" refactor: instead of every
 * section hand-building DOM with `document.createElement` (and reinventing field
 * markup + commit semantics each time), sections compose these small, typed,
 * declarative helpers. Behaviour (validation, Enter/Escape, clear) lives here
 * once; callers supply data + callbacks only.
 *
 * Helpers return `TemplateResult` so they drop straight into `litSection({ body })`.
 * They own their classes (`pp-field`, `pp-num-*`); styles are colocated in
 * diagram-client.css under "Property panel — field toolkit".
 */
import { html, noChange, nothing, type TemplateResult } from 'lit';
import { createRef, ref, type Ref } from 'lit/directives/ref.js';
import { directive, Directive, PartType, type PartInfo, type ElementPart } from 'lit/directive.js';

const NO_KEY = Symbol('renderInto-no-key');

/**
 * Element directive that imperatively populates an element via `populate(el)`,
 * re-running only when `key` changes. Bridges existing imperative DOM builders
 * (e.g. the agent message-content renderer) into a lit template: on each render
 * lit keeps the element, and we only rebuild its contents when the keyed data
 * actually changed — so a streaming update only re-renders the one message whose
 * content grew, not the whole list.
 */
class RenderIntoDirective extends Directive {
    private _key: unknown = NO_KEY;

    constructor(partInfo: PartInfo) {
        super(partInfo);
        if (partInfo.type !== PartType.ELEMENT) {
            throw new Error('renderInto can only be used on an element binding');
        }
    }

    render(_populate: (el: HTMLElement) => void, _key: unknown): typeof nothing {
        return nothing;
    }

    update(part: ElementPart, [populate, key]: [(el: HTMLElement) => void, unknown]): typeof noChange {
        if (key !== this._key) {
            this._key = key;
            const el = part.element as HTMLElement;
            el.replaceChildren();
            populate(el);
        }
        return noChange;
    }
}

/** `<div ${renderInto(el => fill(el), key)}></div>` — see RenderIntoDirective. */
export const renderInto = directive(RenderIntoDirective);

/**
 * A read-only property row: label on top, value in a muted, non-editable box.
 * The single source of truth for the `property-row` + `property-value read-only`
 * markup used across the panel.
 */
export function ppReadonlyRow(label: string, value: string): TemplateResult {
    return html`
        <div class="property-row">
            <div class="property-label">${label}</div>
            <div class="property-value read-only">${value}</div>
        </div>
    `;
}

/** A stacked field: label on top, control below, optional muted hint. */
export function ppField(label: string, control: TemplateResult, hint?: string): TemplateResult {
    return html`
        <div class="property-row pp-field">
            <div class="property-label">${label}</div>
            ${control}
            ${hint ? html`<div class="pp-field-hint">${hint}</div>` : nothing}
        </div>
    `;
}

export interface NumberFieldOptions {
    /** Current value, or undefined when unset (renders the placeholder). */
    value: number | undefined;
    placeholder?: string;
    /** Inline suffix shown inside the input, e.g. "tokens". */
    unit?: string;
    /** Smallest accepted value (inclusive). Defaults to 1. */
    min?: number;
    ariaLabel?: string;
    /** Called with the parsed integer, or null when the field is cleared/empty. */
    onCommit: (value: number | null) => void;
    /** Called with the raw text when it isn't a valid integer ≥ min. */
    onInvalid?: (raw: string) => void;
    /** When provided, renders a clear button that invokes this. */
    onClear?: () => void;
    clearTitle?: string;
}

/**
 * A compact integer input with an inline unit, a primary "Update" button, and an
 * optional clear button. Commits on Enter or the button; Escape restores the
 * original value. Empty commits as `null` (caller decides what "unset" means).
 */
export function ppNumberField(opts: NumberFieldOptions): TemplateResult {
    const inputRef: Ref<HTMLInputElement> = createRef();
    const min = opts.min ?? 1;
    const initial = opts.value !== undefined ? String(opts.value) : '';

    const commit = (): void => {
        const input = inputRef.value;
        if (!input) return;
        const text = input.value.trim();
        if (text === '') {
            opts.onCommit(null);
            return;
        }
        const parsed = Number(text);
        if (!Number.isInteger(parsed) || parsed < min) {
            opts.onInvalid?.(text);
            return;
        }
        opts.onCommit(parsed);
    };

    const onKeydown = (e: KeyboardEvent): void => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commit();
        } else if (e.key === 'Escape') {
            if (inputRef.value) inputRef.value.value = initial;
            inputRef.value?.blur();
        }
    };

    return html`
        <div class="pp-num-field">
            <input
                ${ref(inputRef)}
                class="pp-num-input"
                type="number"
                min=${min}
                step="1"
                placeholder=${opts.placeholder ?? ''}
                aria-label=${opts.ariaLabel ?? nothing}
                .value=${initial}
                @keydown=${onKeydown}
            />
            ${opts.unit && opts.value !== undefined
                ? html`<span class="pp-num-unit">${opts.unit}</span>`
                : nothing}
            <button class="mini-btn primary" type="button" @click=${commit}>Update</button>
            ${opts.onClear
                ? html`<button
                      class="mini-btn icon-only"
                      type="button"
                      title=${opts.clearTitle ?? 'Clear'}
                      @click=${() => opts.onClear?.()}
                  >
                      <span class="codicon codicon-discard"></span>
                  </button>`
                : nothing}
        </div>
    `;
}
