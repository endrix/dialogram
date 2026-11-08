/**
 * Sidecar requests for a source file by path, with the file's Python package
 * on `PYTHONPATH`: what the chat's edit backend, the registry tools, the
 * openability probe and the capability query send through. The diagram's own
 * edits go through `SidecarInvoker`, which resolves the command from the
 * model's source URI and sends through the same transport.
 */
import { invokeSidecar, type SidecarOpResult } from './sidecar-transport.js';

export type { SidecarOpResult };

/**
 * Send `<prefix>.<opName>` for `filePath`. The sidecar validates the request
 * and, for an edit, writes the source file; it answers `{ status, ... }`.
 * Never throws.
 */
export async function invokeSidecarOp(
  filePath: string,
  options: { sidecarCommand: string; sidecarOperationPrefix: string; timeoutMs?: number },
  opName: string,
  args: Record<string, unknown>
): Promise<SidecarOpResult> {
  return invokeSidecar({
    command: options.sidecarCommand,
    file: filePath,
    op: `${options.sidecarOperationPrefix}.${opName}`,
    args,
    timeoutMs: options.timeoutMs,
    pythonPackageRoot: true
  });
}
