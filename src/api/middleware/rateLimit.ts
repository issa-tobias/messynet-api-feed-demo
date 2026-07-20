// Rate limiting middleware (PRD §8 Rate Limits & Quotas). Fixed-window
// counters per client_id, tier-scaled via RATE_LIMITS. Every figure here
// is flagged in the PRD as a PLACEHOLDER pending the engineering stress test
// (open item J4) - swap RATE_LIMITS in src/config/constants.ts once
// real numbers are approved.

import { NextFunction, Response } from "express";
import { AuthedRequest } from "./auth";
import { RATE_LIMITS } from "../../config/constants";

interface WindowCounter {
  windowStart: number;
  count: number;
}

const counters = new Map<string, WindowCounter>();

function checkWindow(key: string, windowMs: number, limit: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const existing = counters.get(key);
  if (!existing || now - existing.windowStart >= windowMs) {
    counters.set(key, { windowStart: now, count: 1 });
    return { ok: true, retryAfterSec: 0 };
  }
  existing.count += 1;
  if (existing.count > limit) {
    const retryAfterSec = Math.ceil((existing.windowStart + windowMs - now) / 1000);
    return { ok: false, retryAfterSec };
  }
  return { ok: true, retryAfterSec: 0 };
}

export function deltaRateLimit(req: AuthedRequest, res: Response, next: NextFunction): void {
  const client = req.client!;
  const limits = RATE_LIMITS[client.sla_tier];
  const result = checkWindow(`delta:${client.client_id}`, 60_000, limits.deltaRequestsPerMinute);
  if (!result.ok) {
    res.set("Retry-After", String(result.retryAfterSec));
    res.status(429).json({
      error: "rate_limited",
      message: `Delta endpoint limit of ${limits.deltaRequestsPerMinute} req/min exceeded for tier=${client.sla_tier}`,
    });
    return;
  }
  next();
}

export function runLogRateLimit(req: AuthedRequest, res: Response, next: NextFunction): void {
  const client = req.client!;
  const limits = RATE_LIMITS[client.sla_tier];
  const result = checkWindow(`runlog:${client.client_id}`, 60 * 60_000, limits.runLogQueriesPerHour);
  if (!result.ok) {
    res.set("Retry-After", String(result.retryAfterSec));
    res.status(429).json({
      error: "rate_limited",
      message: `Run log query limit of ${limits.runLogQueriesPerHour} req/hr exceeded for tier=${client.sla_tier}`,
    });
    return;
  }
  next();
}
