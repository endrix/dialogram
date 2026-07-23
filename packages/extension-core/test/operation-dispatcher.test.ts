import { describe, it, expect } from 'vitest';
import { OperationDispatcher } from '../src/extension/operation-dispatcher.js';

describe('OperationDispatcher', () => {
  it('returns an honest failure for unregistered operations (never fakes success)', async () => {
    const d = new OperationDispatcher();
    const result = await d.dispatch('wfpy.autoConnect', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/isn't available/i);
  });

  it('dispatches to a registered handler and returns its result', async () => {
    const d = new OperationDispatcher();
    d.register('wfpy.createNode', async (params) => ({ success: true, message: `made ${params.name}` }));
    const result = await d.dispatch('wfpy.createNode', { name: 'X' });
    expect(result).toEqual({ success: true, message: 'made X' });
  });

  it('surfaces a thrown handler error as a failure', async () => {
    const d = new OperationDispatcher();
    d.register('wfpy.connect', async () => {
      throw new Error('sidecar rejected');
    });
    const result = await d.dispatch('wfpy.connect', {});
    expect(result.success).toBe(false);
    expect(result.error).toBe('sidecar rejected');
  });
});
