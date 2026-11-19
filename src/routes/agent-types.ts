import type { DestinationName } from "../types.js";

export interface AckItemPayload {
  item_id: string;
  round: number;
  destination: DestinationName;
  redraw: boolean;
  archive_ref?: string | null;
}

export interface AckReceipt {
  archive: string[];
  repair: string[];
  discard: string[];
  redraw: string[];
}
