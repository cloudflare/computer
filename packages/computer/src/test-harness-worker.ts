// Worker + DO entry for the docker harness vitest project.
//
// The DO exists so harness tests can grab a real
// DurableObjectStorage instance via runInDurableObject() and pass
// it to the Workspace constructor. The harness boots computerd in a
// sibling docker container; tests connect to it through
// TestBackend, but the Workspace itself runs inside the DO so it
// has a host store to read / write against.

import { DurableObject } from "cloudflare:workers";

export interface HarnessBindings {
  COMPUTERD_HARNESS_URL: string;
  TEST_DO: DurableObjectNamespace;
}

export class TestStorageDO extends DurableObject<HarnessBindings> {
  // No methods of our own; tests reach in via runInDurableObject()
  // and use this.ctx.storage directly.
}

export default {
  async fetch(): Promise<Response> {
    return new Response("workspace harness", { status: 200 });
  },
} satisfies ExportedHandler<HarnessBindings>;
