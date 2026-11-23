/**
 * Forwards one run's live event stream to a diagram, for a run the IDE started
 * and for one it found (a run of the CLI in a terminal) alike.
 *
 * It reads the stream with a {@link RunEventStreamClient}, drops what a
 * reconnect replays (a run numbers its events with a rising `seq`, and replays
 * its recent history to every new connection), batches what is left, and
 * closes the run for the diagram when the run ends without saying so, so its
 * agents do not show as streaming for good.
 */

import * as net from 'node:net';
import { RunEventStreamClient, type RunEventStreamClientOptions, type RunStreamEvent } from './run-event-stream-client.js';

/** The part of {@link RunEventStreamClient} the forwarder drives (tests stub it). */
export interface RunStreamSource {
    start(): void;
    stop(): void;
}

export interface RunStreamForwarderOptions {
    /** Absolute path to the run's `run.wf-stream.live.json`. */
    discoveryFilePath: string;
    /** The run to read, when it is known (see {@link RunEventStreamClientOptions.runId}). */
    runId?: string;
    /** Hands a batch of events to the diagram. */
    emit: (events: RunStreamEvent[]) => void;
    /** Sees every event as it arrives, before batching (breadcrumbs). */
    onEvent?: (event: RunStreamEvent) => void;
    onLog?: (message: string) => void;
    /** The connection failed or ended; the client tries again unless stopped. */
    onDisconnect?: () => void;
    /** Events wait this long to go as one batch. Default 120 ms. */
    flushMs?: number;
    /** Tests: the stream client. */
    createSource?: (options: RunEventStreamClientOptions) => RunStreamSource;
}

export class RunStreamForwarder {
    private source: RunStreamSource | undefined;
    private batch: RunStreamEvent[] = [];
    private flushTimer: ReturnType<typeof setInterval> | undefined;
    private lastSeq = 0;
    private ended = false;
    private stopped = false;

    constructor(private readonly opts: RunStreamForwarderOptions) {}

    /** Whether the run said it ended (`run.finished` or `run.stream.closing`). */
    get runEnded(): boolean {
        return this.ended;
    }

    start(): void {
        if (this.source || this.stopped) {
            return;
        }
        const options: RunEventStreamClientOptions = {
            discoveryFilePath: this.opts.discoveryFilePath,
            runId: this.opts.runId,
            onEvent: (event) => this.accept(event),
            onLog: this.opts.onLog,
            onDisconnect: this.opts.onDisconnect,
        };
        this.source = this.opts.createSource ? this.opts.createSource(options) : new RunEventStreamClient(options);
        this.source.start();
        this.flushTimer = setInterval(() => this.flush(), this.opts.flushMs ?? 120);
    }

    /**
     * Stop reading, hand over what is left, and, when the run did not say it
     * ended, close it for the diagram with `reason`.
     */
    stop(reason = 'the run ended without closing its stream'): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = undefined;
        }
        this.flush();
        const started = this.source !== undefined;
        this.source?.stop();
        this.source = undefined;
        if (started && !this.ended) {
            this.ended = true;
            this.opts.emit([{ type: 'run.stream.closing', reason }]);
        }
    }

    /** Hand the batch over now. */
    flush(): void {
        if (this.batch.length === 0) {
            return;
        }
        const events = this.batch;
        this.batch = [];
        this.opts.emit(events);
    }

    private accept(event: RunStreamEvent): void {
        if (this.stopped) {
            return;
        }
        // A reconnect replays the run's recent history: what was forwarded once is not again.
        if (typeof event.seq === 'number') {
            if (event.seq <= this.lastSeq) {
                return;
            }
            this.lastSeq = event.seq;
        }
        if (event.type === 'run.finished' || event.type === 'run.stream.closing') {
            this.ended = true;
        }
        this.opts.onEvent?.(event);
        this.batch.push(event);
    }
}

/**
 * Whether a run's stream still listens on `host:port`: `open`; `refused` (the
 * port is closed: on this host that is final, the run is gone); `unknown` (no
 * answer in time, or another error: a busy host says nothing about the run).
 */
export type StreamState = 'open' | 'refused' | 'unknown';

export function probeStream(host: string, port: number, timeoutMs = 1000): Promise<StreamState> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (state: StreamState): void => {
            socket.removeAllListeners();
            socket.on('error', () => { /* destroyed: nobody listens any more */ });
            socket.destroy();
            resolve(state);
        };
        socket.setTimeout(timeoutMs, () => done('unknown'));
        socket.once('connect', () => done('open'));
        socket.once('error', (error: NodeJS.ErrnoException) => done(error.code === 'ECONNREFUSED' ? 'refused' : 'unknown'));
    });
}
