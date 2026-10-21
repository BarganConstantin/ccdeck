// Snapshot the complete deck once, rather than interpolating hundreds of CSS
// colours independently. The canvas and normal DOM then change as one image.
interface ThemeViewTransition {
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  finished: Promise<void>;
  skipTransition(): void;
}
interface ThemeTransitionDocument {
  hidden: boolean;
  documentElement: { dataset: { themeTransition?: string } };
  startViewTransition?: (update: () => void) => ThemeViewTransition;
}

export function createThemeTransition(doc: ThemeTransitionDocument, reducedMotion: () => boolean) {
  let active: ThemeViewTransition | null = null;
  let revision = 0;

  function cancel() {
    revision++;
    active?.skipTransition();
    active = null;
    delete doc.documentElement.dataset.themeTransition;
  }

  return {
    cancel,
    run(update: () => void) {
      cancel();
      const request = revision;
      let applied = false;
      const apply = () => {
        // skipTransition still runs its update callback. A superseded request
        // must not put an older theme back after the user's latest choice.
        if (request !== revision || applied) return;
        applied = true;
        update();
      };
      if (!doc.startViewTransition || doc.hidden || reducedMotion()) {
        apply();
        return;
      }
      doc.documentElement.dataset.themeTransition = "true";
      try {
        const transition = doc.startViewTransition(apply);
        active = transition;
        // Skipping before capture rejects ready, but still updates the DOM.
        // Both browser rejection paths are handled without losing the choice.
        void transition.ready.catch(() => {});
        void transition.updateCallbackDone.catch(() => { apply(); });
        void transition.finished.then(() => {
          if (active !== transition) return;
          active = null;
          delete doc.documentElement.dataset.themeTransition;
        }, () => {
          if (active !== transition) return;
          apply();
          active = null;
          delete doc.documentElement.dataset.themeTransition;
        });
      } catch {
        delete doc.documentElement.dataset.themeTransition;
        apply();
      }
    },
  };
}
