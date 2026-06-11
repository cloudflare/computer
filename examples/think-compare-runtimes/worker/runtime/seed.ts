import type { ComparisonFixture } from "../../shared/fixture";

export interface FixtureRuntime {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
}

export async function seedFixture(
  runtime: FixtureRuntime,
  fixture: ComparisonFixture,
): Promise<void> {
  await runtime.mkdir(fixture.root);

  for (const file of fixture.files) {
    const path = joinPath(fixture.root, file.path);
    const parent = dirname(path);

    if (parent !== fixture.root) {
      await runtime.mkdir(parent);
    }

    await runtime.writeFile(path, file.contents);
  }
}

function joinPath(root: string, path: string): string {
  return `${root.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function dirname(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");

  if (lastSlash <= 0) {
    return "/";
  }

  return normalized.slice(0, lastSlash);
}
