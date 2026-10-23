/**
 * The ELK server for a diagram server: one process per extension host, shared
 * by every diagram session (each session's container asks for an ELK of its
 * own, see `createWorkflowServerModules`), stopped by {@link disposeElkServers}
 * when the extension deactivates.
 */
import ElkConstructor from 'elkjs/lib/elk.bundled.js';
import type { ELK, LayoutOptions } from 'elkjs';
import { ElkServerProcess } from './elk-server-process';
import type { ElkServerOptions } from './elk-server-options';
import { SwitchingElk } from './switching-elk';

export * from './elk-server-options';
export { ElkServerProcess } from './elk-server-process';
export { SwitchingElk, elkGraphSize, goesToServer } from './switching-elk';
export { layoutOnServer } from './elk-server-client';

const processes = new Map<string, ElkServerProcess>();

/** The shared process for this jar and JVM. */
export function sharedElkServerProcess(options: ElkServerOptions): ElkServerProcess {
    const key = JSON.stringify([options.jar, options.javaPath ?? '', options.javaOpts ?? '']);
    let server = processes.get(key);
    if (!server) {
        server = new ElkServerProcess(options);
        processes.set(key, server);
    }
    return server;
}

/** Stop every ELK server this extension host started. */
export function disposeElkServers(): void {
    for (const server of processes.values()) {
        server.dispose();
    }
    processes.clear();
}

/**
 * An ELK factory for the layout engine: elkjs with these defaults, behind the
 * server when the options ask for it.
 */
export function createElkFactory(elkjsOptions: { algorithms: string[]; defaultLayoutOptions: LayoutOptions }, server?: ElkServerOptions): () => ELK {
    const elkjs = (): ELK => new (ElkConstructor as any)(elkjsOptions);
    if (!server || server.engine === 'elkjs') {
        return elkjs;
    }
    return () => new SwitchingElk(elkjs(), sharedElkServerProcess(server), server);
}
