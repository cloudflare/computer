/**
 * How a result should be presented to the model, in terms no provider
 * owns.
 *
 * The read tool is the reason this exists: a complete text read is
 * cheaper as plain text, an error reads better as an error string, and
 * an image or PDF has to travel as a typed media part. Deciding which
 * of those a given read produced is real logic, it depends only on the
 * file, and all three providers need the same answer — so it is
 * computed once here and each provider lowers the result onto whatever
 * its own library supports, degrading to text where there is no
 * equivalent.
 */

/** A model-facing representation of a tool result. */
export type ModelOutput =
  | { type: "text"; value: string }
  | { type: "error-text"; value: string }
  | { type: "json"; value: unknown }
  /**
   * An image or PDF to hand the model.
   *
   * `data` is base64 because that is how the read tool captures the
   * bytes and how pi and TanStack want them on the wire. The AI SDK
   * accepts a base64 string for a `file` part too, so no provider has
   * to decode it.
   */
  | { type: "media"; text: string; data: string; mediaType: string; filename?: string };

/**
 * Default representation for a result with no tool-specific mapping.
 *
 * An `{ error }` result becomes error text so a library that
 * distinguishes tool failures can mark the call as failed; everything
 * else stays JSON.
 */
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

/** Render a `ModelOutput` as plain text, for a channel with nothing richer. */
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
