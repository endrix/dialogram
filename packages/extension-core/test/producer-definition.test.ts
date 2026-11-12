/**
 * A definition the producer named is opened as it is: the language tooling,
 * which may be configured for another interpreter, is not asked.
 */
import { describe, expect, it } from 'vitest';
import { NAVIGATE_TARGET_IS_DEFINITION_ARG, producerNamedDefinition } from '../src/extension/diagram/producer-definition';

const file = { scheme: 'file', path: '/w/actors.py' };
const there = async () => ({});
const gone = async () => { throw new Error('ENOENT'); };

describe('a navigation target the producer named as the definition', () => {
    it('is taken when its file is there', async () => {
        expect(await producerNamedDefinition({ [NAVIGATE_TARGET_IS_DEFINITION_ARG]: true }, file, there)).toBe(true);
    });

    it('is not taken when the producer did not say so, and the file is not looked at', async () => {
        let asked = 0;
        const stat = async () => { asked += 1; };
        expect(await producerNamedDefinition({}, file, stat)).toBe(false);
        expect(await producerNamedDefinition(undefined, file, stat)).toBe(false);
        expect(await producerNamedDefinition({ [NAVIGATE_TARGET_IS_DEFINITION_ARG]: 'true' }, file, stat)).toBe(false);
        expect(asked).toBe(0);
    });

    it('is not taken when its file is gone: the language tooling is asked after all', async () => {
        expect(await producerNamedDefinition({ [NAVIGATE_TARGET_IS_DEFINITION_ARG]: true }, file, gone)).toBe(false);
    });

    it('is taken as it is when it is not a file', async () => {
        expect(await producerNamedDefinition({ [NAVIGATE_TARGET_IS_DEFINITION_ARG]: true }, { scheme: 'https' }, gone)).toBe(true);
    });
});
