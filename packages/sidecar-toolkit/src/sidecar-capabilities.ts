/**
 * Sidecar capability discovery (contract v2).
 *
 * Queries a language sidecar's `getCapabilities` op once and caches the result,
 * so the IDE can adapt to what each runtime actually supports instead of
 * hardcoding per-profile op names. See `docs/sidecar-contract-v2.md`.
 *
 * Both sidecars are supported transparently:
 *  - v2 flat shape: `diagnostic.{protocolVersion, supportedOps[(bare canonical)], features}`.
 *  - legacy nested shape: `diagnostic.capabilities.{supportedOps[(prefixed)], …}` —
 *    the `<prefix>.` is stripped and legacy names are folded to canonical.
 */

import { invokeSidecarOp } from './sidecar-graph-export.js';

export interface SidecarCapabilities {
  /** Contract protocol version (1 = legacy, 2 = canonical). */
  protocolVersion: number;
  /** Canonical, bare (no-prefix) op names the sidecar actually handles. */
  supportedOps: Set<string>;
  /** Declared feature flags (sourceTruthEdits, stableIds, checkConnection, …). */
  features: Record<string, boolean>;
}

interface CapabilityQueryOptions {
  sidecarCommand: string;
  sidecarOperationPrefix: string;
}

/** Legacy → canonical op name folding (mirrors each sidecar's own alias map). */
const LEGACY_TO_CANONICAL: Record<string, string> = {
  exportWorkflowGraph: 'exportGraph',
  exportNetworkGraph: 'exportGraph',
  connectPorts: 'connect',
  renameActor: 'renameNode',
  protocolContracts: 'getCapabilities',
};

function canonicalize(op: string, prefix: string): string {
  let bare = op.startsWith(`${prefix}.`) ? op.slice(prefix.length + 1) : op;
  // Defensive: strip any `<word>.` prefix even if it isn't the configured one.
  const dot = bare.indexOf('.');
  if (dot >= 0) bare = bare.slice(dot + 1);
  return LEGACY_TO_CANONICAL[bare] ?? bare;
}

const cache = new Map<string, Promise<SidecarCapabilities | undefined>>();

function cacheKey(options: CapabilityQueryOptions): string {
  return `${options.sidecarOperationPrefix}::${options.sidecarCommand}`;
}

/** Parse a getCapabilities response (either contract shape) into the normalized form. */
export function parseCapabilitiesDiagnostic(diagnostic: any, prefix: string): SidecarCapabilities | undefined {
  if (!diagnostic || typeof diagnostic !== 'object') return undefined;
  const flatOps = Array.isArray(diagnostic.supportedOps) ? diagnostic.supportedOps : undefined;
  const nested = diagnostic.capabilities && typeof diagnostic.capabilities === 'object' ? diagnostic.capabilities : undefined;
  const rawOps: unknown[] = flatOps ?? (Array.isArray(nested?.supportedOps) ? nested.supportedOps : []);
  if (!rawOps.length) return undefined;
  const supportedOps = new Set(rawOps.map((o) => canonicalize(String(o), prefix)));
  const features =
    diagnostic.features && typeof diagnostic.features === 'object'
      ? (diagnostic.features as Record<string, boolean>)
      : {};
  const protocolVersion =
    typeof diagnostic.protocolVersion === 'number'
      ? diagnostic.protocolVersion
      : typeof nested?.sidecarProtocolVersion === 'number'
        ? nested.sidecarProtocolVersion
        : 1;
  return { protocolVersion, supportedOps, features };
}

/**
 * Query (and cache) the capabilities of the sidecar for a workflow file. Never
 * throws; returns undefined if the sidecar is unavailable or pre-v2 (no
 * getCapabilities). Cached per (prefix, sidecarCommand) since capabilities are a
 * property of the binary, not the file.
 */
export function getSidecarCapabilities(
  filePath: string,
  options: CapabilityQueryOptions
): Promise<SidecarCapabilities | undefined> {
  const key = cacheKey(options);
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = (async () => {
    try {
      const res = await invokeSidecarOp(filePath, options, 'getCapabilities', {});
      if (!res.ok || !res.response) return undefined;
      return parseCapabilitiesDiagnostic(res.response.diagnostic, options.sidecarOperationPrefix);
    } catch {
      return undefined;
    }
  })();
  cache.set(key, pending);
  return pending;
}

/**
 * Whether the sidecar supports a canonical op. Defaults to `true` when
 * capabilities are unknown (pre-v2 sidecar) so behavior is never *more*
 * restrictive than before discovery existed.
 */
export async function sidecarSupportsOp(
  filePath: string,
  options: CapabilityQueryOptions,
  canonicalOp: string
): Promise<boolean> {
  const caps = await getSidecarCapabilities(filePath, options);
  if (!caps) return true;
  return caps.supportedOps.has(canonicalOp);
}

/** Clear the capability cache (e.g. after a sidecar command setting change). */
export function clearSidecarCapabilitiesCache(): void {
  cache.clear();
}
