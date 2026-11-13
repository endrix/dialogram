/**
 * The label of a transition of an automaton, as the server sizes it and the
 * client draws it: an order badge when the transition has a place in its
 * state's order, the text, a mark when it has a condition, and the tokens its
 * action takes and gives, as the producer writes them, when it says.
 *
 *     (2) row_col ◆ In×384 → Out
 *
 * The server knows no font, so the text's width is an estimate, as a node's
 * name's is; the mark is drawn where the text ends, whatever its real width.
 */
import { WorkflowDiagramConstants } from './diagram-constants';

/** What one character of a label takes, on average, at the label's size. */
const CHAR_WIDTH = 0.58;

/** Where the text of a label starts, from the label's left. */
export function transitionLabelTextX(hasOrder: boolean): number {
    return hasOrder ? WorkflowDiagramConstants.TRANSITION_ORDER_BADGE_PX + WorkflowDiagramConstants.TRANSITION_LABEL_GAP_PX : 0;
}

/** How wide a label is taken to be. */
export function transitionLabelWidth(text: string, hasOrder: boolean, hasCondition: boolean, tokens = ''): number {
    const k = WorkflowDiagramConstants;
    const textWidth = Math.ceil(text.length * k.TRANSITION_LABEL_FONT_SIZE_PX * CHAR_WIDTH);
    const mark = hasCondition ? k.TRANSITION_LABEL_GAP_PX + k.TRANSITION_CONDITION_MARK_PX : 0;
    const said = tokens === '' ? 0 : k.TRANSITION_TOKENS_GAP_PX + Math.ceil(tokens.length * k.TRANSITION_LABEL_FONT_SIZE_PX * CHAR_WIDTH);
    return transitionLabelTextX(hasOrder) + textWidth + mark + said;
}

/** How wide a state is drawn for its name. */
export function stateWidth(name: string): number {
    const textWidth = Math.ceil(name.length * WorkflowDiagramConstants.STATE_LABEL_FONT_SIZE_PX * 0.62);
    return name === ''
        ? WorkflowDiagramConstants.STATE_MIN_WIDTH_PX
        : Math.max(WorkflowDiagramConstants.STATE_MIN_WIDTH_PX, textWidth + 2 * WorkflowDiagramConstants.STATE_LABEL_PADDING_PX);
}

/** One step of the run a state stands for: an action, taken `count` times in a row. */
export interface StateStep {
    action: string;
    count: number;
}

/** How a step is written: the action, and how many times when more than once. */
export function stateStepText(step: StateStep): string {
    return step.count > 1 ? `${step.action} \u00d7${step.count}` : step.action;
}

/** How big a state that stands for a run is drawn: its name, then one line per step. */
export function stateSize(name: string, steps: readonly StateStep[] | undefined): { width: number; height: number } {
    const k = WorkflowDiagramConstants;
    if (!steps || steps.length === 0) {
        return { width: stateWidth(name), height: k.STATE_HEIGHT_PX };
    }
    const widest = Math.max(...steps.map(step => Math.ceil(stateStepText(step).length * k.STATE_STEP_FONT_SIZE_PX * 0.6)));
    return {
        width: Math.max(stateWidth(name), widest + 2 * k.STATE_LABEL_PADDING_PX),
        height: k.STATE_HEIGHT_PX + steps.length * k.STATE_STEP_HEIGHT_PX + k.STATE_STEPS_BOTTOM_PX
    };
}

/** How wide the chip at the end of a stub is, for the name of the state it leads to. */
export function stubChipWidth(name: string): number {
    return Math.ceil(name.length * WorkflowDiagramConstants.TRANSITION_LABEL_FONT_SIZE_PX * CHAR_WIDTH) + 12;
}
