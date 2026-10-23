/**
 * One layout on the ELK server, over a local socket.
 *
 * The server speaks two framings and only one is safe. Its plain-JSON mode
 * finds the end of a message by counting braces, string contents included, so
 * a `}` in any id leaves it waiting for a close that never comes; the
 * platform's ids carry node labels, and a label may have one. Its framed mode
 * sends `GZ10`, the body's length (4 bytes, big-endian) and a gzip body, in
 * both directions, and never looks inside. A framed body that is not gzip gets
 * no answer at all, so every request is compressed, however small.
 *
 * One connection per layout: two diagrams laying out at once never share a
 * stream, and the server serves each connection on its own.
 */
import { Socket } from 'node:net';
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { ElkNode } from 'elkjs';
import { applyLayoutData, type LayoutData } from './layout-data';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const FRAME_MAGIC = Buffer.from('GZ10', 'latin1');
export const FRAME_HEADER_BYTES = 8;

/** A message in the server's framing: magic, length, gzip body. */
export async function encodeFrame(json: string): Promise<Buffer> {
    const body = await gzipAsync(Buffer.from(json, 'utf8'));
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    FRAME_MAGIC.copy(header, 0);
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
}

/**
 * Lay `graph` out on the server at `port`, writing the positions, sizes and
 * routes back into it (as elkjs would) and resolving with it.
 */
export function layoutOnServer(port: number, graph: ElkNode, timeoutMs: number): Promise<ElkNode> {
    return new Promise((resolve, reject) => {
        const socket = new Socket();
        let settled = false;
        const finish = (error?: Error, result?: ElkNode): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            if (error) {
                reject(error);
            } else {
                resolve(result!);
            }
        };
        const timer = setTimeout(
            () => finish(new Error(`the ELK server took longer than ${timeoutMs} ms`)),
            timeoutMs
        );

        const chunks: Buffer[] = [];
        let received = 0;
        socket.on('data', chunk => {
            chunks.push(chunk);
            received += chunk.length;
            if (received < FRAME_HEADER_BYTES) {
                return;
            }
            const message = Buffer.concat(chunks);
            if (!message.subarray(0, 4).equals(FRAME_MAGIC)) {
                finish(new Error('the ELK server answered outside its framing'));
                return;
            }
            const length = message.readUInt32BE(4);
            if (message.length < FRAME_HEADER_BYTES + length) {
                return;
            }
            gunzipAsync(message.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length))
                .then(body => {
                    const response = JSON.parse(body.toString('utf8')) as LayoutData | { message?: string; stack?: unknown };
                    if (response && typeof response === 'object' && 'stack' in response) {
                        finish(new Error(`the ELK server failed: ${String(response.message ?? 'no message')}`));
                        return;
                    }
                    applyLayoutData(response as LayoutData, graph);
                    finish(undefined, graph);
                })
                .catch(error => finish(error instanceof Error ? error : new Error(String(error))));
        });
        socket.on('error', error => finish(error));
        socket.on('close', () => finish(new Error('the ELK server closed the connection')));

        encodeFrame(JSON.stringify(graph))
            .then(frame => {
                socket.connect(port, '127.0.0.1', () => socket.write(frame));
            })
            .catch(error => finish(error instanceof Error ? error : new Error(String(error))));
    });
}
