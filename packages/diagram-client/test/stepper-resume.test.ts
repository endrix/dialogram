/**
 * The stepper's resume button: when it is there, and what it runs.
 *
 * It resumes the run the overlay shows at the step the stepper shows. The
 * trace's step numbers are the index plus one -- the number displayed -- and
 * that is the number a resume at a step takes, so what the person reads is
 * what runs.
 */
import { describe, expect, it } from 'vitest';
import { stepperResumeRequest } from '../src/navigation-ui';

const trace = { step: 11, stepCount: 40, runDir: '/w/wf-out/first', resumable: true };

describe('the stepper resume button', () => {
    it('resumes at the step shown', () => {
        expect(stepperResumeRequest(trace, true, 'file:///w/flow.py', 'flow')).toEqual({
            sourceUri: 'file:///w/flow.py',
            workflowName: 'flow',
            resumeFrom: '/w/wf-out/first',
            atStep: 12
        });
    });

    it('is not there when the product cannot resume', () => {
        expect(stepperResumeRequest(trace, false, 'file:///w/flow.py', 'flow')).toBeUndefined();
    });

    it('is not there for a trace that cannot be resumed', () => {
        expect(stepperResumeRequest({ ...trace, resumable: false }, true, 'u', 'flow')).toBeUndefined();
        expect(stepperResumeRequest({ ...trace, runDir: undefined }, true, 'u', 'flow')).toBeUndefined();
        expect(stepperResumeRequest(undefined, true, 'u', 'flow')).toBeUndefined();
    });
});
