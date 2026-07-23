import { injectable } from 'inversify';

export interface OperationResult {
  success: boolean;
  message?: string;
  data?: any;
  error?: string;
}

/**
 * Operation Dispatcher for executing edit-backend operations
 * Connects chat intents to edit-backend operations
 */
@injectable()
export class OperationDispatcher {
  private operationHandlers: Map<string, (params: any) => Promise<OperationResult>> = new Map();

  constructor() {
    // No built-in handlers: real operations are registered by the chat backend
    // (wired to the edit backend / diagram commands). Anything left unregistered
    // returns an honest failure from dispatch() rather than faking success —
    // the chat must never claim an edit happened when it didn't.
  }

  /**
   * Register an operation handler
   */
  register(operation: string, handler: (params: any) => Promise<OperationResult>): void {
    this.operationHandlers.set(operation, handler);
  }

  /**
   * Dispatch an operation
   */
  async dispatch(operation: string, params: Record<string, any>): Promise<OperationResult> {
    const handler = this.operationHandlers.get(operation);

    if (!handler) {
      return {
        success: false,
        error: `'${operation}' isn't available from chat in this runtime.`,
      };
    }

    try {
      return await handler(params);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if an operation is registered
   */
  hasOperation(operation: string): boolean {
    return this.operationHandlers.has(operation);
  }

  /**
   * Get all registered operations
   */
  getRegisteredOperations(): string[] {
    return Array.from(this.operationHandlers.keys());
  }
}
