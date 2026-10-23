/**
 * The ELK server options: the product's jar, the person's settings.
 *
 * Nothing without a jar in the profile, so a product that ships none never
 * starts Java. With one, the jar resolves against the extension's root and
 * the settings pick the engine and the JVM, with `auto` and a 2 GB heap when
 * they are unset or nonsense.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ELK_SERVER_JAVA_OPTS, composeElkServerOptions } from '../src/extension/diagram/profile-elk-server-options';

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
