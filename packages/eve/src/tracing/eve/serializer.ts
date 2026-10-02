import { isUserMessageKind } from "#harness/messages.js";
import { aiSdkContentSerializer } from "#tracing/lib/adapters/serializer.js";
import { genAiInputMessagesAttribute } from "#tracing/lib/adapters/serialization.js";
import type { ContentSerializer } from "#tracing/lib/core/model.js";

export const eveContentSerializer: ContentSerializer = {
  ...aiSdkContentSerializer,
  inputMessages: (messages) =>
    genAiInputMessagesAttribute(messages, (value) =>
      isUserMessageKind(value) ? value : undefined,
    ),
};
