import type { JSONValue } from "ai";
import type { ModelOutput } from "../common/model-output.js";

export function toAISDKOutput(output: ModelOutput) {
  switch (output.type) {
    case "text":
      return { type: "text" as const, value: output.value };
    case "error-text":
      return { type: "error-text" as const, value: output.value };
    case "json":
      return { type: "json" as const, value: toJSONValue(output.value) };
    case "media":
      return {
        type: "content" as const,
        value: [
          { type: "text" as const, text: output.text },
          {
            type: "file" as const,
            data: { type: "data" as const, data: output.data },
            mediaType: output.mediaType,
            filename: output.filename,
          },
        ],
      };
  }
}

export function toJSONValue(value: unknown): JSONValue {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : (JSON.parse(json) as JSONValue);
  } catch {
    return String(value);
  }
}
