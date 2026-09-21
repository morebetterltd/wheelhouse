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
