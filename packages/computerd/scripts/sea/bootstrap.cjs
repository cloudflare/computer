// CJS bootstrap injected as the SEA main script. Node SEA only loads CJS as
// the embedded entry, so this thin wrapper hands control off to the real ESM
// bundle (which is shipped as a SEA asset).
//
// We expose the bundle via a data: URL rather than writing it to disk because
// the bundle is fully self-contained — the native-addon shim inside it knows
// how to extract the embedded .node/.so via sea.getAsset() on its own. Keeping
// the JS in-memory avoids a second tempfile lifecycle to reason about.
"use strict";

const sea = require("node:sea");

const bundleText = sea.getAsset("bundle.mjs", "utf8");
const dataUrl = `data:text/javascript;base64,${Buffer.from(bundleText, "utf8").toString("base64")}`;

import(dataUrl).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
