/**
 * @dialogram/shared
 *
 * Types, constants, and binding keys shared between
 * diagram-server (Node/extension host) and diagram-client (browser/webview).
 */

export * from './diagram-types';
export * from './diagram-constants';
export * from './port-anchor';
export * from './port-stub';
export * from './boundary-port-geometry';
export * from './binding-keys';
export * from './diagram-seams';
export * from './node-family';
export * from './loading';
export * from './hierarchy';
export * from './outline-pages';
export * from './chat-seams';
export * from './create-task-type-operation';
export * from './client-behavior';
export * from './view-options';
export * from './command-ids';
export * from './chat-tools';
export * from './entity-names';
export * from './clipboard-payload';
export * from './port-bus';
export * from './header-lines';
export * from './node-summary';
export * from './port-label-geometry';
export * from './symbol-geometry';
export * from './node-open';
export * from './node-actions';
export * from './transition-label';
export * from './prompt-words';
// The shapes of an automaton's transitions; `Box` and `Point` under names
// that say whose they are.
export {
    leaveState,
    transitionBetween,
    transitionStub,
    transitionLoop,
    loopDirection,
    curveAt,
    curveSamples,
    boxesCrossed,
    transitionAround,
    labelCandidates,
    stubLabelCandidates,
    labelBlockAt,
    overlapArea,
    placeLabelBlocks,
    labelLineBox,
    unionBox,
    type Box as GeometryBox,
    type Point as GeometryPoint,
    type TransitionShape,
    type LabelCandidate,
    type LabelBlock
} from './transition-geometry';
export * from './automaton-geometry';
