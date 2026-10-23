/**
 * The fields a producer lets a person edit on a node, in the property panel.
 *
 * A producer lists a node's parameters on `meta.parameters`; until now the
 * panel edited them only for a network runtime (`networkPropertySections`),
 * as source expressions with an "add parameter" row, which is that runtime's
 * idea of a parameter. A producer that marks an entry `editable: true` gets
 * an editor in any profile, for exactly the fields it listed, edited through
 * the same `updateNodeParameter` operation:
 *
 *     { "name": "status", "value": "draft", "editable": true,
 *       "choices": ["draft", "active", "retired"] }      → a select
 *     { "name": "domain", "value": "core", "editable": true,
 *       "suggestions": ["core", "mem"] }                  → an input with suggestions
 *     { "name": "owner", "value": "", "editable": true }  → an input
 *
 * The value goes back as the person typed or picked it, unquoted: the
 * producer said what the field holds, so there is no expression to form.
 */

export interface ProducerField {
    name: string;
    value: string;
    /** The only values the field takes, in the producer's order: a select. */
    choices?: string[];
    /** Values worth offering, the field taking others too: an input's suggestions. */
    suggestions?: string[];
    /** Shown under the field, when the producer gave one. */
    description?: string;
}

function strings(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const list = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
    return list.length > 0 ? list : undefined;
}

/** The entries of `meta.parameters` marked editable, normalized; the rest are not this editor's. */
export function producerFields(raw: unknown): ProducerField[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const fields: ProducerField[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || (entry as { editable?: unknown }).editable !== true) {
            continue;
        }
        const { name, value, choices, suggestions, description } = entry as Record<string, unknown>;
        if (typeof name !== 'string' || name.trim() === '') {
            continue;
        }
        const field: ProducerField = {
            name: name.trim(),
            value: value === undefined || value === null ? '' : String(value)
        };
        const choiceList = strings(choices);
        if (choiceList) {
            // The current value stays pickable even when the producer's list
            // has not caught up with it, so opening the panel changes nothing.
            field.choices = field.value && !choiceList.includes(field.value) ? [field.value, ...choiceList] : choiceList;
        } else {
            const suggestionList = strings(suggestions);
            if (suggestionList) {
                field.suggestions = suggestionList;
            }
        }
        if (typeof description === 'string' && description.trim() !== '') {
            field.description = description.trim();
        }
        fields.push(field);
    }
    return fields;
}
