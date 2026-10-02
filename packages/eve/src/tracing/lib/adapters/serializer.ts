import {
  contentAttribute,
  textContentAttribute,
  genAiInputMessagesAttribute,
  genAiSystemInstructionsAttribute,
  genAiOutputMessagesAttribute,
  toolResultsContentAttribute,
} from "#tracing/lib/adapters/serialization.js";
import type { ContentSerializer } from "#tracing/lib/core/model.js";

export const aiSdkContentSerializer: ContentSerializer = {
  json: contentAttribute,
  text: textContentAttribute,
  inputMessages: (messages) =>
    genAiInputMessagesAttribute(messages, (value) =>
      typeof value === "string" ? value : undefined,
    ),
  instructions: genAiSystemInstructionsAttribute,
  outputMessages: genAiOutputMessagesAttribute,
  toolResults: toolResultsContentAttribute,
};
