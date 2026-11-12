/**
 * Graph-load request-option arg keys and pure option-parsing helpers.
 *
 * Extracted verbatim from `source-model-storage.ts` (the arg consts that used to live at the top
 * of the file, and several of its private parsing helpers). Both `WorkflowSourceModelStorage`
 * (which finishes a load via `finishLoadFromDoc`) and the model source (which acquires the
 * graph via `getGraph`) need these, so they live here as one shared, dependency-free module
 * instead of being duplicated across the model-source seam.
 */

// The source-URI key, shared with the host and the toolkit (see `uri-keys.ts`).
import { WorkflowDiagramConstants, type NodeLine } from '@dialogram/shared';
import { normalizeSourceUriKey } from './uri-keys';
export { normalizeSourceUriKey };

// Request-option arg keys used to pass navigation/runtime context through GLSP RequestModelAction
// options.
export const NAV_TRAIL_ARG = 'wf:navTrail';
export const RUN_ID_ARG = 'wf:runId';
export const RUNTIME_PROFILE_ARG = 'wf:runtimeProfile';
export const GRAPH_SOURCE_URI_ARG = 'cal:graphSourceUri';
export const ROOT_WORKFLOW_ARG = 'cal:rootWorkflow';
export const INSTANCE_PATH_ARG = 'cal:instancePath';
/** The view of the unit to load, when not its structure: a view id the producer
 *  listed on the node (`wf:views`). Carried on the request and echoed on the root. */
export const VIEW_ARG = 'wf:view';

export interface NavigationTrailEntry {
    sourceUri: string;
    workflowName: string;
    workflowInstanceName?: string;
    /** The crumb is a view of the workflow other than its structure. */
    view?: string;
    viewLabel?: string;
    /** The view is of the instance the crumb was reached through (`UnitView.of`). */
    viewOf?: 'instance';
}

/** One view a producer offers of a unit, as `meta.views` lists it. */
export interface UnitView {
    id: string;
    label: string;
    /**
     * `'instance'`: the view is of this instance, not of the definition its
     * file holds under that name. For a unit made per instance (by a factory,
     * with the instance's parameters) the two differ, and the file cannot
     * answer for the instance: the view is asked of the root, by the path of
     * instances that leads to it, as a drill-down into a nested unit is.
     *
     * It is said of a view a node offers (a view of the unit shown, offered
     * on the canvas, is reached through no node), and it is acted on by a
     * model source that can ask a root by a path of instances: one that
     * cannot asks by name, as before.
     */
    of?: 'instance';
}

/** The view id on a request option or root arg, or nothing. */
export function parseViewArg(raw: unknown): string | undefined {
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/** `meta.views` as the producer wrote it: `[{ id, label, of? }]`, else nothing. */
export function parseViewsMeta(raw: unknown): UnitView[] | undefined {
    if (!Array.isArray(raw)) {
        return undefined;
    }
    const out: UnitView[] = [];
    for (const item of raw) {
        const id = typeof item?.id === 'string' ? item.id.trim() : '';
        if (id === '') {
            continue;
        }
        const label = typeof item?.label === 'string' && item.label.trim() !== '' ? item.label.trim() : id;
        out.push({ id, label, ...(item?.of === 'instance' ? { of: 'instance' as const } : {}) });
    }
    return out.length > 0 ? out : undefined;
}

/** One labelled value a producer states about a unit, as `meta.facts` lists it. */
export interface UnitFact {
    label: string;
    value: string;
    markdown?: boolean;
}

/**
 * `meta.facts` as the producer wrote it: `[{ label, value, markdown? }]`, else
 * nothing. An entry without a string label and a string value is dropped
 * rather than failing the list, so one bad row costs the producer that row
 * and not the section; the order of the rest is the producer's.
 */
export function parseFactsMeta(raw: unknown): UnitFact[] | undefined {
    if (!Array.isArray(raw)) {
        return undefined;
    }
    const out: UnitFact[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const { label, value, markdown } = item as Record<string, unknown>;
        if (typeof label !== 'string' || typeof value !== 'string') {
            continue;
        }
        out.push(markdown === true ? { label, value, markdown: true } : { label, value });
    }
    return out.length > 0 ? out : undefined;
}

export type UnitBadgeTone = 'neutral' | 'info' | 'warning' | 'error';

/** One mark on a node's header, as `meta.badges` lists it. */
export interface UnitBadge {
    text: string;
    tone: UnitBadgeTone;
}

const BADGE_TONES: readonly UnitBadgeTone[] = ['neutral', 'info', 'warning', 'error'];

/**
 * `meta.badges` as the producer wrote it: `[{ text, tone? }]`, else nothing.
 * An entry without a non-empty string text is dropped; a tone the platform
 * does not have falls back to `neutral`, since the word on the badge still
 * means something to the reader and the colour was only emphasis.
 */
export function parseBadgesMeta(raw: unknown): UnitBadge[] | undefined {
    if (!Array.isArray(raw)) {
        return undefined;
    }
    const out: UnitBadge[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const { text, tone } = item as Record<string, unknown>;
        if (typeof text !== 'string' || text.trim() === '') {
            continue;
        }
        const resolved = BADGE_TONES.find(candidate => candidate === tone) ?? 'neutral';
        out.push({ text: text.trim(), tone: resolved });
    }
    return out.length > 0 ? out : undefined;
}

/** A class name a producer may give: lower case, digits and dashes, a letter first. */
const CLASS_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * What must not reach a line of text in a node: control characters (raw in
 * an exported SVG they make it no XML), the marks that turn the direction
 * of the text after them, and the spaces of no width.
 */
const NOT_FOR_A_LINE = /[\u0000-\u001f\u007f-\u009f\u200b\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

/** Whether a character takes two columns of a fixed-width font: East Asian wide and fullwidth forms, emoji. */
function isWide(codePoint: number): boolean {
    return (codePoint >= 0x1100 && codePoint <= 0x115f)
        || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
        || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
        || (codePoint >= 0xf900 && codePoint <= 0xfaff)
        || (codePoint >= 0xfe30 && codePoint <= 0xfe4f)
        || (codePoint >= 0xff00 && codePoint <= 0xff60)
        || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
        || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
        || (codePoint >= 0x20000 && codePoint <= 0x3fffd);
}

/** The columns a text takes in a fixed-width font: two for a wide character, one for any other. */
export function textColumns(text: string): number {
    let columns = 0;
    for (const char of text) {
        columns += isWide(char.codePointAt(0)!) ? 2 : 1;
    }
    return columns;
}

/** `text` cut to `max` columns, an ellipsis in the place of what is cut. By character, never through one. */
function cutToColumns(text: string, max: number): string {
    if (textColumns(text) <= max) {
        return text;
    }
    let out = '';
    let columns = 0;
    for (const char of text) {
        const width = isWide(char.codePointAt(0)!) ? 2 : 1;
        if (columns + width > max - 1) {
            break;
        }
        out += char;
        columns += width;
    }
    return `${out.trimEnd()}…`;
}

/**
 * `meta.lines` as the producer wrote it: `[{ text, kind? }]`, a plain string
 * being a line of no kind; nothing for anything else. A line's text is on
 * one line, its spaces single, cut to what a node should hold
 * (`NODE_LINE_MAX_CHARS` columns); a kind that is no class name is dropped,
 * the line kept. No more than `NODE_LINE_MAX_COUNT` lines.
 */
export function parseLinesMeta(raw: unknown): NodeLine[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const out: NodeLine[] = [];
    for (const item of raw) {
        const text = typeof item === 'string' ? item : (item as { text?: unknown } | null)?.text;
        if (typeof text !== 'string') {
            continue;
        }
        const whole = text.replace(NOT_FOR_A_LINE, ' ').replace(/\s+/g, ' ').trim();
        if (whole === '') {
            continue;
        }
        const kind = item && typeof item === 'object' ? (item as { kind?: unknown }).kind : undefined;
        out.push({
            text: cutToColumns(whole, WorkflowDiagramConstants.NODE_LINE_MAX_CHARS),
            ...(typeof kind === 'string' && CLASS_NAME.test(kind) ? { kind } : {})
        });
        if (out.length === WorkflowDiagramConstants.NODE_LINE_MAX_COUNT) {
            break;
        }
    }
    return out;
}

export interface NormalizedGraphLoadError {
    message: string;
    file?: string;
    line?: number;
    column?: number;
    severity?: string;
    code?: string;
}

/** Parse the serialized cross-file breadcrumb trail carried on `wf:navTrail`. */
export function parseNavigationTrailArg(raw: unknown): NavigationTrailEntry[] {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        const out: NavigationTrailEntry[] = [];
        for (const item of parsed) {
            const sourceUri = typeof item?.sourceUri === 'string' ? item.sourceUri.trim() : '';
            const workflowName = typeof item?.workflowName === 'string' ? item.workflowName.trim() : '';
            const workflowInstanceName = typeof item?.workflowInstanceName === 'string'
                ? item.workflowInstanceName.trim()
                : '';
            const view = typeof item?.view === 'string' ? item.view.trim() : '';
            const viewLabel = typeof item?.viewLabel === 'string' ? item.viewLabel.trim() : '';
            const viewOf = item?.viewOf === 'instance' ? { viewOf: 'instance' as const } : {};
            if (sourceUri !== '' && workflowName !== '') {
                out.push({
                    sourceUri: normalizeSourceUriKey(sourceUri),
                    workflowName,
                    ...(workflowInstanceName !== '' ? { workflowInstanceName } : {}),
                    ...(view !== '' ? { view, ...(viewLabel !== '' ? { viewLabel } : {}), ...viewOf } : {})
                });
            }
        }
        return out;
    } catch {
        return [];
    }
}

/** Parse a JSON-serialized (or already-array) list of non-empty strings, e.g. `cal:instancePath`. */
export function parseStringListArg(raw: unknown): string[] {
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed
            .filter((item: unknown): item is string => typeof item === 'string' && item.trim() !== '')
            .map(item => item.trim());
    } catch {
        return [];
    }
}

/** Normalize the loosely-shaped `errors` arrays model-source/CLI payloads carry (flat or nested `location`). */
export function normalizeGraphLoadErrors(raw: unknown): NormalizedGraphLoadError[] {
    if (!Array.isArray(raw)) {
        return [];
    }

    return raw
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
        .map(entry => {
            const message = typeof entry.message === 'string' ? entry.message.trim() : '';
            if (message === '') {
                return undefined;
            }
            // Location is carried either flat (legacy failure-doc) or nested under `location`
            // (model-source contract v2 file-level errors).
            const loc = entry.location && typeof entry.location === 'object' && !Array.isArray(entry.location)
                ? entry.location as Record<string, unknown>
                : entry;
            const file = typeof loc.file === 'string' ? loc.file.trim() : '';
            return {
                message,
                ...(file !== '' ? { file } : {}),
                ...(typeof loc.line === 'number' && Number.isFinite(loc.line) ? { line: loc.line as number } : {}),
                ...(typeof loc.column === 'number' && Number.isFinite(loc.column) ? { column: loc.column as number } : {}),
                ...(typeof entry.severity === 'string' && entry.severity.trim() !== '' ? { severity: entry.severity.trim() } : {}),
                ...(typeof entry.code === 'string' && entry.code.trim() !== '' ? { code: entry.code.trim() } : {})
            };
        })
        .filter((entry): entry is NormalizedGraphLoadError => entry !== undefined);
}

/**
 * Whether the view a request asks for is of the instance it was reached
 * through (the trail's last crumb says so, and it is that view): such a view
 * is asked of the root first, by the instance path (`deriveTrailFallback`).
 *
 * Only when the trail is whole: every crumb under the root reached through
 * an instance. As a last resort after a load that failed, a path with a step
 * missing does no harm; asked first, it would lead to another instance, or
 * to one of the same name higher up, and that answer would be shown.
 */
export function viewIsOfInstance(opts: Record<string, unknown>): boolean {
    const view = parseViewArg(opts[VIEW_ARG]);
    const trail = parseNavigationTrailArg(opts[NAV_TRAIL_ARG]);
    const last = trail[trail.length - 1];
    return view !== undefined && trail.length >= 2 && last.view === view && last.viewOf === 'instance'
        && trail.slice(1).every(crumb => typeof crumb.workflowInstanceName === 'string' && crumb.workflowInstanceName.trim() !== '');
}

/**
 * A request's options with the view its trail ends at, when the request
 * names none and is for that crumb's unit.
 *
 * The client names the view of the trail's last crumb on every request it
 * makes. The host does not: a refresh (a keystroke, a save, a run) repeats
 * the file, the name and the trail, and would bring back the unit's
 * structure under a breadcrumb that still says the view. The trail is what
 * says where the reader is, so it settles what is shown.
 */
export function withTrailView(sourceUri: string, opts: Record<string, unknown>): Record<string, unknown> {
    if (parseViewArg(opts[VIEW_ARG]) !== undefined) {
        return opts;
    }
    const trail = parseNavigationTrailArg(opts[NAV_TRAIL_ARG]);
    const last = trail[trail.length - 1];
    if (!last?.view || last.sourceUri !== normalizeSourceUriKey(sourceUri)) {
        return opts;
    }
    const asked = typeof opts.networkName === 'string' ? opts.networkName.trim() : '';
    if (asked !== '' && asked !== last.workflowName) {
        return opts;
    }
    return { ...opts, [VIEW_ARG]: last.view };
}

/**
 * Derive a graph-source fallback (root workflow file + instance path) from the cross-file
 * breadcrumb trail when the caller didn't explicitly supply `cal:graphSourceUri`.
 */
export function deriveTrailFallback(
    sourceUri: string,
    opts: Record<string, unknown>
): { graphSourceUri: string; rootWorkflowName: string; instancePath: string[] } | undefined {
    if (typeof opts[GRAPH_SOURCE_URI_ARG] === 'string' && String(opts[GRAPH_SOURCE_URI_ARG]).trim() !== '') {
        return undefined;
    }

    const trail = parseNavigationTrailArg(opts[NAV_TRAIL_ARG]);
    if (trail.length < 2) {
        return undefined;
    }

    const root = trail[0];
    const last = trail[trail.length - 1];
    if (!root || !last || last.sourceUri !== normalizeSourceUriKey(sourceUri)) {
        return undefined;
    }

    const instancePath = trail
        .map(entry => typeof entry.workflowInstanceName === 'string' ? entry.workflowInstanceName.trim() : '')
        .filter((entry): entry is string => entry !== '');
    if (instancePath.length === 0) {
        return undefined;
    }

    return {
        graphSourceUri: root.sourceUri,
        rootWorkflowName: root.workflowName,
        instancePath
    };
}

/**
 * Whether a model-source response's "no @network definitions found" (or similar) failure should
 * be retried through the breadcrumb-trail fallback rather than surfaced directly.
 */
export function shouldRetryTrailFallback(
    graphResult: { graph?: Record<string, unknown> },
    opts: Record<string, unknown>
): boolean {
    const hasNetworkName = typeof opts.networkName === 'string' && opts.networkName.trim() !== '';
    if (!hasNetworkName) {
        return false;
    }

    const hasExplicitGraphSource = typeof opts[GRAPH_SOURCE_URI_ARG] === 'string'
        && String(opts[GRAPH_SOURCE_URI_ARG]).trim() !== '';
    const hasExplicitRoot = typeof opts[ROOT_WORKFLOW_ARG] === 'string'
        && String(opts[ROOT_WORKFLOW_ARG]).trim() !== '';
    const hasExplicitInstancePath = parseStringListArg(opts[INSTANCE_PATH_ARG]).length > 0;
    if (hasExplicitGraphSource || (hasExplicitRoot && hasExplicitInstancePath)) {
        return false;
    }

    const graph = graphResult.graph;
    if (!graph || typeof graph !== 'object') {
        return false;
    }

    const errors = normalizeGraphLoadErrors((graph as Record<string, unknown>).errors);
    if (errors.length === 0) {
        return false;
    }

    const errorText = errors
        .map(entry => entry.message.toLowerCase())
        .join(' ');
    return errorText.includes('no @network definitions found')
        || (errorText.includes('network') && errorText.includes('not found'));
}
