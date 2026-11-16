/**
 * Clipboard items made again in a diagram: what a paste and a duplicate do.
 *
 * Each entity gets a free name (`nextFreeName`), and the workflow's ports
 * are made, before any connection: one can come before its entity in the
 * selection. A connection joins the copies where both its ends were copied.
 * One whose writing end was not copied still reads from that end, where it
 * is: in the file it was copied from. One into an input of an entity that
 * was not copied is left out: that input has its writer already. In
 * another file, an end that was not copied is not there, and its
 * connection is left out too.
 *
 * An entity is made with the original's arguments as written in its
 * source (`expressions`, when the producer takes them). In another file,
 * only those that are literals: a name the original's file binds
 * (`FRONT_OPTIONS`) may be bound nowhere there; what is left out is said.
 *
 * The steps are written whole or not at all (`SidecarSteps`).
 */
import * as vscode from 'vscode';
import { URI } from 'vscode-uri';
import { nextFreeName, type DiagramClipboardPayload } from '@dialogram/shared';
import { CREATE_NODE_EXPRESSIONS } from './node-arguments';
import { SidecarSteps } from './sidecar-edit';
import type { SidecarInvoker } from './sidecar-invoker';

type Sidecar = Pick<SidecarInvoker, 'sidecarOp' | 'hasFeature' | 'sendSidecarOpDetailed'>;

/** A number, a string, `True`, `False` or `None`: what means the same in any file. */
const LITERAL = /^(?:[-+]?\d[\d_]*(?:\.\d+)?(?:[eE][-+]?\d+)?|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|True|False|None)$/;

function sameFile(a: string, b: string): boolean {
    try {
        return URI.parse(a).fsPath === URI.parse(b).fsPath;
    } catch {
        return a === b;
    }
}

/**
 * Make `payload`'s items in `workflowName` of `sourceUri`, the entities under
 * names not in `taken`. False when a step was refused: the file is back as
 * it was, and the refusal has been said.
 */
export async function recreateItems(
    sidecar: Sidecar,
    sourceUri: string,
    workflowName: string | undefined,
    payload: DiagramClipboardPayload,
    taken: Set<string>
): Promise<boolean> {
    const here = sameFile(payload.sourceUri, sourceUri);
    const withExpressions = await sidecar.hasFeature(sourceUri, CREATE_NODE_EXPRESSIONS);
    const steps = await SidecarSteps.begin(sidecar, sourceUri);
    const renamed = new Map<string, string>();
    const portsMade = new Set<string>();
    const leftOut: string[] = [];

    for (const item of payload.items) {
        if (item.kind === 'entity') {
            const name = nextFreeName(item.name, taken);
            taken.add(name);
            renamed.set(item.name, name);
            let expressions = withExpressions ? item.expressions : undefined;
            if (expressions && !here) {
                const kept = Object.entries(expressions).filter(([, text]) => LITERAL.test(text.trim()));
                leftOut.push(...Object.entries(expressions)
                    .filter(([, text]) => !LITERAL.test(text.trim()))
                    .map(([argument, text]) => `${name}: ${argument}=${text}`));
                expressions = kept.length > 0 ? Object.fromEntries(kept) : undefined;
            }
            if (!await steps.send({
                op: sidecar.sidecarOp('createNode'),
                args: { workflow: workflowName, type: item.typeName, name, ...(expressions ? { expressions } : {}) }
            }, `'${name}' was not made.`)) {
                return false;
            }
        } else if (item.kind === 'boundaryPort') {
            portsMade.add(item.portName);
            if (!await steps.send({
                op: sidecar.sidecarOp('createPort'),
                args: { workflow: workflowName, direction: item.direction, portName: item.portName, portType: item.portType ?? 'Any' }
            }, `Port '${item.portName}' was not made.`)) {
                return false;
            }
        }
    }

    for (const item of payload.items) {
        if (item.kind !== 'connection' || !item.outPort || !item.inPort) {
            continue;
        }
        // The writing end: a copy, or the original where it is.
        const from = item.from ? renamed.get(item.from) ?? (here ? item.from : undefined) : undefined;
        const fromPort = item.from
            ? (from ? { type: 'actor', actor: from, port: item.outPort } : undefined)
            : (here || portsMade.has(item.outPort) ? { type: 'workflow', name: item.outPort } : undefined);
        // The reading end: a copy only, or the workflow's own port.
        const to = item.to ? renamed.get(item.to) : undefined;
        const toPort = item.to
            ? (to ? { type: 'actor', actor: to, port: item.inPort } : undefined)
            : (here || portsMade.has(item.inPort) ? { type: 'workflow', name: item.inPort } : undefined);
        if (!fromPort || !toPort) {
            continue;
        }
        if (!await steps.send({
            op: sidecar.sidecarOp('connect'),
            args: { workflow: workflowName, from_port: fromPort, to_port: toPort }
        }, 'A connection was not made.')) {
            return false;
        }
    }

    if (leftOut.length > 0) {
        const several = leftOut.length > 1;
        void vscode.window.showInformationMessage(`Made without ${leftOut.join(', ')}: ${several ? 'these name' : 'it names'} `
            + `what the file it was copied from binds, maybe nothing here. Give ${several ? 'them' : 'it'} here if needed.`);
    }
    return true;
}
