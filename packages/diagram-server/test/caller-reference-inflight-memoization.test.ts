// In-flight de-duplication + TTL memoization for the caller-reference ("Used By") walk.
//
// The caller-reference walk is the one O(workspace) traversal reachable from a diagram load. It runs
// off the critical path as deferred discovery. When a diagram opens and the user immediately
// triggers a refresh (e.g. toggling queue-trace visibility) before the first walk resolves, BOTH
// loads see a cold result cache. Without de-duplication each would launch a full parallel walk — two
// simultaneous workspace traversals — which is exactly the open + refresh-queue-visibility overlap
// observed in the field. These tests pin that overlapping cold builds share a single walk, and that
// a subsequent build within the TTL reuses the cached result instead of re-walking.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

interface WalkCounters { collectCalls: number; }

function makeStorage(counters: WalkCounters): any {
    const storage = new (WorkflowSourceModelStorage as any)();
    storage.storageOptions = { settingsNamespace: 'wfLang', operationPrefix: 'wfpy' };
    // Fixed single scan root, so the caller-reference path always reaches the (counted) walk.
    storage.getWorkflowCallerScanRoots = async () => ['/workspace/root'];
    storage.injectedModelSource = {
        analysis: {
            collectSourceFilesUnderRoots: async () => {
                counters.collectCalls += 1;
                // Simulate a non-trivial walk so overlapping callers genuinely race.
                await delay(25);
                return ['/workspace/root/caller.py'];
            },
            discoverCrossFileWorkflowCallers: async () => [
                { sourceUri: 'file:///workspace/root/caller.py', workflowName: 'main' }
            ]
        }
    };
    return storage;
}

const relationshipInfo = { workflowNames: [], entryWorkflowNames: [], callersByWorkflow: {} };

afterEach(() => {
    vi.restoreAllMocks();
});

describe('caller-reference walk memoization', () => {
    it('shares one walk across two overlapping cold-cache builds', async () => {
        const counters: WalkCounters = { collectCalls: 0 };
        const storage = makeStorage(counters);

        const [first, second] = await Promise.all([
            storage.getWorkflowCallerReferences('/workspace/root/wf.py', 'wf', relationshipInfo),
            storage.getWorkflowCallerReferences('/workspace/root/wf.py', 'wf', relationshipInfo)
        ]);

        // Both builds resolve to the same references, but the workspace was walked exactly once.
        expect(counters.collectCalls).toBe(1);
        expect(first).toEqual([{ sourceUri: 'file:///workspace/root/caller.py', workflowName: 'main' }]);
        expect(second).toEqual(first);
    });

    it('reuses the TTL result cache on a subsequent (sequential) build — no re-walk', async () => {
        const counters: WalkCounters = { collectCalls: 0 };
        const storage = makeStorage(counters);

        await storage.getWorkflowCallerReferences('/workspace/root/wf.py', 'wf', relationshipInfo);
        // A later build within the 10s TTL must hit the cache, not the walk.
        await storage.getWorkflowCallerReferences('/workspace/root/wf.py', 'wf', relationshipInfo);

        expect(counters.collectCalls).toBe(1);
    });

    it('clears the in-flight entry once settled so a later cold build can walk again', async () => {
        const counters: WalkCounters = { collectCalls: 0 };
        const storage = makeStorage(counters);

        await storage.getWorkflowCallerReferences('/workspace/root/wf.py', 'wf', relationshipInfo);
        // Force the TTL cache to expire so the next build is genuinely cold again.
        storage.callerReferencesCache.clear();
        await storage.getWorkflowCallerReferences('/workspace/root/wf.py', 'wf', relationshipInfo);

        // The in-flight guard must have been released after the first walk, allowing the second.
        expect(counters.collectCalls).toBe(2);
    });
});
