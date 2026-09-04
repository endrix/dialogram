/**
 * Pure assembly of the storage runtime options core hands the diagram server.
 *
 * Almost everything on that object comes straight off `profile.storageOptions`.
 * The exception is {@link DiagramProfile.supportsElementCreation}, which sits on
 * the profile ROOT — it is a statement about the diagram, not about storage — but
 * is read on the server, by the tool-palette provider, which sees only these
 * options. So it is folded in here, on the one channel that already carries the
 * product-shaped values into the server's DI container.
 *
 * The only subtlety is a profile that suppresses creation and carries no storage
 * options at all. Something has to be bound for the flag to arrive, so one is
 * synthesized — with the exact defaults every reader of these options already
 * applies when nothing is bound. `settingsNamespace: ''` looks wrong and is
 * deliberate: `getConfiguration(this.storageOptions?.settingsNamespace ?? '')` is
 * what those readers do today, and a carrier that answered any question
 * differently from its own absence would be a behaviour change smuggled in behind
 * a palette flag.
 */
import type { DiagramProfile } from '../../api';
import type { StorageRuntimeOptions } from '@dialogram/diagram-server';

export function composeStorageRuntimeOptions(
    profile: Pick<DiagramProfile, 'storageOptions' | 'supportsElementCreation'>
): StorageRuntimeOptions | undefined {
    const suppressesElementCreation = profile.supportsElementCreation === false;
    if (!profile.storageOptions && !suppressesElementCreation) {
        // Nothing to say: leave the binding absent exactly as before, so a profile
        // that never had storage options does not acquire them by accident.
        return undefined;
    }
    return {
        settingsNamespace: '',
        operationPrefix: '',
        ...profile.storageOptions,
        supportsElementCreation: profile.supportsElementCreation
    };
}
