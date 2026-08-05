import { describe, expect, it } from "vitest";
import { withApprovalSignatures } from "./approval-signatures.mjs";

function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function drain(stream) {
  const reader = stream.getReader();
  const out = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

// Stands in for the worker: hands back whatever chunks the test names
// and remembers the messages it was asked to send.
function fakeTransport(chunks = []) {
  const transport = {
    sent: [],
    async sendMessages(options) {
      transport.sent.push(options);
      return streamOf(chunks);
    },
    async reconnectToStream() {
      return null;
    },
  };
  return transport;
}

const request = {
  type: "tool-approval-request",
  approvalId: "aitxt-1",
  toolCallId: "call-1",
  signature: "sig-1",
};

// The exact mutation @ai-sdk/tui performs on a "yes": the whole
// approval object is replaced, so the signature the worker issued does
// not survive. See applyToolApprovalResponse in @ai-sdk/tui.
function answerLikeTheTUI(part, approved) {
  part.state = "approval-responded";
  part.approval = { id: part.approval.id, approved };
}

function respondedMessage(approved = true) {
  const part = {
    type: "tool-exec",
    toolCallId: "call-1",
    state: "approval-requested",
    input: { command: "rm /workspace/x" },
    approval: { id: "aitxt-1", signature: "sig-1" },
  };
  answerLikeTheTUI(part, approved);
  return { id: "m1", role: "assistant", parts: [part] };
}

describe("withApprovalSignatures", () => {
  it("passes the worker's chunks through untouched", async () => {
    const inner = fakeTransport([{ type: "start" }, request]);
    const stream = await withApprovalSignatures(inner).sendMessages({ messages: [] });
    expect(await drain(stream)).toEqual([{ type: "start" }, request]);
  });

  it("puts back the signature the terminal UI dropped", async () => {
    const inner = fakeTransport([request]);
    const transport = withApprovalSignatures(inner);

    // Turn one: the worker asks, and the signature goes by on the wire.
    await drain(await transport.sendMessages({ messages: [] }));

    // Turn two: the answer comes back without it.
    await transport.sendMessages({ messages: [respondedMessage(true)] });

    const part = inner.sent[1].messages[0].parts[0];
    expect(part.approval).toEqual({ id: "aitxt-1", approved: true, signature: "sig-1" });
  });

  it("signs a refusal too, so a no is as checkable as a yes", async () => {
    const inner = fakeTransport([request]);
    const transport = withApprovalSignatures(inner);
    await drain(await transport.sendMessages({ messages: [] }));

    await transport.sendMessages({ messages: [respondedMessage(false)] });

    const part = inner.sent[1].messages[0].parts[0];
    expect(part.approval).toMatchObject({ approved: false, signature: "sig-1" });
  });

  it("leaves an approval alone when it never saw a signature for it", async () => {
    const inner = fakeTransport([]);
    const transport = withApprovalSignatures(inner);

    await transport.sendMessages({ messages: [respondedMessage(true)] });

    const part = inner.sent[0].messages[0].parts[0];
    expect(part.approval).toEqual({ id: "aitxt-1", approved: true });
  });

  it("does not overwrite a signature that survived", async () => {
    const inner = fakeTransport([request]);
    const transport = withApprovalSignatures(inner);
    await drain(await transport.sendMessages({ messages: [] }));

    const message = respondedMessage(true);
    message.parts[0].approval.signature = "sig-from-elsewhere";
    await transport.sendMessages({ messages: [message] });

    expect(inner.sent[1].messages[0].parts[0].approval.signature).toBe("sig-from-elsewhere");
  });

  it("keeps signatures apart when a turn asks about two commands", async () => {
    const second = { ...request, approvalId: "aitxt-2", toolCallId: "call-2", signature: "sig-2" };
    const inner = fakeTransport([request, second]);
    const transport = withApprovalSignatures(inner);
    await drain(await transport.sendMessages({ messages: [] }));

    const message = respondedMessage(true);
    const other = {
      type: "tool-exec",
      toolCallId: "call-2",
      state: "approval-requested",
      approval: { id: "aitxt-2", signature: "sig-2" },
    };
    answerLikeTheTUI(other, true);
    message.parts.push(other);
    await transport.sendMessages({ messages: [message] });

    const parts = inner.sent[1].messages[0].parts;
    expect(parts[0].approval.signature).toBe("sig-1");
    expect(parts[1].approval.signature).toBe("sig-2");
  });

  it("delegates the rest of the transport", async () => {
    const inner = fakeTransport([]);
    expect(await withApprovalSignatures(inner).reconnectToStream({})).toBeNull();
  });
});
