// Latest fused state from the server plus change subscription.

export function createStore() {
  let state = null;
  let receivedAt = 0;
  const subs = new Set();
  return {
    get state() {
      return state;
    },
    /** ms since the last state arrived (Infinity before the first) */
    get age() {
      return state ? performance.now() - receivedAt : Infinity;
    },
    set(next) {
      state = next;
      receivedAt = performance.now();
      for (const fn of subs) fn(next);
    },
    onChange(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
