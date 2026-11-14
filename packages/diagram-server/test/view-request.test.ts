/**
 * What a view was asked of its producer by, kept on the root so that an edit
 * made in the view names the same thing: the unit's name and the view, and
 * for a view of an instance the root and the path of instances to it, from
 * the file asked.
 */
import { describe, expect, it } from 'vitest';
import {
    GRAPH_SOURCE_URI_ARG,
    INSTANCE_PATH_ARG,
    ROOT_WORKFLOW_ARG,
    VIEW_ARG,
    viewRequestOf
} from '../src/server/graph-load-request-options';

describe('what a view was asked for by', () => {
    it('is the unit and the view, by name', () => {
        expect(viewRequestOf({ networkName: ' Counter ', [VIEW_ARG]: 'actor' })).toEqual({ networkName: 'Counter', view: 'actor' });
        expect(viewRequestOf({})).toEqual({});
    });

    it('is the root, the path of instances and the file asked, for a view of an instance', () => {
        expect(viewRequestOf({
            networkName: 'Gate',
            [VIEW_ARG]: 'actor-instance',
            [ROOT_WORKFLOW_ARG]: 'top',
            [INSTANCE_PATH_ARG]: ['stage', 'gate'],
            [GRAPH_SOURCE_URI_ARG]: 'file:///w/top.py'
        })).toEqual({ networkName: 'Gate', view: 'actor-instance', rootWorkflow: 'top', instancePath: ['stage', 'gate'], graphSourceUri: 'file:///w/top.py' });
        // A root with no path to an instance asks for nothing by it.
        expect(viewRequestOf({ [ROOT_WORKFLOW_ARG]: 'top', [INSTANCE_PATH_ARG]: [] })).toEqual({});
    });
});
