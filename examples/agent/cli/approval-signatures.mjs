/**
 * A chat transport that remembers the signatures on the approvals it
 * saw, and puts them back on the answers it sends.
 *
 * The worker signs every approval it asks for, because the conversation
 * lives in this process: an answer arrives as a claim the client makes
 * about something you supposedly did, and the signature is what makes
 * that claim checkable. The AI SDK verifies it before it will run the
 * tool call.
 *
 * The terminal UI drops it. Recording an answer replaces the whole
 * approval object rather than adding to it:
 *
 *     part.approval = { id: request.approvalId, approved, ...reason };
 *
 * so the signature the worker issued is gone by the time the answer is
 * posted back, and the turn dies with
 * `AI_InvalidToolApprovalSignatureError: missing signature`. That is
 * true of every published @ai-sdk/tui through 1.0.52.
 *
 * A signature is not a secret — it is a MAC the worker issued over an
 * approval id, and only the worker can make or check one. Carrying it
 * across a turn it was always meant to survive grants this client
 * nothing it did not already have, which is why the repair belongs
 * here, in the transport, rather than in a fork of the UI. The cache
 * only ever supplies a signature the worker itself sent for that exact
 * approval id, so a forged approval still has nothing to present.
 */

/**
 * Wrap a chat transport so approval signatures survive the round trip.
 *
 * @template {{ sendMessages: (options: any) => Promise<ReadableStream<any>> }} T
 * @param {T} transport
 * @returns {T}
 */
export function withApprovalSignatures(transport) {
  /** @type {Map<string, string>} */
  const signatures = new Map();

  return Object.create(transport, {
    sendMessages: {
      value: async (options) => {
        for (const message of options.messages ?? []) {
          for (const part of message.parts ?? []) restore(part, signatures);
        }
        const stream = await transport.sendMessages(options);
        return stream.pipeThrough(remember(signatures));
      },
    },
  });
}

/**
 * Re-attach the signature for an answered approval, if we have one and
 * the answer is missing it.
 */
function restore(part, signatures) {
  const approval = part?.approval;
  if (!approval || approval.signature !== undefined) return;
  const signature = signatures.get(approval.id);
  if (signature !== undefined) approval.signature = signature;
}

/**
 * Note the signature on every approval the worker asks for, passing the
 * stream through untouched.
 */
function remember(signatures) {
  return new TransformStream({
    transform(chunk, controller) {
      if (chunk?.type === "tool-approval-request" && chunk.signature !== undefined) {
        signatures.set(chunk.approvalId, chunk.signature);
      }
      controller.enqueue(chunk);
    },
  });
}
