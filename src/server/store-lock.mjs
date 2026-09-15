// The one mutex every write to claude-swap's store goes through.
//
// WHY IT IS ITS OWN MODULE (#1039). It used to live in cswap-admin.mjs, under a
// header that states the invariant the whole feature rests on — "`cswap add`
// takes no lock while assigning the next slot as max+1 … so every mutation here
// goes through one mutex" — and "here" turned out to be doing the work. A lock
// reachable from one module serializes that module against itself and nothing
// else, and `grep -n withStoreLock src/server/*.mjs` returned hits in exactly
// one file while three writers of the same sequence.json lived in two others:
// the manual switch route, the auto-switch tick, and the first-run seed.
//
// cswap-admin.mjs imports claude-accounts.mjs, so the lock could not simply be
// imported back the other way round. Here it depends on nothing at all, which
// is what lets every writer reach it — and what keeps the next one from
// quietly growing a second lock of its own, since there is now an obvious
// place to look.
import { AsyncLocalStorage } from "node:async_hooks";

let _chain = Promise.resolve();

// Whether the code running right now is itself the mutation holding the lock.
// Async context rather than a plain boolean, which could not tell that apart
// from another request that merely arrived while the lock was held — and would
// wave that one through, which is the opposite of a mutex.
const _holder = new AsyncLocalStorage();

/**
 * One store mutation at a time.
 *
 * Not defence against another process — that would need claude-swap's own file
 * lock, which `add` does not take either. This is defence against ourselves:
 * two browser tabs, a double-click, or a timer are enough to race a slot
 * assignment.
 *
 * Re-entrant, because a mutation that reaches for the lock from inside one
 * would otherwise wait for itself forever: the chain cannot advance past the
 * outer link until it settles, and the outer link is blocked on this call. It
 * already has exclusive access, so it simply runs. That is also what lets a
 * whole decision be wrapped — `fillEmptySlot` opens the lock and then calls
 * `importAccount`, which opens it again — instead of a caller having to know
 * which of its callees already takes it.
 */
export function withStoreLock(fn) {
  if (_holder.getStore()) return Promise.resolve().then(fn);
  const held = () => _holder.run(true, fn);
  const next = _chain.then(held, held);
  // Keep the chain alive even when a link rejects, or every later mutation
  // inherits the failure.
  _chain = next.then(() => {}, () => {});
  return next;
}
