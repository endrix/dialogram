/**
 * Layout Persistence Service
 * 
 * Manages saving and loading node positions from layout files.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Layout file schema version.
 * Bump this when the layout file format changes in an incompatible way.
 */
const LAYOUT_VERSION = 1;

/**
 * Node position in the diagram
 */
export interface NodePosition {
    x: number;
    y: number;
}

/**
 * Layout file content structure
 */
export interface LayoutFileContent {
    version: number;
    /** v1/v2 legacy single-network payload */
    networkId?: string;
    nodes?: Record<string, NodePosition>;
    edges?: Record<string, NodePosition[]>;
    /** v3 payload: per-workflow (networkId) snapshots in one file */
    layouts?: Record<string, {
        nodes: Record<string, NodePosition>;
        edges?: Record<string, NodePosition[]>;
    }>;
}

type LayoutSnapshot = {
    nodes: Record<string, NodePosition>;
    edges?: Record<string, NodePosition[]>;
};

function simplifyRoutePoints(points: NodePosition[]): NodePosition[] {
    if (!Array.isArray(points) || points.length <= 1) {
        return points;
    }

    // Keep this fairly conservative: we want to reduce ELK point explosions and
    // floating point noise without destroying intentional manual bends.
    const eps = 0.5;
    const quant = (n: number): number => Math.round(n / eps) * eps;
    const q = (p: NodePosition): NodePosition => ({ x: quant(p.x), y: quant(p.y) });

    const eq = (a: NodePosition, b: NodePosition): boolean =>
        Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;

    // 1) Quantize and remove consecutive near-duplicates.
    const deduped: NodePosition[] = [];
    for (const raw of points) {
        const p = q(raw);
        if (deduped.length === 0 || !eq(deduped[deduped.length - 1], p)) {
            deduped.push(p);
        }
    }
    if (deduped.length <= 2) {
        return deduped;
    }

    // 2) Remove colinear middle points A->B->C where B lies on line AC.
    const isColinear = (a: NodePosition, b: NodePosition, c: NodePosition): boolean => {
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const bcx = c.x - b.x;
        const bcy = c.y - b.y;
        const cross = abx * bcy - aby * bcx;
        if (Math.abs(cross) > eps) {
            return false;
        }
        // Ensure B is between A and C.
        const acx = c.x - a.x;
        const acy = c.y - a.y;
        const dot = (b.x - a.x) * acx + (b.y - a.y) * acy;
        if (dot < 0) {
            return false;
        }
        const acLen2 = acx * acx + acy * acy;
        return dot <= acLen2;
    };

    const simplified: NodePosition[] = [];
    for (const p of deduped) {
        simplified.push(p);
        while (simplified.length >= 3) {
            const c = simplified[simplified.length - 1];
            const b = simplified[simplified.length - 2];
            const a = simplified[simplified.length - 3];
            if (isColinear(a, b, c)) {
                simplified.splice(simplified.length - 2, 1);
            } else {
                break;
            }
        }
    }

    return simplified;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function normalizeNodePosition(pos: unknown): NodePosition | undefined {
    const x = (pos as any)?.x;
    const y = (pos as any)?.y;
    if (isFiniteNumber(x) && isFiniteNumber(y)) {
        return { x, y };
    }
    return undefined;
}

function normalizeNodePositions(nodes: unknown): Record<string, NodePosition> {
    if (!nodes || typeof nodes !== 'object') {
        return {};
    }
    const result: Record<string, NodePosition> = {};
    for (const [name, pos] of Object.entries(nodes as Record<string, unknown>)) {
        if (typeof name !== 'string' || name.trim() === '') {
            continue;
        }
        const normalized = normalizeNodePosition(pos);
        if (normalized) {
            result[name] = normalized;
        }
    }
    return result;
}

function normalizePoints(points: unknown): NodePosition[] {
    if (!Array.isArray(points)) {
        return [];
    }
    const result: NodePosition[] = [];
    for (const p of points) {
        const x = (p as any)?.x;
        const y = (p as any)?.y;
        if (isFiniteNumber(x) && isFiniteNumber(y)) {
            result.push({ x, y });
        }
    }
    return simplifyRoutePoints(result);
}

/**
 * Service for persisting diagram layout to layout files.
 * Layout is stored in a .layout directory alongside workflow source files.
 */
export class LayoutPersistenceService {
    private pendingSaves = new Map<
        string,
        {
            timeout: NodeJS.Timeout;
            networkId: string;
            positions: Map<string, NodePosition>;
            edgeRoutes?: Map<string, NodePosition[]>;
        }
    >();
    private saveDebounceMs: number;

    // Can be disabled for debugging/benchmarks.
    private readonly disablePersistence = process.env.WORKFLOW_DIAGRAM_DISABLE_PERSISTENCE === '1';

    constructor(saveDebounceMs = 500) {
        this.saveDebounceMs = saveDebounceMs;
    }

    private get disableEdgeRoutePersistence(): boolean {
        return this.disablePersistence || process.env.WORKFLOW_DIAGRAM_DISABLE_EDGE_ROUTE_PERSISTENCE === '1';
    }

    private normalizeLayoutSnapshot(raw: unknown): LayoutSnapshot {
        const r = (raw ?? {}) as Record<string, unknown>;
        const nodes = normalizeNodePositions(r.nodes);
        const edgesRaw = r.edges;
        let edges: Record<string, NodePosition[]> | undefined;
        if (edgesRaw && typeof edgesRaw === 'object' && !this.disableEdgeRoutePersistence) {
            const out: Record<string, NodePosition[]> = {};
            for (const [key, points] of Object.entries(edgesRaw as Record<string, unknown>)) {
                if (typeof key !== 'string' || key.trim() === '') {
                    continue;
                }
                const normalized = normalizePoints(points);
                if (normalized.length > 0) {
                    out[key] = normalized;
                }
            }
            if (Object.keys(out).length > 0) {
                edges = out;
            }
        }
        return { nodes, ...(edges ? { edges } : {}) };
    }

    private normalizeLayoutsFromFile(data: LayoutFileContent): Record<string, LayoutSnapshot> {
        const layouts: Record<string, LayoutSnapshot> = {};

        // Multi-network format (layouts object)
        if (data.layouts && typeof data.layouts === 'object') {
            for (const [networkId, snapshot] of Object.entries(data.layouts)) {
                if (typeof networkId !== 'string' || networkId.trim() === '') {
                    continue;
                }
                layouts[networkId] = this.normalizeLayoutSnapshot(snapshot);
            }
            return layouts;
        }

        // Legacy single-network payload
        if (typeof data.networkId === 'string' && data.networkId.trim() !== '') {
            layouts[data.networkId] = this.normalizeLayoutSnapshot({
                nodes: data.nodes ?? {},
                edges: data.edges
            });
        }

        return layouts;
    }

    private getLayoutDirectoryPath(workflowFilePath: string): string {
        return path.join(path.dirname(workflowFilePath), '.layout');
    }

    /**
     * Get the layout file path for a given CAL source file.
     */
    getLayoutFilePath(workflowFilePath: string): string {
        const base = path.basename(workflowFilePath);
        return path.join(this.getLayoutDirectoryPath(workflowFilePath), `${base}.layout.json`);
    }

    private async readLayoutFile(layoutPath: string): Promise<LayoutFileContent | undefined> {
        try {
            const content = await fs.readFile(layoutPath, 'utf-8');
            return JSON.parse(content) as LayoutFileContent;
        } catch {
            return undefined;
        }
    }

    /**
     * Previous layout file paths for backward compatibility.
     */
    private getLegacyLayoutFilePaths(workflowFilePath: string): string[] {
        const dir = path.dirname(workflowFilePath);
        const base = path.basename(workflowFilePath);
        return [
            path.join(dir, `.${base}.layout.json`),
            `${workflowFilePath}.layout.json`
        ];
    }

    private async readAnyLayoutFile(workflowFilePath: string): Promise<LayoutFileContent | undefined> {
        const candidatePaths = [
            this.getLayoutFilePath(workflowFilePath),
            ...this.getLegacyLayoutFilePaths(workflowFilePath)
        ];

        for (const candidatePath of candidatePaths) {
            const data = await this.readLayoutFile(candidatePath);
            if (data) {
                return data;
            }
        }

        return undefined;
    }

    /**
     * Load layout positions for a network from the layout file.
     * Returns undefined if file doesn't exist or is invalid.
     */
    async loadLayout(workflowFilePath: string, networkId: string): Promise<Map<string, NodePosition> | undefined> {
        if (this.disablePersistence) {
            return undefined;
        }

        // Check pending saves first to avoid race conditions (e.g. read-after-write within debounce window)
        const layoutPath = this.getLayoutFilePath(workflowFilePath);
        const pending = this.pendingSaves.get(layoutPath);
        if (pending && pending.networkId === networkId) {
            return new Map(pending.positions);
        }

        const snapshot = await this.loadLayoutSnapshot(workflowFilePath, networkId);
        if (!snapshot) {
            return undefined;
        }

        const positions = new Map<string, NodePosition>();
        const normalizedNodes = normalizeNodePositions(snapshot.nodes);
        for (const [name, pos] of Object.entries(normalizedNodes)) {
            positions.set(name, pos);
        }
        return positions;
    }

    /**
     * Load persisted edge routing points for a network, if present.
     */
    async loadEdgeRoutes(workflowFilePath: string, networkId: string): Promise<Map<string, NodePosition[]> | undefined> {
        if (this.disableEdgeRoutePersistence) {
            return undefined;
        }

        const layoutPath = this.getLayoutFilePath(workflowFilePath);
        const pending = this.pendingSaves.get(layoutPath);
        
        if (pending && pending.networkId === networkId && pending.edgeRoutes) {
             return new Map(pending.edgeRoutes);
        }
        
        // If pending exists but has no routes, it implies "preserve disk routes", so we fall through to read disk.
        // However, if we just want routes, checking disk is safe unless we deleted them?
        // Wait, if pending.edgeRoutes is undefined, it means "unchanged". 
        // If pending.edgeRoutes IS defined (e.g. empty map), we returned it above.
        
        const snapshot = await this.loadLayoutSnapshot(workflowFilePath, networkId);
        if (!snapshot || !snapshot.edges) {
            return undefined;
        }
        const routes = new Map<string, NodePosition[]>();
        for (const [key, points] of Object.entries(snapshot.edges)) {
            const normalized = normalizePoints(points);
            if (normalized.length > 0) {
                routes.set(key, normalized);
            }
        }
        return routes.size > 0 ? routes : undefined;
    }

    /**
     * Save layout positions for a network.
     * Debounces saves to avoid excessive writes.
     */
    saveLayout(
        workflowFilePath: string,
        networkId: string,
        positions: Map<string, NodePosition>,
        edgeRoutes?: Map<string, NodePosition[]>
    ): void {
        if (this.disablePersistence) {
            return;
        }

        const layoutPath = this.getLayoutFilePath(workflowFilePath);

        // Cancel any pending save for this file
        const pending = this.pendingSaves.get(layoutPath);
        if (pending) {
            clearTimeout(pending.timeout);
        }

        const positionsSnapshot = new Map(positions);
        const edgeRoutesSnapshot = edgeRoutes ? new Map(edgeRoutes) : undefined;

        // Schedule debounced save
        const timeout = setTimeout(async () => {
            const current = this.pendingSaves.get(layoutPath);
            this.pendingSaves.delete(layoutPath);
            await this.doSave(
                layoutPath,
                current?.networkId ?? networkId,
                current?.positions ?? positionsSnapshot,
                current?.edgeRoutes ?? edgeRoutesSnapshot
            );
        }, this.saveDebounceMs);

        this.pendingSaves.set(layoutPath, {
            timeout,
            networkId,
            positions: positionsSnapshot,
            // Preserve pending edgeRoutes when only positions are updated.
            edgeRoutes: edgeRoutesSnapshot ?? pending?.edgeRoutes,
        });
    }

    /**
     * Immediately save layout (no debounce).
     */
    async saveLayoutImmediate(
        workflowFilePath: string,
        networkId: string,
        positions: Map<string, NodePosition>,
        edgeRoutes?: Map<string, NodePosition[]>
    ): Promise<void> {
        if (this.disablePersistence) {
            return;
        }

        const layoutPath = this.getLayoutFilePath(workflowFilePath);
        
        // Cancel any pending debounced save
        const pending = this.pendingSaves.get(layoutPath);
        if (pending) {
            clearTimeout(pending.timeout);
            this.pendingSaves.delete(layoutPath);
        }

        await this.doSave(layoutPath, networkId, positions, edgeRoutes);
    }

    private async doSave(
        layoutPath: string,
        networkId: string,
        positions: Map<string, NodePosition>,
        edgeRoutes?: Map<string, NodePosition[]>
    ): Promise<void> {
        const nodes: Record<string, NodePosition> = {};
        for (const [name, pos] of positions) {
            if (typeof name !== 'string' || name.trim() === '') {
                continue;
            }
            const normalized = normalizeNodePosition(pos);
            if (normalized) {
                nodes[name] = normalized;
            }
        }

        // Load existing per-network snapshots so we can merge and preserve layouts for other workflows.
        const workflowDir = path.dirname(layoutPath);
        const sourceBaseName = path.basename(layoutPath, '.layout.json');
        const workflowFilePath = path.join(path.dirname(workflowDir), sourceBaseName);

        let existingLayouts: Record<string, LayoutSnapshot> = {};
        const existing = await this.readAnyLayoutFile(workflowFilePath);
        if (existing) {
            existingLayouts = this.normalizeLayoutsFromFile(existing);
        }

        // Preserve existing persisted edge routes for this network when only updating positions.
        let preservedEdges: Record<string, NodePosition[]> | undefined;
        if (!edgeRoutes && !this.disableEdgeRoutePersistence) {
            preservedEdges = existingLayouts[networkId]?.edges;
        }

        let edges: Record<string, NodePosition[]> | undefined;
        if (this.disableEdgeRoutePersistence) {
            edges = undefined;
        } else if (edgeRoutes) {
            const sanitized: Record<string, NodePosition[]> = {};
            for (const [key, points] of edgeRoutes.entries()) {
                const normalized = normalizePoints(points);
                if (typeof key === 'string' && key.trim() !== '' && normalized.length > 0) {
                    sanitized[key] = normalized;
                }
            }
            if (Object.keys(sanitized).length > 0) {
                edges = sanitized;
            }
        } else if (preservedEdges) {
            // `preservedEdges` already went through normalizePoints() (and thus simplification).
            edges = preservedEdges;
        }

        const mergedLayouts: Record<string, LayoutSnapshot> = {
            ...existingLayouts,
            [networkId]: {
                nodes,
                ...(edges ? { edges } : {})
            }
        };

        const content: LayoutFileContent = {
            version: LAYOUT_VERSION,
            layouts: mergedLayouts
        };

        try {
            await fs.mkdir(path.dirname(layoutPath), { recursive: true });
            await fs.writeFile(layoutPath, JSON.stringify(content, null, 2), 'utf-8');
        } catch (error) {
            console.error(`Failed to save layout file: ${layoutPath}`, error);
        }
    }

    /**
     * Rename a node in the layout (e.g., when entity is renamed).
     */
    async renameNode(
        workflowFilePath: string,
        networkId: string,
        oldName: string,
        newName: string
    ): Promise<void> {
        const positions = await this.loadLayout(workflowFilePath, networkId);
        if (positions) {
            const pos = positions.get(oldName);
            if (pos) {
                positions.delete(oldName);
                positions.set(newName, pos);
                this.saveLayout(workflowFilePath, networkId, positions);
            }
        }
    }

    private async loadLayoutSnapshot(workflowFilePath: string, networkId: string): Promise<LayoutSnapshot | undefined> {
        const data = await this.readAnyLayoutFile(workflowFilePath);
        if (!data) {
            return undefined;
        }
        const layouts = this.normalizeLayoutsFromFile(data);
        return layouts[networkId];
    }
}
