// Build-time replacement for `undici`, aliased in by
// build-bundle.mjs so the real ~620 KB network stack never enters
// the Worker shell bundle.
//
// just-bash only reaches undici through its DNS-pinning connection
// owner (network/dns-pin.ts), which runs solely when a curl/wget
// request is made with `denyPrivateRanges` enabled. The Worker
// backend registers curl on the plain-fetch path with
// `denyPrivateRanges` off (egress is governed by the Dynamic
// Worker's globalOutbound, not by in-isolate DNS pinning), so this
// code is never executed. The throwing members exist only to keep
// the dynamic `import("undici")` resolvable; reaching them means
// pinning was switched on without shipping the real dependency.

const excluded = () => {
  throw new Error(
    "undici is excluded from the Worker shell bundle; curl runs on the fetch path with denyPrivateRanges disabled",
  );
};

export class Agent {
  constructor() {
    excluded();
  }
}

export const fetch = excluded;

export default { Agent, fetch };
