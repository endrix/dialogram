/**
 * What is worked out of a large file is kept while the file stays as it was
 * (file-memo.ts); a small file is read every time. A failure is not kept, and
 * nothing of who asked is.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, promises as fs, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileMemo, LARGE_FILE_BYTES, largeFileStamp } from '../src/services/file-memo';

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'file-memo-'));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const large = (name: string, fill = 'a'): string => {
    const file = path.join(dir, name);
    writeFileSync(file, fill.repeat(LARGE_FILE_BYTES));
    return file;
};

describe('FileMemo', () => {
    it('asks a large file once while it stays as it was, and again when it changes', async () => {
        const file = large('netlist.v');
        let asked = 0;
        const memo = new FileMemo<number>();
        const count = async (): Promise<number> => ++asked;
        expect(await memo.get(file, count)).toBe(1);
        expect(await memo.get(file, count)).toBe(1);
        expect(asked).toBe(1);
        // Longer: another file.
        writeFileSync(file, 'b'.repeat(LARGE_FILE_BYTES + 1));
        expect(await memo.get(file, count)).toBe(2);
        // The same length, written at another time: another file too.
        const before = statSync(file);
        utimesSync(file, before.atime, new Date(before.mtimeMs + 5000));
        expect(await memo.get(file, count)).toBe(3);
        expect(await memo.get(file, count)).toBe(3);
    });

    it('keeps an answer per second input', async () => {
        const file = large('netlist.v');
        const asked: string[] = [];
        const memo = new FileMemo<string>();
        const rangeOf = (name: string): Promise<string> => memo.get(file, async () => {
            asked.push(name);
            return `range of ${name}`;
        }, name);
        expect(await rangeOf('top')).toBe('range of top');
        expect(await rangeOf('alu')).toBe('range of alu');
        expect(await rangeOf('top')).toBe('range of top');
        expect(asked).toEqual(['top', 'alu']);
    });

    it('reads a small file every time, and one that is not there', async () => {
        const small = path.join(dir, 'top.sv');
        writeFileSync(small, 'module top; endmodule\n');
        let asked = 0;
        const memo = new FileMemo<number>();
        const count = async (): Promise<number> => ++asked;
        await memo.get(small, count);
        await memo.get(small, count);
        await memo.get(path.join(dir, 'absent.sv'), count);
        expect(asked).toBe(3);
        expect(await largeFileStamp(small)).toBeUndefined();
        expect(await largeFileStamp(path.join(dir, 'absent.sv'))).toBeUndefined();
        expect(await largeFileStamp(large('big.v'))).toMatch(/^\d+:\d+:\d+$/);
    });

    it('asks again after an answer that failed', async () => {
        const file = large('netlist.v');
        let asked = 0;
        const memo = new FileMemo<number>();
        const flaky = async (): Promise<number> => {
            if (++asked === 1) {
                throw new Error('unreadable');
            }
            return asked;
        };
        await expect(memo.get(file, flaky)).rejects.toThrow('unreadable');
        expect(await memo.get(file, flaky)).toBe(2);
    });

    // A process that may read any file cannot make one unreadable.
    it.skipIf(process.getuid?.() === 0)('does not keep what a caller falls back on when the file could not be read', async () => {
        // As the callers are written: the read inside the memo, the fallback outside it.
        const file = large('netlist.v');
        const memo = new FileMemo<string>();
        const hashOf = async (): Promise<string | undefined> => {
            try {
                return await memo.get(file, async () => createHash('sha256').update(await fs.readFile(file)).digest('hex'));
            } catch {
                return undefined;
            }
        };
        chmodSync(file, 0o000);
        expect(await hashOf()).toBeUndefined();
        // Readable again, with the size, the time and the inode it had: it is read, not remembered as unreadable.
        chmodSync(file, 0o644);
        expect(await hashOf()).toMatch(/^[0-9a-f]{64}$/);
        expect(await hashOf()).toBe(await hashOf());
    });

    it('keeps the answer and nothing of who asked: a later ask is answered by its own compute', async () => {
        const file = large('netlist.v');
        const memo = new FileMemo<string>();
        expect(await memo.get(file, async () => 'the first session')).toBe('the first session');
        // While the file stays as it was the answer kept stands, and the second asker's compute is not run.
        let ran = false;
        expect(await memo.get(file, async () => {
            ran = true;
            return 'the second session';
        })).toBe('the first session');
        expect(ran).toBe(false);
        // Once it changes, whoever asks computes: the first asker's function is nowhere.
        writeFileSync(file, 'c'.repeat(LARGE_FILE_BYTES + 2));
        expect(await memo.get(file, async () => 'the second session')).toBe('the second session');
    });
});
