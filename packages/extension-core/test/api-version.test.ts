import { describe, expect, it } from 'vitest';
import { isApiVersionCompatible } from '../src/api';

describe('isApiVersionCompatible', () => {
    it('requires exact major.minor while pre-1.0', () => {
        expect(isApiVersionCompatible('0.1.0', '0.1.0')).toBe(true);
        expect(isApiVersionCompatible('0.1.5', '0.1.0')).toBe(true);
        expect(isApiVersionCompatible('0.2.0', '0.1.0')).toBe(false);
        expect(isApiVersionCompatible('1.0.0', '0.1.0')).toBe(false);
    });

    it('accepts same-major post-1.0', () => {
        expect(isApiVersionCompatible('1.4.0', '1.0.0')).toBe(true);
        expect(isApiVersionCompatible('2.0.0', '1.0.0')).toBe(false);
    });
});
