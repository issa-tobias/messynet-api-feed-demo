// Run Log Endpoint (PRD §7.4): GET /v2/feed/runs?since=&status=
//
// PRD flags this as proposed-but-not-yet-existing in the current Data
// API v2 codebase (open item C6/J7). Implemented here against the
// in-memory RunLogger; swap for a persistent store when this graduates
// out of the Feed Engine's own process.

import { Router, Response } from "express";
import { AuthedRequest } from "../middleware/auth";
import { runLogRateLimit } from "../middleware/rateLimit";
import { RunLogger } from "../../engine/runLogger";
import { RunStatus } from "../../types/runLog";

const VALID_STATUSES: RunStatus[] = ["pending", "retrying", "success", "failed"];

export function createRunLogRouter(runLogger: RunLogger): Router {
  const router = Router();

  router.get("/v2/feed/runs", runLogRateLimit, (req: AuthedRequest, res: Response) => {
    const client = req.client!;
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;

    if (since && Number.isNaN(new Date(since).getTime())) {
      res.status(400).json({ error: "bad_request", message: "'since' is not a valid ISO8601 timestamp" });
      return;
    }
    if (statusRaw && !VALID_STATUSES.includes(statusRaw as RunStatus)) {
      res.status(400).json({
        error: "bad_request",
        message: `'status' must be one of ${VALID_STATUSES.join(", ")}`,
      });
      return;
    }

    const runs = runLogger.query({
      clientId: client.client_id,
      since,
      status: statusRaw as RunStatus | undefined,
    });

    res.json({ runs });
  });

  return router;
}
