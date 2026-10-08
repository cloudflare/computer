export function globList(value: string | readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const list = (typeof value === "string" ? [value] : value).filter((glob) => glob.trim() !== "");
  return list.length === 0 ? undefined : list;
}

export function globOne(value: string | readonly string[] | undefined): string | undefined {
  const list = globList(value);
  if (list === undefined) return undefined;
  return list.length === 1 ? list[0] : `{${list.join(",")}}`;
}
