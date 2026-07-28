/**
 * Platform tool -> diagram-scope MCP tool adapter.
 *
 * A platform chat tool is an in-process, read-only closure the host wants exposed to the agent:
 * `{ name, description, inputSchema, handler(file, args) }`. It carries host-side knowledge the
 * GLSP model does not (e.g. a language registry), so it cannot be expressed as a built-in
 * GModel operation and must be bridged.
 *
 * Each tool becomes a distinct diagram-scope MCP tool handler class (extending the read-only
 * {@link AbstractMcpDiagramToolHandler}). At call time the handler:
 *  - reads `modelState.sourceUri` (the file the GLSP session is scoped to), converts it to an
 *    absolute fsPath, and supplies that as the closure's `file` argument — this is how the
 *    agent's `sessionId` is turned into a file;
 *  - strips the framework-supplied `sessionId` from the args before calling the closure;
 *  - returns the closure's text via `success(...)`.
 *
 * The handler keeps the inherited `readOnlyHint = true`, so the operation-style readonly gate
 * never fires. A distinct subclass is generated per tool because the handler's `name` is a
 * per-instance field — a shared class would collide on `name`.
 */
import { injectable } from 'inversify';
import { URI } from 'vscode-uri';
import {
    AbstractMcpDiagramToolHandler,
    McpDiagramScopedInputSchema,
    type McpDiagramToolHandlerConstructor,
    type McpToolResult
} from '@eclipse-glsp/server-mcp';
import { jsonSchemaToZodShape } from './json-schema-to-zod';

/**
 * Structural shape of an in-process, read-only chat tool bridged into MCP. Mirrors the
 * platform's `InProcessChatTool` without importing it, keeping diagram-server free of an
 * extension-core dependency. `handler` receives the session's scoped file and the tool args.
 */
export interface PlatformMcpTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    handler(file: string, args: Record<string, unknown>): string | Promise<string>;
}

/** Diagram-scope input = the base `{ sessionId }` plus whatever the tool's schema declares. */
type PlatformToolInput = { sessionId: string } & Record<string, unknown>;

/**
 * Build a distinct, DI-decorated diagram-scope MCP tool handler class for a single platform
 * tool. The returned constructor is added to the diagram module's tool-handler multi-binding;
 * the per-session registry resolves it against the live `ClientSession.container`, so the
 * inherited `@inject` fields (`modelState`, `clientId`, ...) are populated.
 */
export function makePlatformToolHandlerClass(tool: PlatformMcpTool): McpDiagramToolHandlerConstructor {
    // Fold the tool's JSON-Schema into the base diagram-scope schema so `sessionId` is present
    // (the launcher dispatcher reads it to route to this session before the handler runs).
    const inputSchema = McpDiagramScopedInputSchema.extend(jsonSchemaToZodShape(tool.inputSchema));

    class PlatformMcpToolHandler extends AbstractMcpDiagramToolHandler<PlatformToolInput> {
        readonly name = tool.name;
        readonly description = tool.description;
        readonly inputSchema = inputSchema;

        protected async createResult(params: PlatformToolInput): Promise<McpToolResult> {
            const sourceUri = this.modelState.sourceUri;
            if (!sourceUri) {
                return this.error(`No source file is associated with session '${params.sessionId}'.`);
            }
            // DECISION (T7): pass the absolute fsPath, NOT the raw `file://` URI. The platform
            // tool contract documents `file` as an absolute path, and host-side tool closures
            // treat it as a real filesystem path (spawning a CLI with `{ file }`, running
            // path.dirname on it, walking parents for a package root). `URI.parse(...).fsPath`
            // is the established conversion everywhere a source path crosses this seam (see the
            // operation handlers' `documentUri` handling). Handing a URI would break that path
            // resolution on POSIX and Windows alike.
            const file = URI.parse(sourceUri).fsPath;
            // Strip the framework-routing sessionId; forward only the tool's own args.
            const { sessionId: _sessionId, ...args } = params;
            const text = await tool.handler(file, args);
            return this.success(text);
        }
    }

    // Apply the DI marker programmatically (not via `@` syntax) so no `design:paramtypes`
    // metadata is emitted for this synthetic subclass — it uses inherited property injection
    // only, and `container.resolve` requires the `@injectable` annotation to be present.
    injectable()(PlatformMcpToolHandler);
    return PlatformMcpToolHandler;
}
