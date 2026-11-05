import { describe, expect, it } from "vitest";

import {
  codemodeModuleDefinition,
  codemodeObjectInfo,
  createCodemodeModule,
  isCodemodeModule,
} from "./codemode-module";

describe("createCodemodeModule", () => {
  describe("define", () => {
    it("returns a constructor that builds the object and remembers its kind and state", () => {
      const jobs = createCodemodeModule();
      const Job = jobs.define("Job", ({ id }: { id: string }) => ({
        start: async () => `started ${id}`,
      }));
      const job = Job({ id: "j1" });
      expect(Job.kind).toBe("Job");
      expect(typeof job.start).toBe("function");
      expect(codemodeObjectInfo(job)).toMatchObject({ kind: "Job", state: { id: "j1" } });
    });

    it("keeps the tag out of the object's own enumerable keys", () => {
      const jobs = createCodemodeModule();
      const Job = jobs.define("Job", () => ({ start: async () => null }));
      expect(Object.keys(Job({}))).toEqual(["start"]);
    });

    it("tells which module an object belongs to", () => {
      const a = createCodemodeModule();
      const b = createCodemodeModule();
      const A = a.define("Thing", () => ({ go: async () => null }));
      const B = b.define("Thing", () => ({ go: async () => null }));
      expect(codemodeObjectInfo(A({}))?.owner).toBe(
        codemodeModuleDefinition(a.module({ x: async () => null }))?.owner,
      );
      expect(codemodeObjectInfo(A({}))?.owner).not.toBe(codemodeObjectInfo(B({}))?.owner);
    });

    it("refuses a kind defined twice", () => {
      const jobs = createCodemodeModule();
      jobs.define("Job", () => ({}));
      expect(() => jobs.define("Job", () => ({}))).toThrow(/already defines "Job"/);
    });

    it("refuses a kind that isn't a non-empty string without # or .", () => {
      const jobs = createCodemodeModule();
      for (const kind of ["", "a#b", "a.b", 42 as unknown as string]) {
        expect(() => jobs.define(kind, () => ({}))).toThrow(/kind/);
      }
    });

    it("refuses a builder that returns something other than an object", () => {
      const jobs = createCodemodeModule();
      const Bad = jobs.define("Bad", () => null as never);
      expect(() => Bad({})).toThrow(/must return an object/);
    });

    it("returns null info for anything that isn't a defined object", () => {
      expect(codemodeObjectInfo({})).toBeUndefined();
      expect(codemodeObjectInfo(null)).toBeUndefined();
      expect(codemodeObjectInfo("x")).toBeUndefined();
    });
  });

  describe("context", () => {
    it("stores connection and scoped contexts in order", () => {
      const browser = createCodemodeModule();
      const create = () => "client";
      const start = () => "session";
      const dispose = () => undefined;
      browser.context("client", create);
      browser.context("session", start, { scoped: true, dispose });
      const definition = codemodeModuleDefinition(browser.module({ open: async () => null }));
      expect(definition?.contexts).toEqual([
        { name: "client", create, scoped: false, dispose: undefined },
        { name: "session", create: start, scoped: true, dispose },
      ]);
    });

    it("refuses a name used twice", () => {
      const browser = createCodemodeModule();
      browser.context("session", () => 1);
      expect(() => browser.context("session", () => 2, { scoped: true })).toThrow(
        /already has a context named "session"/,
      );
    });

    it("refuses a name ctx already uses", () => {
      const browser = createCodemodeModule();
      for (const name of [
        "callId",
        "signal",
        "deadline",
        "execution",
        "interrupt",
        "access",
        "resolvePath",
      ]) {
        expect(() => browser.context(name, () => 1)).toThrow(/reserved/);
      }
    });

    it("refuses a name that isn't an identifier", () => {
      const browser = createCodemodeModule();
      expect(() => browser.context("not ok", () => 1)).toThrow(/identifier/);
    });

    it("refuses a create that isn't a function", () => {
      const browser = createCodemodeModule();
      expect(() => browser.context("x", "nope" as never)).toThrow(/function/);
    });
  });

  describe("module", () => {
    it("returns a frozen, marked module listing its exports and description", () => {
      const jobs = createCodemodeModule({ description: "Build jobs." });
      const module = jobs.module({ createJob: async () => null, listJobs: async () => [] });
      expect(isCodemodeModule(module)).toBe(true);
      expect(Object.isFrozen(module)).toBe(true);
      expect(module.exports).toEqual(["createJob", "listJobs"]);
      expect(module.description).toBe("Build jobs.");
    });

    it("refuses export names a host module can't use", () => {
      expect(() => createCodemodeModule().module({})).toThrow(/must export a function/);
      expect(() => createCodemodeModule().module({ default: async () => null })).toThrow(
        /JavaScript identifier/,
      );
      expect(() => createCodemodeModule().module({ go: "nope" as never })).toThrow(
        /must be a function/,
      );
    });

    it("refuses a second module from the same builder", () => {
      const jobs = createCodemodeModule();
      jobs.module({ a: async () => null });
      expect(() => jobs.module({ b: async () => null })).toThrow(/already made its module/);
    });

    it("allows a second module from a named builder", () => {
      const jobs = createCodemodeModule({ name: "jobs" });
      jobs.module({ a: async () => null });
      expect(() => jobs.module({ b: async () => null })).not.toThrow();
    });

    it("shares the builder's kinds with its module", () => {
      const jobs = createCodemodeModule();
      const Job = jobs.define("Job", () => ({ start: async () => null }));
      const definition = codemodeModuleDefinition(jobs.module({ a: async () => null }));
      expect(definition?.kinds.get("Job")).toBeTypeOf("function");
      expect(Job.kind).toBe("Job");
    });
  });

  describe("isCodemodeModule", () => {
    it("only accepts what module() returns", () => {
      expect(isCodemodeModule({})).toBe(false);
      expect(isCodemodeModule(null)).toBe(false);
      expect(isCodemodeModule(() => null)).toBe(false);
      expect(isCodemodeModule({ exports: ["a"] })).toBe(false);
    });
  });
});
