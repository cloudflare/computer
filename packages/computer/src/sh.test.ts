import { describe, expect, it } from "vitest";

import { assertNotTemplate, sh, shellQuote } from "./sh.js";

describe("shellQuote", () => {
  it("leaves safe values unquoted for readability", () => {
    expect(shellQuote("main")).toBe("main");
    expect(shellQuote("/workspace/my-repo")).toBe("/workspace/my-repo");
    expect(shellQuote("a_b-c+d=e:f,g.h/i@j%k")).toBe("a_b-c+d=e:f,g.h/i@j%k");
  });

  it("quotes values with shell metacharacters", () => {
    expect(shellQuote("hello world")).toBe("'hello world'");
    expect(shellQuote("a;rm -rf /")).toBe("'a;rm -rf /'");
    expect(shellQuote("$(whoami)")).toBe("'$(whoami)'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("quotes the empty string", () => {
    expect(shellQuote("")).toBe("''");
  });
});

describe("assertNotTemplate", () => {
  it("accepts a plain string", () => {
    expect(() => assertNotTemplate("cat file")).not.toThrow();
  });

  it("rejects a tagged-template call and points at sh", () => {
    const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
      void values;
      return strings;
    };
    const asTemplate = tag`cat ${"file"}`;
    expect(() => assertNotTemplate(asTemplate)).toThrow(/getWorkspace/);
  });

  it("rejects the template array even after it loses .raw over the wire", () => {
    // Workers RPC structured-clones the TemplateStringsArray, which
    // drops `.raw` but keeps the indexed entries. The guard keys off
    // the array shape, not `.raw`, so it still fires on the far side.
    const wireShape = ["cat ", ""];
    expect("raw" in wireShape).toBe(false);
    expect(() => assertNotTemplate(wireShape)).toThrow(/getWorkspace/);
  });
});

describe("sh", () => {
  it("emits the static parts verbatim and escapes interpolations", () => {
    expect(sh`cat ${"my file.txt"}`).toBe("cat 'my file.txt'");
  });

  it("leaves simple interpolated values unquoted", () => {
    const file = "/workspace/notes.md";
    expect(sh`cat ${file}`).toBe("cat /workspace/notes.md");
  });

  it("neutralizes injection attempts in interpolated values", () => {
    const evil = "x; rm -rf /";
    expect(sh`echo ${evil}`).toBe("echo 'x; rm -rf /'");
  });

  it("quotes numbers as strings", () => {
    expect(sh`sleep ${5}`).toBe("sleep 5");
  });

  it("quotes each element of an array and joins with spaces", () => {
    const files = ["a.txt", "b c.txt"];
    expect(sh`rm ${files}`).toBe("rm a.txt 'b c.txt'");
  });

  it("handles multiple interpolations", () => {
    const src = "from dir";
    const dst = "to dir";
    expect(sh`cp ${src} ${dst}`).toBe("cp 'from dir' 'to dir'");
  });

  it("splices { raw } values verbatim", () => {
    const dir = "my dir";
    expect(sh`ls ${dir} ${{ raw: "| wc -l" }}`).toBe("ls 'my dir' | wc -l");
  });

  it("preserves backslashes in the static template via strings.raw", () => {
    const file = "notes.txt";
    // A `\n` in the template stays a literal backslash-n for the
    // shell instead of being cooked into a newline.
    expect(sh`grep \n ${file}`).toBe("grep \\n notes.txt");
  });

  it("works with no interpolations", () => {
    expect(sh`git status`).toBe("git status");
  });
});
