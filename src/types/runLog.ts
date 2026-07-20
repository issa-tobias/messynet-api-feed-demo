// Run Log types per PRD §7.4 (Run Log Endpoint).

import { DeliveryMechanism } from "./config";
import { FeedTypeName } from "./feed";

export type RunStatus = "pending" | "retrying" | "success" | "failed";

export interface RunLogEntry {
  run_id: string;
  client_id: string;
  feed_type: FeedTypeName;
  scheduled_at: string;
  delivered_at: string | null;
  status: RunStatus;
  delivery_mechanism: DeliveryMechanism;
  attempt_count: number;
  error?: string;
}
