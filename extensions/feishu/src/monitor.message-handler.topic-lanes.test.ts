// Feishu tests cover per-topic sequential lanes in the message receive handler.
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import * as dedup from "./dedup.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";
import { getFeishuSequentialKey } from "./sequential-key.js";

function createDeferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function groupEvent(params: { messageId: string; rootId?: string }): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
    message: {
      message_id: params.messageId,
      ...(params.rootId ? { root_id: params.rootId } : {}),
      chat_id: "oc_group",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: `text ${params.messageId}` }),
    },
  };
}

function createHandler(feishu: Record<string, unknown>) {
  const cfg = {
    messages: { inbound: { debounceMs: 0 } },
    channels: { feishu },
  } as unknown as ClawdbotConfig;
  const started: string[] = [];
  const finished: string[] = [];
  const gates = new Map<string, ReturnType<typeof createDeferred>>();
  const debouncers: Array<{ drain: () => Promise<void> }> = [];
  const createDebouncer: typeof createInboundDebouncer = (options) => {
    const debouncer = createInboundDebouncer(options);
    debouncers.push(debouncer);
    return debouncer;
  };
  const handler = createFeishuMessageReceiveHandler({
    cfg,
    channelRuntime: createPluginRuntimeMock({
      channel: { debounce: { createInboundDebouncer: createDebouncer, resolveInboundDebounceMs } },
    }).channel,
    accountId: "default",
    chatHistories: new Map(),
    handleMessage: async ({ event }) => {
      const id = event.message.message_id;
      started.push(id);
      await gates.get(id)?.promise;
      finished.push(id);
    },
    resolveDebounceText: ({ event }) => event.message.content,
    hasProcessedMessage: async () => false,
    resolveSequentialKey: getFeishuSequentialKey,
  });
  const block = (messageId: string) => {
    const gate = createDeferred();
    gates.set(messageId, gate);
    return gate;
  };
  const drain = () => Promise.all(debouncers.map((debouncer) => debouncer.drain()));
  return { handler, started, finished, block, drain };
}

describe("createFeishuMessageReceiveHandler topic lanes", () => {
  let claim: { mockRestore: () => void } | undefined;

  beforeEach(() => {
    claim = vi
      .spyOn(dedup, "claimUnprocessedFeishuMessage")
      .mockImplementation(async ({ messageId }) =>
        messageId
          ? {
              kind: "claimed",
              handle: { keys: [messageId], commit: async () => true, release: () => {} },
            }
          : { kind: "invalid" },
      );
  });

  afterEach(() => {
    claim?.mockRestore();
  });

  it("dispatches a second thread while the first thread's turn is still running", async () => {
    const lanes = createHandler({ groupSessionScope: "group_topic", replyInThread: "enabled" });
    const gate = lanes.block("om_a_reply");
    const first = lanes.handler(groupEvent({ messageId: "om_a_reply", rootId: "om_a" }));
    await vi.waitFor(() => expect(lanes.started).toEqual(["om_a_reply"]));

    const second = lanes.handler(groupEvent({ messageId: "om_b_reply", rootId: "om_b" }));
    await vi.waitFor(() => expect(lanes.finished).toEqual(["om_b_reply"]));
    expect(lanes.started).toEqual(["om_a_reply", "om_b_reply"]);

    gate.resolve();
    await Promise.all([first, second]);
    await lanes.drain();
    expect(lanes.finished).toEqual(["om_b_reply", "om_a_reply"]);
  });

  it("keeps a thread's reply queued behind the thread's first message", async () => {
    const lanes = createHandler({ groupSessionScope: "group_topic", replyInThread: "enabled" });
    const gate = lanes.block("om_first");
    const first = lanes.handler(groupEvent({ messageId: "om_first" }));
    await vi.waitFor(() => expect(lanes.started).toEqual(["om_first"]));

    const reply = lanes.handler(groupEvent({ messageId: "om_reply", rootId: "om_first" }));
    // Give the reply every chance to run; it must still wait for the first turn.
    await new Promise((done) => setTimeout(done, 50));
    expect(lanes.started).toEqual(["om_first"]);

    gate.resolve();
    await Promise.all([first, reply]);
    await lanes.drain();
    expect(lanes.finished).toEqual(["om_first", "om_reply"]);
  });

  it("still serializes the whole group under the group scope", async () => {
    const lanes = createHandler({ groupSessionScope: "group", replyInThread: "enabled" });
    const gate = lanes.block("om_a_reply");
    const first = lanes.handler(groupEvent({ messageId: "om_a_reply", rootId: "om_a" }));
    await vi.waitFor(() => expect(lanes.started).toEqual(["om_a_reply"]));

    const second = lanes.handler(groupEvent({ messageId: "om_b_reply", rootId: "om_b" }));
    await new Promise((done) => setTimeout(done, 50));
    expect(lanes.started).toEqual(["om_a_reply"]);

    gate.resolve();
    await Promise.all([first, second]);
    await lanes.drain();
    expect(lanes.finished).toEqual(["om_a_reply", "om_b_reply"]);
  });
});
