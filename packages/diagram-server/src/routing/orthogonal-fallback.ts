export type WorkflowPoint = { x: number; y: number };

function stableIntHash(text: string): number {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
        h = (h * 31 + text.charCodeAt(i)) | 0;
    }
    return h;
}

function laneJitterPx(routingKey: string): number {
    // IMPORTANT: derived from a key that differentiates *ports* (e.g. source port id).
    // Using edge ids is unreliable because many ids share prefixes and can hash-collide.
    const h = Math.abs(stableIntHash(routingKey));
    // Stable jitter in multiples of 4px, roughly in [-48, 48].
    return Math.round(((((h % 1000) / 1000) - 0.5) * 96) / 4) * 4;
}

export function snapToOrthogonalPath(start: WorkflowPoint, end: WorkflowPoint, routingKey: string): WorkflowPoint[] {
    const sx = start.x;
    const sy = start.y;
    const tx = end.x;
    const ty = end.y;

    const jitter = laneJitterPx(routingKey);

    if (sx <= tx) {
        const minX = Math.min(sx, tx) + 20;
        const maxX = Math.max(sx, tx) - 20;
        const unclampedMidX = sx + (tx - sx) / 2 + jitter;
        const midX = Math.min(Math.max(unclampedMidX, minX), maxX);
        return [
            { x: sx, y: sy },
            { x: midX, y: sy },
            { x: midX, y: ty },
            { x: tx, y: ty }
        ];
    }

    const detour = 30;
    const outX = sx + detour + jitter;
    return [
        { x: sx, y: sy },
        { x: outX, y: sy },
        { x: outX, y: ty },
        { x: tx, y: ty }
    ];
}
