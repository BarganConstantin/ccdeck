interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export function createSceneTimer(visibility: VisibilitySource) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let callback: (() => void) | null = null;
  let remaining = 0;
  let started = 0;
  let disposed = false;

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    if (disposed || visibility.hidden || !callback || timer !== null) return;
    started = performance.now();
    timer = setTimeout(() => {
      timer = null;
      const run = callback;
      callback = null;
      run?.();
    }, remaining);
  };
  const changed = () => {
    if (visibility.hidden && timer !== null) {
      remaining = Math.max(0, remaining - (performance.now() - started));
      cancel();
    } else if (!visibility.hidden) arm();
  };
  visibility.addEventListener("visibilitychange", changed);
  return {
    schedule(run: () => void, ms: number) {
      if (disposed) return;
      cancel();
      callback = run;
      remaining = Math.max(0, ms);
      arm();
    },
    dispose() {
      disposed = true;
      cancel();
      callback = null;
      visibility.removeEventListener("visibilitychange", changed);
    },
  };
}
