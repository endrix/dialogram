/**
 * Pure assembly of the ELK server options the diagram server lays out with.
 *
 * The product says where its jar is (`DiagramProfile.elkServer`); the person
 * says which engine and which JVM, in the product's settings
 * (`<settingsNamespace>.layout.*`). Read once, when the diagram server starts:
 * a change takes effect after a window reload.
 *
 * A product that renamed these settings names the keys it used before
 * (`elkServer.formerKeys`): a former key the person has set is read while the
 * new one is not.
 */
import * as path from 'node:path';
import type { DiagramProfile, ElkServerSettingName } from '../../api';
import type { ElkServerOptions, LayoutEngineChoice } from '@dialogram/diagram-server';

const ENGINES: readonly LayoutEngineChoice[] = ['auto', 'elkjs', 'elk-server'];

/** The key of each setting, under the product's namespace. */
const KEYS: Readonly<Record<ElkServerSettingName, string>> = {
    engine: 'layout.engine',
    javaPath: 'layout.javaPath',
    javaOpts: 'layout.javaOpts',
    serverTimeoutMs: 'layout.serverTimeoutMs'
};

/** JVM options when the setting is empty: enough heap for a few thousand nodes. */
export const DEFAULT_ELK_SERVER_JAVA_OPTS = '-Xmx2g';

export function composeElkServerOptions(
    profile: Pick<DiagramProfile, 'elkServer'>,
    extensionPath: string,
    setting: <T>(key: string) => T | undefined,
    isSet: (key: string) => boolean = key => setting(key) !== undefined
): ElkServerOptions | undefined {
    if (!profile.elkServer?.jar) {
        return undefined;
    }
    const read = <T>(name: ElkServerSettingName): T | undefined => {
        const key = KEYS[name];
        const former = profile.elkServer?.formerKeys?.[name];
        return former && !isSet(key) && isSet(former) ? setting<T>(former) : setting<T>(key);
    };
    const engine = read<string>('engine');
    const timeoutMs = read<number>('serverTimeoutMs');
    return {
        engine: ENGINES.includes(engine as LayoutEngineChoice) ? (engine as LayoutEngineChoice) : 'auto',
        jar: path.resolve(extensionPath, profile.elkServer.jar),
        javaPath: read<string>('javaPath') || undefined,
        javaOpts: read<string>('javaOpts') || DEFAULT_ELK_SERVER_JAVA_OPTS,
        timeoutMs: typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined
    };
}

/** The former keys a person still sets, each beside the key that now names it. */
export function formerElkServerKeysInUse(
    profile: Pick<DiagramProfile, 'elkServer'>,
    isSet: (key: string) => boolean
): Array<{ former: string; key: string }> {
    const formerKeys = profile.elkServer?.formerKeys ?? {};
    return (Object.keys(KEYS) as ElkServerSettingName[]).flatMap(name => {
        const former = formerKeys[name];
        return former && isSet(former) ? [{ former, key: KEYS[name] }] : [];
    });
}

/**
 * A section of settings, as `vscode.workspace.getConfiguration(namespace)`
 * answers: a value, its default included, and where it was set.
 */
export interface SettingsSection {
    get<T>(key: string): T | undefined;
    inspect<T>(key: string): Partial<Record<
        'globalValue' | 'workspaceValue' | 'workspaceFolderValue' | 'globalLanguageValue' | 'workspaceLanguageValue' | 'workspaceFolderLanguageValue',
        T
    >> | undefined;
}

/** Whether a person set a key anywhere, rather than leaving its default. */
export function isSetIn(section: SettingsSection, key: string): boolean {
    const where = section.inspect(key);
    return !!where && [
        where.globalValue,
        where.workspaceValue,
        where.workspaceFolderValue,
        where.globalLanguageValue,
        where.workspaceLanguageValue,
        where.workspaceFolderLanguageValue
    ].some(value => value !== undefined);
}

/**
 * The ELK server options of a profile, read from its settings section: the
 * ones the diagram server lays out with, for a product's own code that weighs
 * what a layout will cost on the engine chosen.
 */
export function elkServerOptionsOf(
    profile: Pick<DiagramProfile, 'elkServer'>,
    extensionPath: string,
    section: SettingsSection
): ElkServerOptions | undefined {
    return composeElkServerOptions(profile, extensionPath, key => section.get(key), key => isSetIn(section, key));
}
