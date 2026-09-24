import { LionButton } from '@lion/ui/button.js';

/**
 * LionButton under a tag of our own, for the launcher's and widget's scoped registries.
 *
 * Without native scoped registries, `ScopedElementsMixin` v2 defines scoped tags on the page's
 * global `customElements` (`ScopedElementsMixin.js`: `supportsScopedRegistry ? new
 * CustomElementRegistry() : customElements`). Registered as `lion-button`, the embed would then
 * clash with a host page that ships its own Lion: whichever script defines the tag first wins,
 * and the other gets that class. `talkie-button` is ours alone.
 *
 * A subclass, not LionButton itself: one registry cannot define a constructor under two names,
 * so a page that already has LionButton as `lion-button` would make `define` throw.
 */
export class TalkieButton extends LionButton {}
