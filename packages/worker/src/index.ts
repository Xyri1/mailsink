import { handleFetch } from "./api";
import { handleEmail, type ForwardableEmailMessageLike } from "./ingest";
import type { Env } from "./types";

export default {
  fetch(request: Request, env: Env) {
    return handleFetch(request, env);
  },

  email(message: ForwardableEmailMessageLike, env: Env) {
    return handleEmail(message, env);
  }
};
