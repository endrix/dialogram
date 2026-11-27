/**
 * The ELK server options: the product's jar, the person's settings.
 *
 * Nothing without a jar in the profile, so a product that ships none never
 * starts Java. With one, the jar resolves against the extension's root and
 * the settings pick the engine and the JVM, with `auto` and a 2 GB heap when
 * they are unset or nonsense. A former key the product names is read while
 * the new one is not set, and only then.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_ELK_SERVER_JAVA_OPTS,
    composeElkServerOptions,
    elkServerOptionsOf,
    formerElkServerKeysInUse,
    isSetIn,
    type SettingsSection
} from '../src/extension/diagram/profile-elk-server-options';

const settings = (values: Record<string, unknown>) => <T>(key: string): T | undefined => values[key] as T | undefined;

describe('composeElkServerOptions', () => {
    it('is nothing for a product that ships no server', () => {
        expect(composeElkServerOptions({}, '/ext', settings({ 'layout.engine': 'elk-server' }))).toBeUndefined();
    });

    it('resolves the jar against the extension and defaults the rest', () => {
        expect(composeElkServerOptions({ elkServer: { jar: 'resources/elk.jar' } }, '/ext', settings({}))).toEqual({
            engine: 'auto',
            jar: path.resolve('/ext', 'resources/elk.jar'),
            javaPath: undefined,
            javaOpts: DEFAULT_ELK_SERVER_JAVA_OPTS,
            timeoutMs: undefined
        });
    });

    it('takes the person’s engine, JVM and timeout, and ignores an engine it does not know', () => {
        const chosen = composeElkServerOptions({ elkServer: { jar: '/abs/elk.jar' } }, '/ext', settings({
            'layout.engine': 'elkjs',
            'layout.javaPath': '/opt/java/bin/java',
            'layout.javaOpts': '-Xmx6g',
            'layout.serverTimeoutMs': 30000
        }));
        const unknown = composeElkServerOptions({ elkServer: { jar: '/abs/elk.jar' } }, '/ext', settings({ 'layout.engine': 'graphviz' }));

        expect(chosen).toMatchObject({ engine: 'elkjs', jar: '/abs/elk.jar', javaPath: '/opt/java/bin/java', javaOpts: '-Xmx6g', timeoutMs: 30000 });
        expect(unknown?.engine).toBe('auto');
    });
});

describe('former keys', () => {
    const profile = {
        elkServer: {
            jar: '/abs/elk.jar',
            formerKeys: { engine: 'elk.layoutEngine', javaOpts: 'elk.javaOpts', serverTimeoutMs: 'elk.serverTimeoutMs' }
        }
    };

    /** A settings section: what the person set, over the product's defaults. */
    function section(set: Record<string, unknown>, defaults: Record<string, unknown> = {}): SettingsSection {
        return {
            get: <T>(key: string) => (key in set ? set[key] : defaults[key]) as T | undefined,
            inspect: <T>(key: string) => (key in set ? { globalValue: set[key] as T } : {})
        };
    }

    it('reads a former key the person set while the new one is not', () => {
        const options = elkServerOptionsOf(profile, '/ext', section(
            { 'elk.layoutEngine': 'elk-server', 'elk.serverTimeoutMs': 5000 },
            { 'layout.engine': 'auto', 'layout.javaOpts': '-Xmx8g' }
        ));
        expect(options).toMatchObject({ engine: 'elk-server', timeoutMs: 5000, javaOpts: '-Xmx8g' });
    });

    it('takes the new key when the person set it, whatever the former one says', () => {
        const options = elkServerOptionsOf(profile, '/ext', section(
            { 'layout.engine': 'elkjs', 'elk.layoutEngine': 'elk-server' },
            { 'layout.engine': 'auto' }
        ));
        expect(options?.engine).toBe('elkjs');
    });

    it('leaves a former key alone when only its default is there', () => {
        const options = elkServerOptionsOf(profile, '/ext', section({}, { 'layout.engine': 'elkjs', 'elk.layoutEngine': 'elk-server' }));
        expect(options?.engine).toBe('elkjs');
    });

    it('reads no former key for a setting the product named none for', () => {
        const options = elkServerOptionsOf(profile, '/ext', section({ 'elk.javaPath': '/old/java' }));
        expect(options?.javaPath).toBeUndefined();
    });

    it('lists the former keys the person still sets, beside their new names', () => {
        const set = section({ 'elk.layoutEngine': 'elkjs', 'layout.javaOpts': '-Xmx4g' });
        expect(formerElkServerKeysInUse(profile, key => isSetIn(set, key))).toEqual([{ former: 'elk.layoutEngine', key: 'layout.engine' }]);
        expect(formerElkServerKeysInUse({ elkServer: { jar: '/abs/elk.jar' } }, () => true)).toEqual([]);
    });

    it('counts a value set for a workspace, a folder or a language, and not a default', () => {
        const where = (values: Record<string, unknown>): SettingsSection => ({ get: () => undefined, inspect: () => values });
        expect(isSetIn(where({ workspaceFolderValue: 'elkjs' }), 'k')).toBe(true);
        expect(isSetIn(where({ globalLanguageValue: 'elkjs' }), 'k')).toBe(true);
        expect(isSetIn(where({ defaultValue: 'auto' }), 'k')).toBe(false);
        expect(isSetIn({ get: () => undefined, inspect: () => undefined }, 'k')).toBe(false);
    });

    it('keeps the plain composition as it was when no isSet is given', () => {
        expect(composeElkServerOptions(profile, '/ext', settings({ 'elk.layoutEngine': 'elkjs' }))?.engine).toBe('elkjs');
        expect(composeElkServerOptions(profile, '/ext', settings({ 'layout.engine': 'elk-server', 'elk.layoutEngine': 'elkjs' }))?.engine).toBe('elk-server');
    });
});
