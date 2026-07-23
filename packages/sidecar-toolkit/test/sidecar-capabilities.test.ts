import { describe, it, expect } from 'vitest';
import { parseCapabilitiesDiagnostic } from '../src/sidecar-capabilities.js';

describe('parseCapabilitiesDiagnostic', () => {
  it('parses the v2 flat shape (wfpy) with bare canonical ops', () => {
    const caps = parseCapabilitiesDiagnostic(
      {
        protocolVersion: 2,
        supportedOps: ['exportGraph', 'createNode', 'connect', 'getCapabilities'],
        features: { sourceTruthEdits: true, controlFlow: true },
      },
      'wfpy'
    );
    expect(caps?.protocolVersion).toBe(2);
    expect(caps?.supportedOps.has('exportGraph')).toBe(true);
    expect(caps?.supportedOps.has('connect')).toBe(true);
    expect(caps?.features.controlFlow).toBe(true);
  });

  it('parses the calpy flat shape and folds legacy aliases to canonical', () => {
    const caps = parseCapabilitiesDiagnostic(
      {
        protocolVersion: 2,
        supportedOps: ['exportGraph', 'connect', 'createNode'],
        features: { sourceTruthEdits: false, stableIds: true },
        capabilities: { sidecarProtocolVersion: 1, supportedOps: ['calpy.connectPorts'] },
      },
      'calpy'
    );
    // Flat list is preferred; connect already canonical.
    expect(caps?.supportedOps.has('connect')).toBe(true);
    expect(caps?.features.stableIds).toBe(true);
  });

  it('falls back to the legacy nested shape and strips the prefix + folds aliases', () => {
    const caps = parseCapabilitiesDiagnostic(
      {
        capabilities: {
          sidecarProtocolVersion: 1,
          supportedOps: ['calpy.exportNetworkGraph', 'calpy.connectPorts', 'calpy.createNode', 'calpy.renameActor'],
        },
      },
      'calpy'
    );
    expect(caps?.protocolVersion).toBe(1);
    expect(caps?.supportedOps.has('exportGraph')).toBe(true); // exportNetworkGraph → exportGraph
    expect(caps?.supportedOps.has('connect')).toBe(true); // connectPorts → connect
    expect(caps?.supportedOps.has('renameNode')).toBe(true); // renameActor → renameNode
    expect(caps?.supportedOps.has('createNode')).toBe(true);
    expect(caps?.features).toEqual({});
  });

  it('returns undefined when no ops are advertised', () => {
    expect(parseCapabilitiesDiagnostic({}, 'wfpy')).toBeUndefined();
    expect(parseCapabilitiesDiagnostic(undefined, 'wfpy')).toBeUndefined();
  });
});
