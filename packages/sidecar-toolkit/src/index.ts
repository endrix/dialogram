/**
 * The toolkit's public surface: the one-call profile assembler and the types a
 * product needs to author its `SidecarProfileInput` literal. Everything else is
 * internal to the toolkit (tests import modules by path).
 */
export {
    createSidecarDiagramProfile,
    type SidecarProfileInput,
    type SidecarDialogramApi
} from './sidecar-diagram-profile.js';

export {
    type SidecarStatusSourceInput,
    type StatusCli
} from './cli-status-source.js';

export {
    type DiagramOpenabilityPredicate
} from './diagram-openability.js';

export {
    type CreateNodeStrings,
    type CreateNodeBehavior,
    type CreateNodeVariant,
    type CreateNodeVariantCandidate,
    type CreateNodeVariantChoice,
    type CreateNodeVariantFollowUp,
    type CreateNodeVariantPick,
    type CreateNodeVariantInput,
    type CreateNodeVariantTarget,
    type CreateNodeTypeKind
} from './server/sidecar-runtime-config.js';

export { type RunQuestion, type RunAnswer } from './cli-run-driver.js';
