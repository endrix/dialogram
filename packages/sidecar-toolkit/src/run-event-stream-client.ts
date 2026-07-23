/**
 * Read-only client for a runtime run's live SSE event stream.
 *
 * A runtime run serves a localhost SSE endpoint (served by the runtime's event-stream module) that
 * broadcasts agent message deltas, reasoning, tool calls, and lifecycle events. It
 * advertises the bound port in `run.wf-stream.live.json` next to the other live files.
 *
 * This client (host side) waits for that discovery file, connects to the SSE endpoint,
 * parses `data:` lines into events, and hands each to `onEvent`. It is strictly
 * read-only — it never sends anything to the run, so observing cannot disturb it. The
 * file-polling path remains the fallback if the stream is unavailable.
 *
 * ## Transport (Round 8): raw socket to survive the extension host
 *
 * In the VS Code extension host, `@vscode/proxy-agent` patches Node's
 * `http`/`https` (with `http.proxySupport: "override"`) and BUFFERS/stalls
 * incremental streaming responses — an SSE `GET` returns `200` and then delivers
 * ZERO `data` chunks for the whole run (confirmed live: `connected (200)` then
 * silence). A raw `net.Socket` HTTP/1.1 client is NOT intercepted by that layer.
 * So `auto` mode tries `http.get` (with `agent:false`) first and, if no bytes
 * arrive within 2s, transparently switches to the raw-socket transport; callers
 * may also force `transport: 'socket'`.
 */
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';

export interface RunStreamEvent {
    seq?: number;
    type?: string;
    instance?: string;
    field?: string;
    delta?: string;
    [key: string]: unknown;
}

interface DiscoveryFile {
    port?: number;
    host?: string;
    eventsUrl?: string;
    runId?: string;
    token?: string;
}

export type RunEventStreamTransport = 'auto' | 'http' | 'socket';

export interface RunEventStreamClientOptions {
    /** Absolute path to `run.wf-stream.live.json`. */
    discoveryFilePath: string;
    onEvent: (event: RunStreamEvent) => void;
    onLog?: (message: string) => void;
    /** How often to poll for the discovery file before connecting. Default 400ms. */
    discoveryPollMs?: number;
    /** Transport strategy. Default 'auto' (http, fall back to raw socket on stall). */
    transport?: RunEventStreamTransport;
    /** Zero-bytes stall window before the auto fallback fires. Default 2000ms. */
    stallFallbackMs?: number;
}

export class RunEventStreamClient {
    private stopped = false;
    private discoveryTimer: ReturnType<typeof setInterval> | undefined;
    private request: http.ClientRequest | undefined;
    private response: http.IncomingMessage | undefined;
    private socket: net.Socket | undefined;
    private connectedUrl: string | undefined;
    private stallTimer: ReturnType<typeof setTimeout> | undefined;

    // SSE frame assembly (shared by both transports).
    private sseBuffer = '';
    // Raw-socket response parsing.
    private socketHeadersParsed = false;
    private socketChunked = false;
    private socketBodyBuf: Buffer = Buffer.alloc(0);

    private bytesReceived = 0;
    private usedSocketFallback = false;

    constructor(private readonly opts: RunEventStreamClientOptions) {}

    private log(message: string): void {
        this.opts.onLog?.(message);
    }

    start(): void {
        const pollMs = this.opts.discoveryPollMs ?? 400;
        this.log(`[run-stream] polling for discovery file ${this.opts.discoveryFilePath} (every ${pollMs}ms)`);
        let missReported = false;
        const tryConnect = async (): Promise<void> => {
            if (this.stopped || this.connectedUrl) {
                return;
            }
            const discovery = await this.readDiscovery();
            if (!discovery) {
                if (!missReported) {
                    this.log('[run-stream] discovery file not present yet; will keep polling');
                    missReported = true;
                }
                return;
            }
            let url = discovery.eventsUrl
                ?? (discovery.port ? `http://${discovery.host ?? '127.0.0.1'}:${discovery.port}/events` : undefined);
            this.log(`[run-stream] discovery found: url=${url ?? '<none>'} token=${discovery.token ? 'yes' : 'no'}`);
            if (url && discovery.token) {
                // The run's SSE server requires a per-run bearer token (blocks other local
                // processes / DNS-rebinding pages from reading the agent stream).
                url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(discovery.token);
            }
            if (url) {
                this.connect(url);
            }
        };
        this.discoveryTimer = setInterval(() => void tryConnect(), pollMs);
        void tryConnect();
    }

    stop(): void {
        this.stopped = true;
        if (this.discoveryTimer) {
            clearInterval(this.discoveryTimer);
            this.discoveryTimer = undefined;
        }
        this.clearStallTimer();
        this.teardownHttp();
        this.teardownSocket();
    }

    private async readDiscovery(): Promise<DiscoveryFile | undefined> {
        try {
            const raw = await fs.readFile(this.opts.discoveryFilePath, 'utf-8');
            const parsed = JSON.parse(raw) as DiscoveryFile;
            return parsed && typeof parsed === 'object' ? parsed : undefined;
        } catch {
            return undefined; // not written yet / removed at run end
        }
    }

    private connect(url: string): void {
        if (this.stopped || this.connectedUrl) {
            return;
        }
        this.connectedUrl = url;
        const mode = this.opts.transport ?? 'auto';
        if (mode === 'socket' || this.usedSocketFallback) {
            this.connectViaSocket(url);
            return;
        }
        this.connectViaHttp(url);
        if (mode === 'auto') {
            const stallMs = this.opts.stallFallbackMs ?? 2000;
            this.stallTimer = setTimeout(() => {
                if (this.stopped || this.bytesReceived > 0 || this.usedSocketFallback) {
                    return;
                }
                this.log(`[run-stream] connected but no data after ${stallMs}ms — suspected ext-host http patching; switching to raw socket transport`);
                this.usedSocketFallback = true;
                this.teardownHttp(); // listeners removed → no spurious retry
                this.connectViaSocket(url);
            }, stallMs);
        }
    }

    // ── http transport (fast path; agent:false to dodge the pooled proxy agent) ──
    private connectViaHttp(url: string): void {
        this.log(`[run-stream] connecting (http) to ${url}`);
        this.request = http.get(url, { headers: { accept: 'text/event-stream' }, agent: false }, (res) => {
            this.response = res;
            this.log(`[run-stream] response headers (http) status=${res.statusCode} transfer-encoding=${res.headers['transfer-encoding'] ?? '<none>'} content-length=${res.headers['content-length'] ?? '<none>'}`);
            if (res.statusCode !== 200) {
                this.log(`[run-stream] non-200 (${res.statusCode}); will retry`);
                res.resume();
                this.resetForRetry();
                return;
            }
            this.log(`[run-stream] connected (200, http); streaming events from ${url}`);
            res.setEncoding('utf-8');
            res.on('data', (chunk: string) => this.onBytes(Buffer.byteLength(chunk), () => this.feedSse(chunk)));
            res.on('end', () => { this.log('[run-stream] response end'); this.resetForRetry(); });
            res.on('close', () => { this.log('[run-stream] response close'); this.resetForRetry(); });
            res.on('aborted', () => { this.log('[run-stream] response aborted'); this.resetForRetry(); });
            res.on('error', (err) => { this.log(`[run-stream] response error: ${err.message}`); this.resetForRetry(); });
        });
        this.request.on('error', (err) => {
            this.log(`[run-stream] connect error: ${err.message}; will retry`);
            this.resetForRetry();
        });
    }

    // ── raw-socket transport (not intercepted by @vscode/proxy-agent) ───────────
    private connectViaSocket(url: string): void {
        let u: URL;
        try {
            u = new URL(url);
        } catch (err) {
            this.log(`[run-stream] bad url for socket transport: ${String(err)}`);
            this.resetForRetry();
            return;
        }
        const secure = u.protocol === 'https:';
        const port = u.port ? Number(u.port) : (secure ? 443 : 80);
        const requestPath = `${u.pathname}${u.search}`;
        this.socketHeadersParsed = false;
        this.socketChunked = false;
        this.socketBodyBuf = Buffer.alloc(0);
        this.log(`[run-stream] connecting (raw socket) to ${u.hostname}:${port}${requestPath}`);

        const onConnect = (): void => {
            this.log('[run-stream] raw socket connected; sending request');
            socket.write(
                `GET ${requestPath} HTTP/1.1\r\n` +
                `Host: ${u.hostname}:${port}\r\n` +
                'Accept: text/event-stream\r\n' +
                'Connection: keep-alive\r\n\r\n'
            );
        };
        const socket = secure
            ? tls.connect({ host: u.hostname, port, servername: u.hostname, rejectUnauthorized: false }, onConnect)
            : net.connect({ host: u.hostname, port }, onConnect);

        this.socket = socket;
        socket.on('data', (chunk: Buffer) => this.onBytes(chunk.length, () => this.onSocketData(chunk)));
        socket.on('end', () => { this.log('[run-stream] raw socket end'); this.resetForRetry(); });
        socket.on('close', () => { this.log('[run-stream] raw socket close'); this.resetForRetry(); });
        socket.on('error', (err) => { this.log(`[run-stream] raw socket error: ${err.message}; will retry`); this.resetForRetry(); });
    }

    private onSocketData(chunk: Buffer): void {
        this.socketBodyBuf = Buffer.concat([this.socketBodyBuf, chunk]);
        if (!this.socketHeadersParsed) {
            const headerEnd = this.socketBodyBuf.indexOf('\r\n\r\n');
            if (headerEnd === -1) {
                return; // headers not complete yet
            }
            const headerText = this.socketBodyBuf.subarray(0, headerEnd).toString('ascii');
            this.socketBodyBuf = this.socketBodyBuf.subarray(headerEnd + 4);
            this.socketHeadersParsed = true;
            const statusLine = headerText.split('\r\n', 1)[0] ?? '';
            const statusMatch = /HTTP\/1\.[01]\s+(\d+)/.exec(statusLine);
            const status = statusMatch ? Number(statusMatch[1]) : 0;
            this.socketChunked = /transfer-encoding:\s*chunked/i.test(headerText);
            this.log(`[run-stream] response headers (socket) status=${status} chunked=${this.socketChunked}`);
            if (status !== 200) {
                this.log(`[run-stream] non-200 (${status}); will retry`);
                this.resetForRetry();
                return;
            }
            this.log('[run-stream] connected (200, raw socket); streaming events');
        }
        this.drainSocketBody();
    }

    private drainSocketBody(): void {
        if (!this.socketChunked) {
            if (this.socketBodyBuf.length > 0) {
                this.feedSse(this.socketBodyBuf.toString('utf-8'));
                this.socketBodyBuf = Buffer.alloc(0);
            }
            return;
        }
        // De-chunk HTTP/1.1 `transfer-encoding: chunked` body incrementally.
        for (;;) {
            const nl = this.socketBodyBuf.indexOf('\r\n');
            if (nl === -1) {
                return; // size line incomplete
            }
            const size = parseInt(this.socketBodyBuf.subarray(0, nl).toString('ascii').trim(), 16);
            if (Number.isNaN(size)) {
                this.log('[run-stream] malformed chunk size; will retry');
                this.resetForRetry();
                return;
            }
            if (size === 0) {
                return; // terminal chunk (server closed the body)
            }
            const start = nl + 2;
            const end = start + size;
            if (this.socketBodyBuf.length < end + 2) {
                return; // chunk (+ trailing CRLF) not fully arrived
            }
            const data = this.socketBodyBuf.subarray(start, end);
            this.socketBodyBuf = this.socketBodyBuf.subarray(end + 2);
            this.feedSse(data.toString('utf-8'));
        }
    }

    /** Common per-chunk accounting + stall-timer cancel, then run the handler. */
    private onBytes(byteCount: number, handle: () => void): void {
        this.bytesReceived += byteCount;
        this.log(`[run-stream] data chunk: ${byteCount} bytes (total ${this.bytesReceived})`);
        this.clearStallTimer();
        handle();
    }

    private feedSse(text: string): void {
        this.sseBuffer += text;
        let sep: number;
        while ((sep = this.sseBuffer.indexOf('\n\n')) !== -1) {
            const frame = this.sseBuffer.slice(0, sep);
            this.sseBuffer = this.sseBuffer.slice(sep + 2);
            this.emitFrame(frame);
        }
    }

    private emitFrame(frame: string): void {
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
            const trimmed = line.replace(/\r$/, '');
            if (trimmed.startsWith(':')) {
                continue; // comment / keepalive
            }
            if (trimmed.startsWith('data:')) {
                dataLines.push(trimmed.slice(5).replace(/^ /, ''));
            }
        }
        if (dataLines.length === 0) {
            return;
        }
        try {
            const event = JSON.parse(dataLines.join('\n')) as RunStreamEvent;
            if (event && typeof event === 'object') {
                this.opts.onEvent(event);
            }
        } catch {
            /* ignore malformed frame */
        }
    }

    private clearStallTimer(): void {
        if (this.stallTimer) {
            clearTimeout(this.stallTimer);
            this.stallTimer = undefined;
        }
    }

    private teardownHttp(): void {
        if (this.response) {
            this.response.removeAllListeners();
            try { this.response.destroy(); } catch { /* best-effort */ }
            this.response = undefined;
        }
        if (this.request) {
            this.request.removeAllListeners();
            try { this.request.destroy(); } catch { /* best-effort */ }
            this.request = undefined;
        }
    }

    private teardownSocket(): void {
        if (this.socket) {
            this.socket.removeAllListeners();
            try { this.socket.destroy(); } catch { /* best-effort */ }
            this.socket = undefined;
        }
    }

    /** Drop the current connection so the discovery poll re-connects (run may still be live). */
    private resetForRetry(): void {
        this.clearStallTimer();
        this.sseBuffer = '';
        this.socketBodyBuf = Buffer.alloc(0);
        this.socketHeadersParsed = false;
        this.socketChunked = false;
        this.connectedUrl = undefined;
        this.teardownHttp();
        this.teardownSocket();
    }
}
