// Simulates a client's webhook endpoint receiving API Feed deliveries,
// including the HMAC verification example from PRD §6.2 (translated
// from the PRD's Python snippet to Node).

import crypto from "crypto";
import express, { Express } from "express";

export interface ReceivedDelivery {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  signatureValid: boolean | null; // null when no signature was sent
}

// Keyed by client_id, since one demo receiver process stands in for
// multiple distinct client endpoints, each with its own webhook secret.
// opts.shouldReject simulates the client's endpoint being down: while it
// returns true, every delivery gets a 503 - which is exactly what drives
// the PRD §7.2 retry/backoff/dead-letter path from the outside.
export function createWebhookReceiver(
  secretsByClientId: Record<string, string>,
  opts?: { shouldReject?: () => boolean }
): {
  app: Express;
  deliveries: ReceivedDelivery[];
} {
  const app = express();
  const deliveries: ReceivedDelivery[] = [];

  app.use(express.text({ type: "*/*", limit: "50mb" }));

  // Mounted at the caller's chosen path (see webhookServer.ts / runDemo.ts) -
  // this app owns exactly that one path, so its body-parser never runs for
  // unrelated sibling routes when embedded inside a larger app.
  app.post("/", (req, res) => {
    if (opts?.shouldReject?.()) {
      // A down endpoint records nothing - the delivery never "arrived".
      res.status(503).json({ error: "simulated_outage" });
      return;
    }
    let parsedBody: unknown = req.body;
    try {
      parsedBody = JSON.parse(req.body);
    } catch {
      // non-JSON body (e.g. CSV/NDJSON) - keep as raw text
    }

    const signatureHeader = req.headers["x-messynet-signature"];
    let signatureValid: boolean | null = null;

    if (typeof signatureHeader === "string") {
      const clientId = (parsedBody as { client_id?: string })?.client_id;
      const secret = clientId ? secretsByClientId[clientId] : undefined;
      if (secret) {
        const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req.body).digest("hex");
        signatureValid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
      } else {
        signatureValid = false;
      }
    }

    deliveries.push({ headers: req.headers, body: parsedBody, signatureValid });
    // Auto-deliver mode can run indefinitely - cap retained deliveries
    // (mutate in place: callers hold a reference to this array).
    while (deliveries.length > 100) deliveries.shift();

    if (signatureHeader && signatureValid === false) {
      res.status(401).json({ error: "invalid_signature" });
      return;
    }
    res.status(200).json({ received: true });
  });

  return { app, deliveries };
}
