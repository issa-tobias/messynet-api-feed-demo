// Constants encoding the PRD's numeric assumptions. Every value here is
// either an explicit "Recommended" default in the PRD or a value already
// given in a table, even where the surrounding prose flags it as a
// PLACEHOLDER pending CTO/CEO sign-off (see PRD §11). Flagged inline.

import { SlaTier } from "../types/config";

// §5.2 Schema Version Registry
export const SCHEMA_VERSIONS = {
  pipeline: "pipeline-v1",
  atlas: "atlas-v1",
  reputation: "reputation-v1",
  composite: "composite-v1",
} as const;

// §7.2 Webhook Retry Policy - "5-attempt exponential backoff is a working
// assumption" (PLACEHOLDER, open item C12/J8). Implemented as specified;
// swap this table if the CTO approves a simpler 3-attempt policy instead.
export const RETRY_SCHEDULE_MS = [
  0, // Attempt 1: immediate
  5 * 60 * 1000, // Attempt 2: +5 min
  30 * 60 * 1000, // Attempt 3: +30 min
  2 * 60 * 60 * 1000, // Attempt 4: +2 hours
  6 * 60 * 60 * 1000, // Attempt 5 (final): +6 hours
];

export const MAX_DELIVERY_ATTEMPTS = RETRY_SCHEDULE_MS.length;

// §6.1 API Key Model
export const WEBHOOK_TIMEOUT_MS = 30_000;
export const KEY_ROTATION_GRACE_HOURS = 72;

// §3.3 Reputation Feed
export const MAX_BRANDS_PER_CLIENT = 10; // MAX_BRANDS constant, the MessyRep codebase

// §8 Rate Limits & Quotas - PLACEHOLDER pending the engineering stress test against
// actual Cloud Run capacity (open item J4). Encoded here exactly as given
// in the PRD table so they're one config change away from the real numbers.
export const RATE_LIMITS: Record<
  SlaTier,
  {
    deltaRequestsPerMinute: number;
    deltaRecordsPerResponse: number;
    runLogQueriesPerHour: number;
    maxWebhookPayloadBytes: number;
    maxCloudStorageFileBytes: number;
  }
> = {
  standard: {
    deltaRequestsPerMinute: 30,
    deltaRecordsPerResponse: 500,
    runLogQueriesPerHour: 60,
    maxWebhookPayloadBytes: 10 * 1024 * 1024,
    maxCloudStorageFileBytes: 500 * 1024 * 1024,
  },
  enterprise: {
    deltaRequestsPerMinute: 120,
    deltaRecordsPerResponse: 2000,
    runLogQueriesPerHour: 300,
    maxWebhookPayloadBytes: 50 * 1024 * 1024,
    maxCloudStorageFileBytes: 5 * 1024 * 1024 * 1024,
  },
  // PRD only tables Standard and Enterprise; Enterprise+ (§7.1) has no
  // distinct rate limit row, so it inherits Enterprise's until specified.
  enterprise_plus: {
    deltaRequestsPerMinute: 120,
    deltaRecordsPerResponse: 2000,
    runLogQueriesPerHour: 300,
    maxWebhookPayloadBytes: 50 * 1024 * 1024,
    maxCloudStorageFileBytes: 5 * 1024 * 1024 * 1024,
  },
};

// §4.3 Delta Polling Endpoint
export const DELTA_DEFAULT_LIMIT = 500;
export const DELTA_MAX_LOOKBACK_DAYS = 30; // PLACEHOLDER, open item J3
