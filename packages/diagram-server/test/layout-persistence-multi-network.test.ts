import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LayoutPersistenceService } from '../src/services/layout-persistence-service';

const tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

describe('LayoutPersistenceService multi-network support', () => {
    it('persists and reloads layouts for multiple workflows in the same file', async () => {
        const root = await mkTempDir('wf-layout-multi-');
        const wfFile = path.join(root, 'nested.py');
        await fs.writeFile(wfFile, '# multi-workflow stub\n', 'utf-8');

        const svc = new LayoutPersistenceService(0);

        await svc.saveLayoutImmediate(
            wfFile,
            'demo__A',
            new Map([
                ['/namespaces@0/workflows@0/entities@0', { x: 10, y: 20 }]
            ])
        );

        await svc.saveLayoutImmediate(
            wfFile,
            'demo__B',
            new Map([
                ['/namespaces@0/workflows@1/entities@0', { x: 110, y: 220 }]
            ])
        );

        const a = await svc.loadLayout(wfFile, 'demo__A');
        const b = await svc.loadLayout(wfFile, 'demo__B');

        expect(a?.get('/namespaces@0/workflows@0/entities@0')).toEqual({ x: 10, y: 20 });
        expect(b?.get('/namespaces@0/workflows@1/entities@0')).toEqual({ x: 110, y: 220 });

        const layoutPath = svc.getLayoutFilePath(wfFile);
        expect(layoutPath).toBe(path.join(root, '.layout', 'nested.py.layout.json'));
        await expect(fs.access(layoutPath)).resolves.toBeUndefined();
    });

    it('loads legacy sidecar files and rewrites into the .layout directory', async () => {
        const root = await mkTempDir('wf-layout-legacy-');
        const wfFile = path.join(root, 'legacy.py');
        await fs.writeFile(wfFile, '# legacy workflow stub\n', 'utf-8');

        const legacyPath = path.join(root, '.legacy.py.layout.json');
        await fs.writeFile(
            legacyPath,
            JSON.stringify({
                version: 1,
                layouts: {
                    demo__A: {
                        nodes: {
                            '/namespaces@0/workflows@0/entities@0': { x: 5, y: 15 }
                        }
                    },
                    demo__B: {
                        nodes: {
                            '/namespaces@0/workflows@1/entities@0': { x: 25, y: 35 }
                        }
                    }
                }
            }, null, 2),
            'utf-8'
        );

        const svc = new LayoutPersistenceService(0);

        const loaded = await svc.loadLayout(wfFile, 'demo__B');
        expect(loaded?.get('/namespaces@0/workflows@1/entities@0')).toEqual({ x: 25, y: 35 });

        await svc.saveLayoutImmediate(
            wfFile,
            'demo__A',
            new Map([
                ['/namespaces@0/workflows@0/entities@0', { x: 50, y: 60 }]
            ])
        );

        const migratedPath = svc.getLayoutFilePath(wfFile);
        const migratedRaw = await fs.readFile(migratedPath, 'utf-8');
        const migrated = JSON.parse(migratedRaw) as {
            layouts: Record<string, { nodes: Record<string, { x: number; y: number }> }>;
        };

        expect(migrated.layouts.demo__A.nodes['/namespaces@0/workflows@0/entities@0']).toEqual({ x: 50, y: 60 });
        expect(migrated.layouts.demo__B.nodes['/namespaces@0/workflows@1/entities@0']).toEqual({ x: 25, y: 35 });
    });
});
