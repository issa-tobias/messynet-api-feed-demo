import express, { Express, NextFunction, Request, Response } from "express";
import { ClientConfig } from "../types/config";
import { DataSource } from "../data/dataSource";
import { RunLogger } from "../engine/runLogger";
import { apiKeyAuth, enforceHttps } from "./middleware/auth";
import { createDeltaFeedRouter } from "./routes/deltaFeed";
import { createRunLogRouter } from "./routes/runLog";

// JSON 404 for unmatched routes/methods. Registered by the top-level app
// (index.ts / demoServer.ts) AFTER all routes - not inside createServer,
// which gets embedded in larger apps whose sibling routes register later.
export function jsonNotFound(req: Request, res: Response): void {
  res.status(404).json({ error: "not_found", message: `No route for ${req.method} ${req.path}` });
}

// JSON error handler: no HTML error pages, no stack traces or server
// file paths in responses (Express's default handler leaks both).
// Body-parser JSON syntax errors surface as 400s.
export function jsonErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const isSyntaxError = err instanceof SyntaxError;
  const status =
    typeof err === "object" && err !== null && "status" in err && typeof (err as { status: unknown }).status === "number"
      ? (err as { status: number }).status
      : isSyntaxError
        ? 400
        : 500;
  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error("Unhandled API error:", err);
  }
  res.status(status).json({
    error: status === 400 ? "bad_request" : status >= 500 ? "internal_error" : "request_error",
    message: isSyntaxError ? "Request body is not valid JSON" : status >= 500 ? "Internal server error" : String((err as Error)?.message ?? "Request failed"),
  });
}

export function createServer(clients: ClientConfig[], dataSource: DataSource, runLogger: RunLogger): Express {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/v2/feed", enforceHttps, apiKeyAuth(clients));
  // Run Log ("/v2/feed/runs") must be registered before the Delta Polling
  // router: Delta's "/v2/feed/:feedType" wildcard would otherwise match
  // "runs" as a feed type and shadow this route.
  app.use(createRunLogRouter(runLogger));
  app.use(createDeltaFeedRouter(dataSource));
  // All /v2/* paths are exclusively ours even when this app is embedded -
  // catch wrong methods/paths under /v2 here with a JSON 404.
  app.all("/v2/*", jsonNotFound);

  return app;
}
