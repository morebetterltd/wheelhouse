import type { NeedEvent } from "../needs";

export type OutboundNeedEvent =
  | Extract<NeedEvent, { type: "opened" }>
  | Extract<NeedEvent, { type: "message" }>
  | Extract<NeedEvent, { type: "closed" }>;

export interface TransportReply {
  needRef: string;
  text: string;
  from: string;
  at: string;
}

export interface TransportPollResult {
  replies: TransportReply[];
  cursor: string;
}

export interface TransportSendResult { ref: string }

export interface NeedTransport {
  name: string;
  send(ev: OutboundNeedEvent): Promise<TransportSendResult>;
  poll(cursor?: string): Promise<TransportPollResult>;
}

export interface InboundMessage {
  ref: string;
  from: string;
  fromName?: string;
  text: string;
  at: string;
  threadRef?: string;
}

export interface ChannelTransport {
  kind: "telegram" | "slack" | "teams";
  post(destination: string, text: string, opts?: { threadRef?: string }): Promise<{ ref: string; readBack: "fetched" | "echo" }>;
  readBack(destination: string, ref: string, text: string): Promise<boolean>;
  read(destination: string, cursor?: string): Promise<{ messages: InboundMessage[]; cursor: string }>;
}
