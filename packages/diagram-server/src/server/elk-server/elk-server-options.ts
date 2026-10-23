/**
 * Laying out with the Java ELK server.
 *
 * elkjs is ELK compiled to JavaScript, and it runs on the extension host's
 * thread: while a large diagram lays out, the whole host waits. The same ELK
 * on a JVM is several times faster, and runs in its own process. A product
 * that ships the server's jar (`DiagramProfile.elkServer`) gets it for large
 * graphs; small ones stay on elkjs, which answers before a JVM would, and
 * lays them out exactly as before.
 *
 * Measured with the platform's own layout of a producer's document graphs
 * (warm JVM): Free Ports on 500 nodes 2.1 s on elkjs, 0.6 s on the server; on
 * 2000, 8.2 s and 2.6 s. With the default preset kept on 500 nodes, 10.2 s
 * and 1.2 s.
 */

/** Which engine lays a graph out. */
export type LayoutEngineChoice =
    /** The server above the size where the platform's cheaper presets start, elkjs below and whenever the server is unavailable. */
    | 'auto'
    /** elkjs only; the server is never started. */
    | 'elkjs'
    /** The server for every graph, elkjs only when the server is unavailable. */
    | 'elk-server';

export interface ElkServerOptions {
    engine: LayoutEngineChoice;
    /** Absolute path of the server's fat jar (`java -jar <jar> --socket`). */
    jar: string;
    /** The `java` to run; default `$JAVA_HOME/bin/java`, else `java` on the PATH. */
    javaPath?: string;
    /** JVM options, split on whitespace (e.g. `-Xmx2g`). */
    javaOpts?: string;
    /** How long one layout may take on the server before elkjs takes it over. Default 120 s. */
    timeoutMs?: number;
}

export const DEFAULT_ELK_SERVER_TIMEOUT_MS = 120_000;
