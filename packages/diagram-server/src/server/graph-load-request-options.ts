/**
 * Graph-load request-option arg keys and pure option-parsing helpers.
 *
 * Extracted verbatim from `source-model-storage.ts` (the arg consts that used to live at the top
 * of the file, and several of its private parsing helpers). Both `WorkflowSourceModelStorage`
 * (which finishes a load via `finishLoadFromDoc`) and the model source (which acquires the
 * graph via `getGraph`) need these, so they live here as one shared, dependency-free module
 * instead of being duplicated across the model-source seam.
 */

import * as path from 'node:path';
import { URI } from 'vscode-uri';

/**
 * Normalize a source URI to a canonical key (absolute, scheme-normalized, no query/fragment).
 * Small pure helper kept local to this module so it has no dependency on the language-specific
 * source-analysis module (which now lives in the language toolkit).
 */
export function normalizeSourceUriKey(value: string): string {
    const trimmed = value.trim();
    if (trimmed === '') {
        return trimmed;
    }
    try {
        const uri = URI.parse(trimmed);
        if (uri.scheme === 'file') {
            const normalizedFsPath = path.resolve(uri.fsPath);
            return URI.file(normalizedFsPath).toString();
        }
        return uri.with({ query: '', fragment: '' }).toString();
    } catch {
        return trimmed;
    }
}

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
}

/** One view a producer offers of a unit, as `meta.views` lists it. */
export interface UnitView {
    id: string;
    label: string;
}

/** The view id on a request option or root arg, or nothing. */
export function parseViewArg(raw: unknown): string | undefined {
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/** `meta.views` as the producer wrote it: `[{ id, label }]`, else nothing. */
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
        out.push({ id, label });
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
            if (sourceUri !== '' && workflowName !== '') {
                out.push({
                    sourceUri: normalizeSourceUriKey(sourceUri),
                    workflowName,
                    ...(workflowInstanceName !== '' ? { workflowInstanceName } : {}),
                    ...(view !== '' ? { view, ...(viewLabel !== '' ? { viewLabel } : {}) } : {})
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
