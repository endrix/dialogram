/**
 * Tool Palette Item Provider
 *
 * Provides tool palette items for the network diagram editor.
 * Organizes creation tools into categories: Nodes and Connections.
 */

import 'reflect-metadata';

import { injectable, inject, optional } from 'inversify';
import { 
    ToolPaletteItemProvider,
    OperationHandlerRegistry,
    CreateOperationHandler
} from '@eclipse-glsp/server';
import { 
    PaletteItem, 
    Args,
    TriggerNodeCreationAction,
    TriggerEdgeCreationAction,
    CreateNodeOperation,
    CreateEdgeOperation
} from '@eclipse-glsp/protocol';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import { STORAGE_RUNTIME_OPTIONS, type StorageRuntimeOptions } from './storage-runtime-options';

/**
 * Workflow-specific tool palette item provider
 * 
 * Provides a categorized palette with:
 * - Entities (Task, Workflow)
 * - Ports (Input, Output)  
 * - Connections
 */
@injectable()
export class WorkflowToolPaletteItemProvider extends ToolPaletteItemProvider {
    
    @inject(OperationHandlerRegistry)
    protected operationHandlerRegistry!: OperationHandlerRegistry;

    @inject(STORAGE_RUNTIME_OPTIONS)
    @optional()
    protected storageOptions?: StorageRuntimeOptions;

    protected counter = 0;

    override async getItems(_args?: Args): Promise<PaletteItem[]> {
        const useAlternateEntityPalette = this.storageOptions?.useAlternateEntityPalette ?? false;
        const items: PaletteItem[] = [];

        // Create Entities category
        const entityItems: PaletteItem[] = useAlternateEntityPalette
            ? [
                this.createNodeItem(WorkflowDiagramTypes.NODE_TASK, 'Actor', 'Create an Actor instance', 'symbol-class'),
                this.createNodeItem(WorkflowDiagramTypes.NODE_WORKFLOW, 'Network', 'Create a Network instance', 'symbol-namespace')
            ]
            : [
                this.createNodeItem(WorkflowDiagramTypes.NODE_TASK, 'Task', 'Create a Task instance', 'symbol-class'),
                this.createNodeItem(WorkflowDiagramTypes.NODE_EXTERNAL_TASK, 'Tool', 'Create a Tool instance intended for external execution (@tool)', 'link-external'),
                this.createNodeItem(WorkflowDiagramTypes.NODE_EXTERNAL_TASK, 'Agent', 'Create or instantiate an external task annotated with @agent (Copilot/API-backed)', 'wf-agent-icon', { agentTask: true }),
                this.createNodeItem(WorkflowDiagramTypes.NODE_VIEWER_TASK, 'Viewer', 'Create or instantiate an external task annotated with @viewer (opens last-token files)', 'open-preview', { viewerTask: true }),
                this.createNodeItem(WorkflowDiagramTypes.NODE_WORKFLOW, 'Workflow', 'Create a Workflow instance', 'symbol-namespace')
            ];
        
        items.push({
            id: 'palette-entities',
            label: 'Entities',
            sortString: 'A',
            actions: [],
            children: entityItems,
            icon: 'symbol-class'
        });
        
        // Create Ports category
        const portItems: PaletteItem[] = [
            this.createNodeItem(WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, 'Input Port', 'Create a workflow input port', 'arrow-circle-down'),
            this.createNodeItem(WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT, 'Output Port', 'Create a workflow output port', 'arrow-circle-up')
        ];
        
        items.push({
            id: 'palette-ports',
            label: 'Ports',
            sortString: 'B',
            actions: [],
            children: portItems,
            icon: 'plug'
        });
        
        // Create Connections category
        const connectionItems: PaletteItem[] = [
            this.createEdgeItem(WorkflowDiagramTypes.EDGE_CONNECTION, 'Connection', 'Create a connection between ports')
        ];
        
        items.push({
            id: 'palette-connections',
            label: 'Connections',
            sortString: 'C',
            actions: [],
            children: connectionItems,
            icon: 'arrow-right'
        });
        
        return items;
    }
    
    protected createNodeItem(
        elementTypeId: string, 
        label: string, 
        description: string,
        icon?: string,
        args?: Args
    ): PaletteItem {
        const action: TriggerNodeCreationAction = {
            kind: TriggerNodeCreationAction.KIND,
            elementTypeId,
            ...(args ? { args } : {})
        };
        
        return {
            id: `palette-item-${this.counter++}`,
            label,
            sortString: label,
            actions: [action],
            icon
        };
    }
    
    protected createEdgeItem(
        elementTypeId: string, 
        label: string,
        description: string
    ): PaletteItem {
        const action: TriggerEdgeCreationAction = {
            kind: TriggerEdgeCreationAction.KIND,
            elementTypeId
        };
        
        return {
            id: `palette-item-${this.counter++}`,
            label,
            sortString: label,
            actions: [action],
            icon: 'arrow-right'
        };
    }
}
