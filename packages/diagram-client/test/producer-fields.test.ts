/**
 * The fields a producer lets a person edit, for any profile.
 *
 * Only entries marked `editable` are this editor's; `choices` make a select
 * (keeping a current value the list has not caught up with), `suggestions`
 * an input with a list, and a value is carried as text, unquoted.
 */
import { describe, expect, it } from 'vitest';
import { producerFields } from '../src/producer-fields';

describe('producerFields', () => {
    it('takes only the entries marked editable', () => {
        expect(producerFields([
            { name: 'width', value: 8 },
            { name: 'status', value: 'draft', editable: true }
        ])).toEqual([{ name: 'status', value: 'draft' }]);
        expect(producerFields(undefined)).toEqual([]);
        expect(producerFields({ status: 'draft' })).toEqual([]);
    });

    it('makes choices a select and keeps the current value pickable', () => {
        const [field] = producerFields([{ name: 'status', value: 'legacy', editable: true, choices: ['draft', 'active'] }]);

        expect(field.choices).toEqual(['legacy', 'draft', 'active']);
        expect(field.suggestions).toBeUndefined();
    });

    it('offers suggestions on an input, and carries an unset value as empty text', () => {
        const [domain, owner] = producerFields([
            { name: 'domain', value: 'core', editable: true, suggestions: ['core', 'mem', ''] },
            { name: 'owner', value: null, editable: true, description: 'Who answers for it' }
        ]);

        expect(domain).toEqual({ name: 'domain', value: 'core', suggestions: ['core', 'mem'] });
        expect(owner).toEqual({ name: 'owner', value: '', description: 'Who answers for it' });
    });
});
