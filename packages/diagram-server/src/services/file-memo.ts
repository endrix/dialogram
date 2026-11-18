/**
 * What was worked out of a file, kept while the file stays as it was.
 *
 * A diagram's load asks several things of its source: its hash, the units it
 * declares, where one of them is written. Each is a read of the whole file.
 * For a source of a few kilobytes that is nothing; a synthesised netlist is
 * hundreds of megabytes, each read is seconds, and a diagram of one is asked
 * for again at every step it grows by. So for a file of at least
 * `LARGE_FILE_BYTES` an answer is kept for as long as the file's size,
 * modification time and inode stay the same, and asked of the file once.
 *
 * A smaller file is read every time, as it always was: reading it costs
 * nothing, and a file rewritten within one clock tick to the same length is
 * then never mistaken for itself.
 *
 * Two things a memo must not keep:
 *
 * - A failure. An answer is what `compute` returns; a read that failed is to
 *   throw, and whoever asked turns that into the value it falls back on. A
 *   compute that caught its own error and returned the fallback would have it
 *   kept as the file's answer until the file changed: a file unreadable once
 *   (permissions, too many open files) would stay unread.
 * - Whoever asked. `compute` is given at every ask and used for that ask
 *   alone, so a memo shared by every editor of a product holds answers and
 *   nothing of the session that first asked.
 */
import { promises as fs } from 'node:fs';

/** The size from which a file's answers are kept. */
export const LARGE_FILE_BYTES = 1024 * 1024;

const MAX_ENTRIES = 64;

/** What says a large file is still the file it was; `undefined` for a small one, or one that cannot be read. */
export async function largeFileStamp(filePath: string): Promise<string | undefined> {
    try {
        const stat = await fs.stat(filePath, { bigint: true });
        return stat.size >= BigInt(LARGE_FILE_BYTES) ? `${stat.size}:${stat.mtimeNs}:${stat.ino}` : undefined;
    } catch {
        return undefined;
    }
}

export class FileMemo<T> {
    private readonly kept = new Map<string, { stamp: string; value: Promise<T> }>();

    /**
     * The answer for a file and, when it depends on one, a second input
     * (`key`): the one kept while the file stays as it was, else what
     * `compute` now says. `compute` throws when it cannot say.
     */
    async get(filePath: string, compute: () => Promise<T>, key = ''): Promise<T> {
        const stamp = await largeFileStamp(filePath);
        if (stamp === undefined) {
            return compute();
        }
        const id = `${filePath}\u0000${key}`;
        const hit = this.kept.get(id);
        if (hit && hit.stamp === stamp) {
            this.kept.delete(id);
            this.kept.set(id, hit); // most recently used last
            return hit.value;
        }
        const value = compute();
        this.kept.set(id, { stamp, value });
        // An answer that failed is asked for again next time.
        value.catch(() => {
            if (this.kept.get(id)?.value === value) {
                this.kept.delete(id);
            }
        });
        while (this.kept.size > MAX_ENTRIES) {
            const oldest = this.kept.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.kept.delete(oldest);
        }
        return value;
    }
}
