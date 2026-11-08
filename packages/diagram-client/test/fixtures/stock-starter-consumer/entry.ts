// A product's own webview bundle: the stock diagram plus one module of its own,
// laid out as README §4 says (starter first, then GLSP's CSS, the stock CSS and
// the product's).
import { startStockDiagram } from '@dialogram/diagram-client/stock-starter';
import '@eclipse-glsp/vscode-integration-webview/css/glsp-vscode.css';
import '@eclipse-glsp/client/css/grid.css';
import '@vscode/codicons/dist/codicon.css';
import '@dialogram/diagram-client/diagram-client.css';
import './consumer.css';
import { customDemoModule } from '../custom-view-consumer/custom-module';

startStockDiagram({ features: [customDemoModule] });
