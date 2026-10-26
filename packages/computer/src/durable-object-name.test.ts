import { describe, expect, it } from "vitest";

import { hostDurableObjectId, withHostName } from "./durable-object-name";

// A namespace whose ids remember how they were made, standing in for
// DurableObjectNamespace: a named id knows its name, as ctx.id.name
// does on the instance it wakes.
class FakeId {
  constructor(
    readonly hex: string,
    readonly name?: string,
  ) {}
  toString(): string {
    return this.hex;
  }
}

const ns = {
  idFromName: (name: string) => new FakeId(`hex:${name}`, name),
  idFromString: (id: string) => new FakeId(id),
};

describe("hostDurableObjectId", () => {
  it("addresses by name when the name yields the id", () => {
    const id = hostDurableObjectId(ns, "hex:main", "main");
    expect(id.toString()).toBe("hex:main");
    expect(id.name).toBe("main");
  });

  it("falls back to the id when the name maps elsewhere", () => {
    const id = hostDurableObjectId(ns, "hex:main", "other");
    expect(id.toString()).toBe("hex:main");
    expect(id.name).toBeUndefined();
  });

  it("uses the id when there is no name", () => {
    expect(hostDurableObjectId(ns, "hex:main", undefined).name).toBeUndefined();
    expect(hostDurableObjectId(ns, "hex:main", "").name).toBeUndefined();
  });
});

describe("withHostName", () => {
  const ctx = { id: new FakeId("hex:main", "main") };

  it("adds the name of the object that owns ctx", () => {
    expect(withHostName({ binding: "Agent", id: "hex:main" }, ctx)).toEqual({
      binding: "Agent",
      id: "hex:main",
      name: "main",
    });
  });

  it("leaves a reference to another object alone", () => {
    const ref = { binding: "Agent", id: "hex:other" };
    expect(withHostName(ref, ctx)).toBe(ref);
  });

  it("keeps a name the caller supplied", () => {
    const ref = { binding: "Agent", id: "hex:main", name: "explicit" };
    expect(withHostName(ref, ctx)).toBe(ref);
  });

  it("leaves the reference alone when the runtime has no name", () => {
    const ref = { binding: "Agent", id: "hex:main" };
    expect(withHostName(ref, { id: new FakeId("hex:main") })).toBe(ref);
    expect(withHostName(ref, undefined)).toBe(ref);
    expect(withHostName(ref, {})).toBe(ref);
  });
});
