/**
 * A model-facing representation of a tool result, in terms no agent
 * library owns. Each provider lowers it onto its own library's shape,
 * degrading to text where there is no equivalent.
 */
export type ModelOutput =
  | { type: "text"; value: string }
  | { type: "error-text"; value: string }
  | { type: "json"; value: unknown }
  /** `data` is base64: how the read tool captures bytes, and what pi and TanStack want on the wire. */
  | { type: "media"; text: string; data: string; mediaType: string; filename?: string };

export function defaultModelOutput(output: unknown): ModelOutput {
  if (
    typeof output === "object" &&
    output !== null &&
    typeof (output as { error?: unknown }).error === "string"
  ) {
    return { type: "error-text", value: (output as { error: string }).error };
  }
  return { type: "json", value: output };
}

export function modelOutputToText(output: ModelOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
      return JSON.stringify(output.value);
    case "media":
      return output.text;
  }
}
