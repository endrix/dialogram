import { describe, expect, it } from 'vitest';
import { DIALOGRAM_API_VERSION, isApiVersionCompatible } from '../src/api';

describe('DIALOGRAM_API_VERSION', () => {
    it('is 0.5.0', () => {
        expect(DIALOGRAM_API_VERSION).toBe('0.5.0');
    });
});

describe('isApiVersionCompatible', () => {
    it('requires exact major.minor while pre-1.0', () => {
        expect(isApiVersionCompatible('0.1.0', '0.1.0')).toBe(true);
        expect(isApiVersionCompatible('0.1.5', '0.1.0')).toBe(true);
        expect(isApiVersionCompatible('0.2.0', '0.1.0')).toBe(false);
        expect(isApiVersionCompatible('0.3.0', '0.3.0')).toBe(true);
        expect(isApiVersionCompatible('0.3.0', '0.2.0')).toBe(false);
        expect(isApiVersionCompatible('0.4.0', '0.4.0')).toBe(true);
        expect(isApiVersionCompatible('0.4.0', '0.3.0')).toBe(false);
        // 0.5.0 bump forces consumers off the 0.4.0 expectation (exact minor).
        expect(isApiVersionCompatible('0.5.0', '0.5.0')).toBe(true);
        expect(isApiVersionCompatible('0.4.0', '0.5.0')).toBe(false);
        expect(isApiVersionCompatible('0.5.0', '0.4.0')).toBe(false);
        expect(isApiVersionCompatible('1.0.0', '0.1.0')).toBe(false);
    });

    it('accepts same-major post-1.0', () => {
        expect(isApiVersionCompatible('1.4.0', '1.0.0')).toBe(true);
        expect(isApiVersionCompatible('2.0.0', '1.0.0')).toBe(false);
    });
});
