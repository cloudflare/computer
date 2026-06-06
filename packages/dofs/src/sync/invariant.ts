import { type ChangeCursor, compareChangeCursors } from "./watermarks.js";

// Cross-side invariant: every fetchChanges and push response carries
// the receiver's current applied push cursor. The sender asserts that
// cursor covers its local push cursor on every response.
//
// The two sides never share a single clock, but echoing the largest
// applied sender cursor makes the "receiver is caught up with our
// pushes" invariant inspectable on the wire instead of load-bearing
// in-process state. A regression in the suppress-dirty-tracking apply
// path trips the assertion immediately rather than corrupting data
// silently.
//
// Throwing an Error is the right escalation: a violation means the
// protocol is broken; the connection should tear down and rebuild
// rather than soldiering on with stale state.

export function assertAppliedPushCursor(
  appliedPushCursor: ChangeCursor,
  pushCursor: ChangeCursor,
): void {
  if (compareChangeCursors(appliedPushCursor, pushCursor) < 0) {
    throw new Error(
      `cross-side invariant violated: appliedPushCursor (${JSON.stringify(
        appliedPushCursor,
      )}) < pushCursor (${JSON.stringify(pushCursor)})`,
    );
  }
}
