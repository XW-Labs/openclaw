// Feishu tests cover sequential key plugin behavior.
import { describe, expect, it } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import { getFeishuSequentialKey } from "./sequential-key.js";
import type { FeishuConfig } from "./types.js";

function createTextEvent(params: {
  text: string;
  messageId?: string;
  chatId?: string;
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: "ou_sender_1",
        user_id: "ou_user_1",
      },
      sender_type: "user",
    },
    message: {
      message_id: params.messageId ?? "om_message_1",
      chat_id: params.chatId ?? "oc_dm_chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
    },
  } as FeishuMessageEvent;
}

describe("getFeishuSequentialKey", () => {
  it.each([
    [createTextEvent({ text: "hello" }), "feishu:default:oc_dm_chat"],
    [createTextEvent({ text: "/status" }), "feishu:default:oc_dm_chat"],
    [createTextEvent({ text: "/stop" }), "feishu:default:oc_dm_chat:control"],
  ])("resolves sequential key %#", (event, expected) => {
    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
      }),
    ).toBe(expected);
  });

  it("classifies the prepared batch body instead of only its last event", () => {
    const event = createTextEvent({ text: "@_bot/stop" });
    event.message.mentions = [{ key: "@_bot", name: "Bot", id: { open_id: "ou_bot" } }];
    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
        botOpenId: "ou_bot",
        preparedContent: "first message\n@_bot/stop",
      }),
    ).toBe("feishu:default:oc_dm_chat");
  });

  it("keeps /btw on a stable per-chat lane across different message ids", () => {
    const first = createTextEvent({ text: "/btw one", messageId: "om_message_1" });
    const second = createTextEvent({ text: "/btw two", messageId: "om_message_2" });

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event: first,
      }),
    ).toBe("feishu:default:oc_dm_chat:btw");
    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event: second,
      }),
    ).toBe("feishu:default:oc_dm_chat:btw");
  });

  it("falls back to a stable btw lane when the message id is unavailable", () => {
    const event = createTextEvent({ text: "/btw what changed?" });
    delete (event.message as { message_id?: string }).message_id;

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
      }),
    ).toBe("feishu:default:oc_dm_chat:btw");
  });

  it("keeps an empty group message with bot mentions on its normal chat lane", () => {
    const event = createTextEvent({ text: "" });
    event.message.chat_type = "group";
    event.message.content = "";
    event.message.mentions = [
      {
        key: "@_bot_1",
        id: { open_id: "ou_bot_1" },
        name: "OpenClaw",
      },
    ];

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
        botOpenId: "ou_bot_1",
      }),
    ).toBe("feishu:default:oc_dm_chat");
  });
});

describe("getFeishuSequentialKey topic lanes", () => {
  const topicCfg = {
    groupSessionScope: "group_topic",
    replyInThread: "enabled",
  } as FeishuConfig;

  function createGroupEvent(params: {
    text?: string;
    messageId: string;
    rootId?: string;
    threadId?: string;
    chatType?: "group" | "topic_group";
    senderOpenId?: string;
  }): FeishuMessageEvent {
    return {
      sender: {
        sender_id: { open_id: params.senderOpenId ?? "ou_sender_1" },
        sender_type: "user",
      },
      message: {
        message_id: params.messageId,
        ...(params.rootId ? { root_id: params.rootId } : {}),
        ...(params.threadId ? { thread_id: params.threadId } : {}),
        chat_id: "oc_group",
        chat_type: params.chatType ?? "group",
        message_type: "text",
        content: JSON.stringify({ text: params.text ?? "hello" }),
      },
    } as FeishuMessageEvent;
  }

  const keyOf = (event: FeishuMessageEvent, feishuCfg: FeishuConfig | undefined = topicCfg) =>
    getFeishuSequentialKey({ accountId: "apm", event, feishuCfg });

  it("gives different threads of one group their own lanes", () => {
    expect(keyOf(createGroupEvent({ messageId: "om_b1", rootId: "om_a" }))).toBe(
      "feishu:apm:oc_group:topic:om_a",
    );
    expect(keyOf(createGroupEvent({ messageId: "om_b2", rootId: "om_b" }))).toBe(
      "feishu:apm:oc_group:topic:om_b",
    );
  });

  it("keeps a thread's first message and its later replies on the same lane", () => {
    const first = createGroupEvent({ messageId: "om_first" });
    const reply = createGroupEvent({
      messageId: "om_reply",
      rootId: "om_first",
      threadId: "omt_thread",
    });
    expect(keyOf(first)).toBe("feishu:apm:oc_group:topic:om_first");
    expect(keyOf(reply)).toBe(keyOf(first));
  });

  it("uses thread_id first in topic groups, like session routing", () => {
    const event = createGroupEvent({
      messageId: "om_reply",
      rootId: "om_root",
      threadId: "omt_topic",
      chatType: "topic_group",
    });
    expect(keyOf(event)).toBe("feishu:apm:oc_group:topic:omt_topic");
  });

  it("shares one topic lane across senders under group_topic_sender", () => {
    const cfg = {
      groupSessionScope: "group_topic_sender",
      replyInThread: "enabled",
    } as FeishuConfig;
    const a = createGroupEvent({ messageId: "om_1", rootId: "om_a", senderOpenId: "ou_1" });
    const b = createGroupEvent({ messageId: "om_2", rootId: "om_a", senderOpenId: "ou_2" });
    expect(keyOf(a, cfg)).toBe("feishu:apm:oc_group:topic:om_a");
    expect(keyOf(b, cfg)).toBe(keyOf(a, cfg));
  });

  it("honors a per-group scope override", () => {
    const cfg = {
      groups: { oc_group: { groupSessionScope: "group_topic" } },
    } as unknown as FeishuConfig;
    expect(keyOf(createGroupEvent({ messageId: "om_1", rootId: "om_a" }), cfg)).toBe(
      "feishu:apm:oc_group:topic:om_a",
    );
  });

  it("keeps top-level messages per group when replies do not open threads", () => {
    const cfg = { groupSessionScope: "group_topic" } as FeishuConfig;
    expect(keyOf(createGroupEvent({ messageId: "om_1" }), cfg)).toBe("feishu:apm:oc_group");
  });

  it.each([
    ["group", { groupSessionScope: "group", replyInThread: "enabled" }],
    ["group_sender", { groupSessionScope: "group_sender", replyInThread: "enabled" }],
  ])("keeps the per-group lane for %s", (_label, cfg) => {
    const event = createGroupEvent({ messageId: "om_1", rootId: "om_a" });
    expect(keyOf(event, cfg as FeishuConfig)).toBe("feishu:apm:oc_group");
  });

  it("keeps the per-group lane without account config", () => {
    const event = createGroupEvent({ messageId: "om_1", rootId: "om_a" });
    expect(getFeishuSequentialKey({ accountId: "apm", event })).toBe("feishu:apm:oc_group");
  });

  it("keeps the per-chat lane for direct messages", () => {
    const event = createTextEvent({ text: "hello" });
    event.message.root_id = "om_a";
    expect(keyOf(event)).toBe("feishu:apm:oc_dm_chat");
  });

  it("keeps /stop and /btw inside a thread on the per-group escape lanes", () => {
    const stop = createGroupEvent({ text: "/stop", messageId: "om_1", rootId: "om_a" });
    const btw = createGroupEvent({ text: "/btw what now?", messageId: "om_2", rootId: "om_a" });
    expect(keyOf(stop)).toBe("feishu:apm:oc_group:control");
    expect(keyOf(btw)).toBe("feishu:apm:oc_group:btw");
  });

  it("puts other commands inside a thread on that thread's lane", () => {
    const event = createGroupEvent({ text: "/new", messageId: "om_1", rootId: "om_a" });
    expect(keyOf(event)).toBe("feishu:apm:oc_group:topic:om_a");
  });
});
