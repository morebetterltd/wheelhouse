import type { ChannelTransport } from "./transport";
import { TelegramTransport } from "./telegram";
import { SlackTransport } from "./slack";
import { TeamsTransport } from "./teams";

export function transportFor(root: string, kind: "telegram" | "slack" | "teams"): ChannelTransport {
  if (kind === "telegram") return new TelegramTransport(root);
  if (kind === "slack") return new SlackTransport(root);
  return new TeamsTransport(root);
}
