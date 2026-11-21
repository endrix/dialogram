/**
 * A connection's role reaches its line group.
 *
 * The renderer puts the server's `edge-role-<role>` class on the edge's outer
 * group (`.sprotty-edge`), while the line is drawn in the `.workflow-edge`
 * group inside it, beside `selected` and `hover`. Two products styled their
 * lines as `.workflow-edge.edge-role-x` and matched nothing: every edge of
 * ndf-ide's was the same grey line, whatever it said (refines, verifies,
 * blocks), and chisel-ide's channels, wires, clocks and resets were drawn
 * alike. The views need the GLSP runtime to render, so the helper is tested
 * on its own and its use is pinned in both edge views' source.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { edgeRoleClasses } from '../src/edge-role-classes';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string): string => readFileSync(path.resolve(here, '../src', file), 'utf8');

describe('the role classes of an edge', () => {
    it('are its edge-role classes and nothing else', () => {
        expect(edgeRoleClasses({ cssClasses: ['edge-role-verifies', 'cal-edge-error', 'edge-role-bidirectional'] }))
            .toEqual({ 'edge-role-verifies': true, 'edge-role-bidirectional': true });
    });

    it('take the producer\'s tone with them, so a warning reaches the line', () => {
        expect(edgeRoleClasses({ cssClasses: ['edge-role-refines', 'edge-tone-warning', 'cal-edge-error'] }))
            .toEqual({ 'edge-role-refines': true, 'edge-tone-warning': true });
    });

    it('are none for an edge with no classes', () => {
        expect(edgeRoleClasses({})).toEqual({});
        expect(edgeRoleClasses({ cssClasses: 'edge-role-x' })).toEqual({});
    });
});

describe('the edge views', () => {
    /** The class object of the line group, up to its `'workflow-edge'` key. */
    const lineGroup = (source: string): string => {
        // The last such group: before it, the line hidden while its node is dragged.
        const at = source.lastIndexOf("'workflow-edge': true");
        expect(at, 'the line group').toBeGreaterThan(-1);
        const opens = source.lastIndexOf('class: {', at);
        expect(opens, 'its class object').toBeGreaterThan(-1);
        const object = source.slice(opens, at);
        // Nothing closes between the object's start and the key: it is the same object.
        expect(object.includes('}'), object).toBe(false);
        return object;
    };

    it('give the role classes to the line group of a connection', () => {
        expect(lineGroup(read('views.ts'))).toContain('...edgeRoleClasses(edge)');
    });

    it('give them to the line group of a transition', () => {
        expect(lineGroup(read('automaton-views.ts'))).toContain('...edgeRoleClasses(edge)');
    });
});

describe('the selection trace', () => {
    const css = read('diagram-client.css').replace(/\/\*[\s\S]*?\*\//g, '');

    it('colours a traced edge over a product\'s colour for its role', () => {
        // A product's role colour that gives way to the selection scores (0,4,0)
        // or more; the trace's rules score (0,3,0), so they need the last word.
        for (const trace of ['wf-trace-upstream', 'wf-trace-downstream', 'wf-trace-focus']) {
            const rule = new RegExp(`\\.sprotty-edge\\.${trace} \\.workflow-edge([^{]*)\\{([^}]*)\\}`).exec(css);
            expect(rule, trace).not.toBeNull();
            expect(rule![2], trace).toMatch(/color:[^;]*!important/);
        }
    });

    it('gives way to the pointer and to the run\'s last token', () => {
        // With the last word, the trace would otherwise hide both on its edges.
        for (const trace of ['wf-trace-upstream', 'wf-trace-downstream', 'wf-trace-focus']) {
            const rule = new RegExp(`\\.sprotty-edge\\.${trace} \\.workflow-edge([^{]*)\\{`).exec(css);
            expect(rule, trace).not.toBeNull();
            expect(rule![1], trace).toContain(':not(.hover)');
            expect(rule![1], trace).toContain(':not(.edge-has-last-token)');
        }
    });
});

describe('a connection the producer flags', () => {
    const css = read('diagram-client.css').replace(/\/\*[\s\S]*?\*\//g, '');

    it('is drawn in the editor\'s colour for its tone, giving way to the selection, the pointer and the last token', () => {
        for (const [tone, colour] of [['warning', 'editorWarning-foreground'], ['error', 'editorError-foreground']]) {
            const rule = new RegExp(`\\.sprotty-graph \\.sprotty-edge \\.workflow-edge\\.edge-tone-${tone}([^{]*)\\{([^}]*)\\}`).exec(css);
            expect(rule, tone).not.toBeNull();
            for (const giveWay of [':not(.selected)', ':not(.hover)', ':not(.edge-has-last-token)']) {
                expect(rule![1], `${tone} ${giveWay}`).toContain(giveWay);
            }
            expect(rule![2], tone).toContain(colour);
        }
    });
});
