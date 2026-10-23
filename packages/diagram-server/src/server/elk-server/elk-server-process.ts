/**
 * The ELK server's process: started when a layout first needs it, shared by
 * every diagram in the extension host, stopped with the extension.
 *
 * From mlir-viewer's `elk-server-manager.ts`. The server takes its port from
 * `ELK_SERVER_PORT` (it has no flag for it), so a free one is picked here, and
 * the process is ready once it prints that it is listening. A process that
 * dies, or runs out of heap (it keeps running, broken, so it is killed), is
 * started again by the next layout that asks for it; until then layouts go to
 * elkjs. Nothing waits on a server that cannot start: no Java, no jar, or no
 * "listening" within the start timeout, and the layout goes to elkjs.
 */
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { ElkServerOptions } from './elk-server-options';

/** How long a starting server has to say it is listening. */
export const ELK_SERVER_START_TIMEOUT_MS = 15_000;

const LISTENING = /listening (?:to|on) [^\s:]*:(\d+)/i;

export type SpawnFunction = (command: string, args: string[], options: cp.SpawnOptions) => cp.ChildProcess;

export class ElkServerProcess {
    private child: cp.ChildProcess | undefined;
    private port: number | undefined;
    private starting: Promise<number | undefined> | undefined;
    private disposed = false;
    /** Why the last start failed; logged once, not on every layout. */
    private lastFailure: string | undefined;

    constructor(
        private readonly options: Pick<ElkServerOptions, 'jar' | 'javaPath' | 'javaOpts'>,
        private readonly spawn: SpawnFunction = cp.spawn,
        private readonly startTimeoutMs = ELK_SERVER_START_TIMEOUT_MS
    ) {}

    /** The port of a running server, starting one if there is none; undefined if it cannot start. */
    async ensureStarted(): Promise<number | undefined> {
        if (this.disposed) {
            return undefined;
        }
        if (this.port !== undefined && this.isRunning()) {
            return this.port;
        }
        this.starting ??= this.start().finally(() => {
            this.starting = undefined;
        });
        return this.starting;
    }

    isRunning(): boolean {
        return this.child !== undefined && this.child.exitCode === null && !this.child.killed;
    }

    /** Stop the process for good; later layouts go to elkjs. */
    dispose(): void {
        this.disposed = true;
        this.stop();
    }

    private stop(): void {
        const child = this.child;
        this.child = undefined;
        this.port = undefined;
        if (!child || child.exitCode !== null) {
            return;
        }
        child.kill('SIGTERM');
        const escalate = setTimeout(() => {
            if (child.exitCode === null) {
                child.kill('SIGKILL');
            }
        }, 5000);
        escalate.unref?.();
    }

    private async start(): Promise<number | undefined> {
        if (!fs.existsSync(this.options.jar)) {
            return this.failed(`no ELK server jar at ${this.options.jar}`);
        }
        const port = await freePort();
        const args = [...(this.options.javaOpts ?? '').split(/\s+/).filter(Boolean), '-jar', this.options.jar, '--socket'];
        let child: cp.ChildProcess;
        try {
            child = this.spawn(this.javaPath(), args, {
                cwd: path.dirname(this.options.jar),
                env: { ...process.env, ELK_SERVER_HOST: '127.0.0.1', ELK_SERVER_PORT: String(port) },
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (error) {
            return this.failed(`could not run ${this.javaPath()}: ${String(error)}`);
        }
        this.child = child;
        child.on('exit', () => {
            if (this.child === child) {
                this.child = undefined;
                this.port = undefined;
            }
        });
        child.stderr?.on('data', data => {
            if (/OutOfMemoryError|Java heap space/.test(String(data))) {
                console.error('[dialogram layout] the ELK server ran out of heap; it restarts with the next layout (raise -Xmx in the layout settings)');
                child.kill('SIGKILL');
            }
        });

        const listening = await this.waitForListening(child);
        if (listening === undefined) {
            this.stop();
            return this.failed(`the ELK server did not start within ${this.startTimeoutMs} ms (is Java 11 or later installed?)`);
        }
        this.port = listening;
        this.lastFailure = undefined;
        console.log(`[dialogram layout] ELK server listening on port ${listening} (pid ${child.pid})`);
        return listening;
    }

    private waitForListening(child: cp.ChildProcess): Promise<number | undefined> {
        return new Promise(resolve => {
            let output = '';
            const done = (port: number | undefined): void => {
                clearTimeout(timer);
                child.stdout?.off('data', onData);
                child.stderr?.off('data', onData);
                child.off('exit', onExit);
                child.off('error', onExit);
                resolve(port);
            };
            const onData = (data: Buffer | string): void => {
                output += String(data);
                const match = LISTENING.exec(output);
                if (match) {
                    done(Number(match[1]));
                }
            };
            const onExit = (): void => done(undefined);
            const timer = setTimeout(() => done(undefined), this.startTimeoutMs);
            child.stdout?.on('data', onData);
            child.stderr?.on('data', onData);
            child.once('exit', onExit);
            child.once('error', onExit);
        });
    }

    private javaPath(): string {
        if (this.options.javaPath) {
            return this.options.javaPath;
        }
        const home = process.env.JAVA_HOME;
        if (home) {
            const java = path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
            if (fs.existsSync(java)) {
                return java;
            }
        }
        return 'java';
    }

    private failed(reason: string): undefined {
        if (reason !== this.lastFailure) {
            console.warn(`[dialogram layout] ${reason}; laying out with elkjs`);
            this.lastFailure = reason;
        }
        return undefined;
    }
}

/** A port nothing listens on, from the OS. */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            server.close(() => (port ? resolve(port) : reject(new Error('no free port for the ELK server'))));
        });
    });
}
