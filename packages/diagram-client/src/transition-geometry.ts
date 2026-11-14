/**
 * The shape of a transition of an automaton, from where its two states are.
 *
 * The arithmetic is in the shared package (`transition-geometry.ts` there),
 * because the server lays an automaton out with it too; this module keeps the
 * client's names for it.
 */
export {
    leaveState,
    transitionBetween,
    transitionStub,
    transitionLoop,
    loopDirection,
    curveAt,
    boxesCrossed,
    transitionAround,
    labelCandidates,
    labelBlockAt,
    overlapArea,
    placeLabelBlocks,
    labelLineBox,
    unionBox,
    type GeometryBox as Box,
    type GeometryPoint as Point,
    type TransitionShape,
    type LabelCandidate,
    type LabelBlock
} from '@dialogram/shared';
