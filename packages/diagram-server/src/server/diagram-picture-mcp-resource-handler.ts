/**
 * The MCP `diagram-png` tool: a picture of the diagram as the editor draws it.
 *
 * GLSP's own handler sizes the picture from the model, the extent of every
 * positioned element, and asks the client for exactly that width and height.
 * The client draws what is in view (a node out of sight is not drawn), at 1:1,
 * so a picture of that size would be stretched, and a diagram the server holds
 * no bounds for would get none at all. So the client is told only what the
 * caller asked, a width, a height or a scale, and sizes the picture itself
 * (diagram-client `diagram-picture.ts`): the diagram at 1:1, at most 2000 px
 * on its longer side unless a size or scale is given.
 *
 * The diagram is drawn in the editor's webview, which may be in the
 * background, so the client is given longer than GLSP's five seconds.
 */
import { injectable } from 'inversify';
import { RequestExportAction } from '@eclipse-glsp/server';
import {
    DiagramPngMcpResourceHandler,
    McpToolError,
    type DiagramPngInput,
    type McpResourceContent
} from '@eclipse-glsp/server-mcp';

@injectable()
export class DrawnDiagramPngMcpResourceHandler extends DiagramPngMcpResourceHandler {
    protected override readonly defaultTimeoutMs = 15000;

    override readonly description =
        'A PNG picture of the diagram as the editor draws it now: what is in view, with its styling, ' +
        'at 1:1 and at most 2000 px on its longer side. Pass `scale` for a sharper (>1) or smaller (<1) ' +
        'picture, or `width` / `height` to pin its size. Use it to see a layout, or to check what an edit ' +
        'looks like; for the model as text use `diagram-model`, for vector output `diagram-svg`.';

    protected override async createResult({ scale, width, height, timeoutMs }: DiagramPngInput): Promise<McpResourceContent> {
        await this.progress.emit({ progress: 0, message: 'Drawing the diagram…' });
        const response = await this.requestAction(
            // `scale` is the client's to read, past GLSP's PNG options.
            RequestExportAction.create('png', { formatOptions: { width, height, scale } as unknown }),
            timeoutMs ?? this.defaultTimeoutMs
        );
        if (response.encoding !== 'base64') {
            throw new McpToolError(`PNG export returned unexpected encoding '${response.encoding}'; expected 'base64'.`);
        }
        return { blob: response.data };
    }
}
