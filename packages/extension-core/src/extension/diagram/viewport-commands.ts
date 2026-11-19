/**
 * The action the host's Center command sends to the diagram.
 *
 * Center keeps the zoom the reader chose: Center moves the view, Fit sizes
 * it. Sprotty's Center drops to zoom 1 unless told otherwise, which is the
 * graph's default size and nothing a reader zoomed in on detail asked for;
 * every other centre the platform does (a link followed in the property
 * panel, a node revealed) already keeps it. For every product: a zoom of 1
 * means nothing in particular to a product whose units are not the graph's
 * pixels.
 */
import { CenterAction } from '@eclipse-glsp/protocol';

/** What the Center command sends: centre the content, animated, at the zoom there is. */
export function centerKeepingZoom(): CenterAction {
    return CenterAction.create([], { animate: true, retainZoom: true });
}
