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
  inputMessages: genAiInputMessagesAttribute,
  instructions: genAiSystemInstructionsAttribute,
  outputMessages: genAiOutputMessagesAttribute,
  toolResults: toolResultsContentAttribute,
};
