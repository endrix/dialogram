/**
 * Pure assembly of the ELK server options the diagram server lays out with.
 *
 * The product says where its jar is (`DiagramProfile.elkServer`); the person
 * says which engine and which JVM, in the product's settings
 * (`<settingsNamespace>.layout.*`). Read once, when the diagram server starts:
 * a change takes effect after a window reload.
 */
import * as path from 'node:path';
import type { DiagramProfile } from '../../api';
import type { ElkServerOptions, LayoutEngineChoice } from '@dialogram/diagram-server';

const ENGINES: readonly LayoutEngineChoice[] = ['auto', 'elkjs', 'elk-server'];

/** JVM options when the setting is empty: enough heap for a few thousand nodes. */
export const DEFAULT_ELK_SERVER_JAVA_OPTS = '-Xmx2g';

export function composeElkServerOptions(
    profile: Pick<DiagramProfile, 'elkServer'>,
    extensionPath: string,
    setting: <T>(key: string) => T | undefined
): ElkServerOptions | undefined {
    if (!profile.elkServer?.jar) {
        return undefined;
    }
    const engine = setting<string>('layout.engine');
    const timeoutMs = setting<number>('layout.serverTimeoutMs');
    return {
        engine: ENGINES.includes(engine as LayoutEngineChoice) ? (engine as LayoutEngineChoice) : 'auto',
        jar: path.resolve(extensionPath, profile.elkServer.jar),
        javaPath: setting<string>('layout.javaPath') || undefined,
        javaOpts: setting<string>('layout.javaOpts') || DEFAULT_ELK_SERVER_JAVA_OPTS,
        timeoutMs: typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined
    };
}
