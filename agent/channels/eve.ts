import { eveChannel } from "eve/channels/eve";
import { none } from "eve/channels/auth";

export default eveChannel({
  // Anonymous, so the two requests in the README need no token. The agent
  // has no real model behind it and never calls a tool.
  auth: none(),
});
