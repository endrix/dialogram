/**
 * "Show <label>" and "Clear <label>" on the diagram's context menu.
 *
 * The profile's status source is a diagram-wide report, so its items are on
 * the canvas's menu and not on a node's; there are none without a status
 * source; Clear is there only while something is shown, since otherwise it
 * would clear nothing. A click asks the host to run the command, with no
 * argument: the host then acts on the diagram in front of the person.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VscodeUi } from '../src/vscode-ui';
import { showExecutionStates, __resetExecutionStatesForTests } from '../src/execution-states';
import {
    RunStatusCommandAction,
    RunStatusCommandActionHandler,
    StatusSourceContextMenuItemProvider,
    statusSourceMenuItems
} from '../src/status-source-menu';

const SOURCE = { label: 'Coverage', showCommand: 'product.coverage.show', clearCommand: 'product.coverage.clear' };

afterEach(() => {
    __resetExecutionStatesForTests();
    (VscodeUi as any)._instance = undefined;
    delete (globalThis as any).diagramIdentifier;
});

describe('the status items of a right-click', () => {
    it('offer Show on the canvas, in a group of their own', () => {
        expect(statusSourceMenuItems(SOURCE, true, false)).toEqual([{
            id: 'dialogram.statusSource.show',
            label: 'Show Coverage',
            group: 'status',
            sortString: 's0',
            actions: [{ kind: RunStatusCommandAction.KIND, command: 'product.coverage.show' }]
        }]);
    });

    it('offer Clear beside it while states are shown', () => {
        const items = statusSourceMenuItems(SOURCE, true, true);

        expect(items.map(item => item.label)).toEqual(['Show Coverage', 'Clear Coverage']);
        expect(items[1].actions).toEqual([{ kind: RunStatusCommandAction.KIND, command: 'product.coverage.clear' }]);
    });

    it('are not on a node’s menu, nor anywhere without a status source', () => {
        expect(statusSourceMenuItems(SOURCE, false, true)).toEqual([]);
        expect(statusSourceMenuItems(undefined, true, true)).toEqual([]);
    });
});

describe('the menu provider', () => {
    const root = (selected: boolean[]) => ({ index: { all: () => selected.map(isSelected => ({ selected: isSelected })) } });

    it('reads the status source the host declared and whether anything is selected', async () => {
        (globalThis as any).diagramIdentifier = { clientBehavior: { statusSource: SOURCE } };
        const provider = new StatusSourceContextMenuItemProvider();

        expect((await provider.getItems(root([false, false]) as any)).map(item => item.label)).toEqual(['Show Coverage']);
        expect(await provider.getItems(root([false, true]) as any)).toEqual([]);

        showExecutionStates([{ nodeId: 'a', status: 'failed' }]);
        expect((await provider.getItems(root([]) as any)).map(item => item.label)).toEqual(['Show Coverage', 'Clear Coverage']);
    });

    it('offers nothing when the host declared no status source', async () => {
        (globalThis as any).diagramIdentifier = { clientBehavior: {} };

        expect(await new StatusSourceContextMenuItemProvider().getItems(root([]) as any)).toEqual([]);
    });
});

describe('a click on a status item', () => {
    it('asks the host to run its command, with no argument', () => {
        const executeCommand = vi.fn(async () => undefined);
        (VscodeUi as any)._instance = { executeCommand };

        new RunStatusCommandActionHandler().handle(RunStatusCommandAction.create('product.coverage.show') as any);
        new RunStatusCommandActionHandler().handle({ kind: 'somethingElse', command: 'product.coverage.clear' } as any);

        expect(executeCommand.mock.calls).toEqual([['product.coverage.show']]);
    });
});
