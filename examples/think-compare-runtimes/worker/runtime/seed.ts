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

  const files = fixture.files.map((file) => ({
    ...file,
    absolutePath: joinPath(fixture.root, file.path),
  }));
  const parentDirs = new Set(
    files.map((file) => dirname(file.absolutePath)).filter((dir) => dir !== fixture.root),
  );

  await Promise.all([...parentDirs].map((dir) => runtime.mkdir(dir)));
  await Promise.all(files.map((file) => runtime.writeFile(file.absolutePath, file.contents)));
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
