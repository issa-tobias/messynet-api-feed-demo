// API Key auth middleware (PRD §6.1 API Key Model).
//
// - Bearer token, scoped to a single client_id (cross-client isolation:
//   a key can only ever resolve to the client it was issued for).
// - Per-key scope check against the feed type being requested.
// - HTTPS enforcement is delegated to the Cloud Run ingress in
//   production (TLS terminates there; requests reach this process over
//   plain HTTP from the load balancer with x-forwarded-proto set). We
//   check that header when present rather than req.secure, so the demo
//   can run locally without TLS.

import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { ClientConfig } from "../../types/config";

export interface AuthedRequest extends Request {
  client?: ClientConfig;
}

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function enforceHttps(req: Request, res: Response, next: NextFunction): void {
  const proto = req.headers["x-forwarded-proto"];
  const isLocalDev = req.hostname === "localhost" || req.hostname === "127.0.0.1";
  if (isLocalDev || proto === "https" || req.secure) {
    return next();
  }
  res.status(301).json({ error: "https_required", message: "Plain HTTP requests are rejected. Use HTTPS." });
}

export function apiKeyAuth(clients: ClientConfig[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "unauthorized", message: "Missing Bearer token" });
      return;
    }
    const rawKey = header.slice("Bearer ".length).trim();
    const hash = hashKey(rawKey);
    const client = clients.find((c) => c.auth.api_key_hash === hash);
    if (!client) {
      res.status(401).json({ error: "unauthorized", message: "Invalid API key" });
      return;
    }
    req.client = client;
    next();
  };
}

export function requireScope(scopePrefix: (req: AuthedRequest) => string) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const client = req.client!;
    const needed = scopePrefix(req);
    const hasScope = client.auth.scopes.some((s) => s === needed || s === "*:read");
    if (!hasScope) {
      res.status(403).json({
        error: "forbidden",
        message: `API key for client_id=${client.client_id} is not scoped for ${needed}`,
      });
      return;
    }
    next();
  };
}
