import { handleDeliveryEvents, handleFetch } from "./api";
import { handleEmail, type ForwardableEmailMessageLike } from "./ingest";
import type { Env, QueueBatch } from "./types";

export default {
  fetch(request: Request, env: Env) {
    return handleFetch(request, env);
  },

  email(message: ForwardableEmailMessageLike, env: Env) {
    return handleEmail(message, env);
  },

  queue(batch: QueueBatch<unknown>, env: Env) {
    return handleDeliveryEvents(batch, env);
  }
};
