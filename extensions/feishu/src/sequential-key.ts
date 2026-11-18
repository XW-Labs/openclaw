import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import { resolveFeishuGroupTopic } from "./bot-content.js";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";
import { resolveFeishuGroupConfig } from "./policy.js";
import { isFeishuGroupChatType, normalizeFeishuEventChatType, type FeishuConfig } from "./types.js";

export function getFeishuSequentialKey(params: {
  accountId: string;
  event: FeishuMessageEvent;
  preparedContent?: string;
  botOpenId?: string;
  /** Merged account config; without it every message keeps the per-chat lane. */
  feishuCfg?: FeishuConfig;
}): string {
  const { accountId, event, botOpenId, preparedContent, feishuCfg } = params;
  const chatId = event.message.chat_id?.trim() || "unknown";
  const baseKey = `feishu:${accountId}:${chatId}`;
  const text = (preparedContent ?? parseFeishuMessageEvent(event, botOpenId).content).trim();

  // Escape lanes stay per chat: they never wait behind a running turn in any topic.
  if (isAbortRequestText(text)) {
    return `${baseKey}:control`;
  }

  if (isBtwRequestText(text)) {
    return `${baseKey}:btw`;
  }

  const topicId = resolveFeishuSequentialTopicId({ event, chatId, feishuCfg });
  return topicId ? `${baseKey}:topic:${topicId}` : baseKey;
}

/**
 * Topic lane for group messages under `group_topic` / `group_topic_sender`, resolved by the
 * same rule as session routing, so one topic stays FIFO while different topics of the same
 * group run in parallel. Other scopes and DMs keep the per-chat lane.
 */
function resolveFeishuSequentialTopicId(params: {
  event: FeishuMessageEvent;
  chatId: string;
  feishuCfg?: FeishuConfig;
}): string | null {
  const { event, chatId, feishuCfg } = params;
  const chatType = normalizeFeishuEventChatType(event.message.chat_type);
  if (!feishuCfg || !isFeishuGroupChatType(chatType)) {
    return null;
  }
  const { topicId } = resolveFeishuGroupTopic({
    messageId: event.message.message_id,
    rootId: event.message.root_id || undefined,
    threadId: event.message.thread_id || undefined,
    chatType,
    groupConfig: resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: chatId }),
    feishuCfg,
  });
  return topicId || null;
}
