/**
 * What is worked out of a large file is kept while the file stays as it was
 * (file-memo.ts); a small file is read every time.
 */
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
        const memo = new FileMemo<number>(async () => ++asked);
        expect(await memo.get(file)).toBe(1);
        expect(await memo.get(file)).toBe(1);
        expect(asked).toBe(1);
        // Longer: another file.
        writeFileSync(file, 'b'.repeat(LARGE_FILE_BYTES + 1));
        expect(await memo.get(file)).toBe(2);
        // The same length, written at another time: another file too.
        const before = statSync(file);
        utimesSync(file, before.atime, new Date(before.mtimeMs + 5000));
        expect(await memo.get(file)).toBe(3);
        expect(await memo.get(file)).toBe(3);
    });

    it('keeps an answer per second input', async () => {
        const file = large('netlist.v');
        const asked: string[] = [];
        const memo = new FileMemo<string>(async (_file, key) => {
            asked.push(key);
            return `range of ${key}`;
        });
        expect(await memo.get(file, 'top')).toBe('range of top');
        expect(await memo.get(file, 'alu')).toBe('range of alu');
        expect(await memo.get(file, 'top')).toBe('range of top');
        expect(asked).toEqual(['top', 'alu']);
    });

    it('reads a small file every time, and one that is not there', async () => {
        const small = path.join(dir, 'top.sv');
        writeFileSync(small, 'module top; endmodule\n');
        let asked = 0;
        const memo = new FileMemo<number>(async () => ++asked);
        await memo.get(small);
        await memo.get(small);
        await memo.get(path.join(dir, 'absent.sv'));
        expect(asked).toBe(3);
        expect(await largeFileStamp(small)).toBeUndefined();
        expect(await largeFileStamp(path.join(dir, 'absent.sv'))).toBeUndefined();
        expect(await largeFileStamp(large('big.v'))).toMatch(/^\d+:\d+:\d+$/);
    });

    it('asks again after an answer that failed', async () => {
        const file = large('netlist.v');
        let asked = 0;
        const memo = new FileMemo<number>(async () => {
            if (++asked === 1) {
                throw new Error('unreadable');
            }
            return asked;
        });
        await expect(memo.get(file)).rejects.toThrow('unreadable');
        expect(await memo.get(file)).toBe(2);
    });
});
