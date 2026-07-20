// Per-client webhook signing secrets (PRD §6.2 HMAC-SHA256 Signature).
// In production these are generated at contract time and stored in a
// secrets manager, never in source. Demo values only.

import { WebhookSecretProvider } from "../engine/feedEngine";
import { DEMO_API_KEYS } from "./sampleClients";

const DEMO_SECRETS: Record<string, string> = {
  "solstice-sg": "demo-webhook-secret-solstice-sg",
  "orbit-whitelabel": "demo-webhook-secret-orbit-whitelabel",
};

export class InMemoryWebhookSecretProvider implements WebhookSecretProvider {
  getSecret(clientId: string): string {
    const secret = DEMO_SECRETS[clientId];
    if (!secret) throw new Error(`No webhook secret configured for client_id=${clientId}`);
    return secret;
  }

  // The key delivered in X-MessyNet-Key must be the client's own scoped
  // key (PRD §6.1) - the server config stores only its hash, so the raw
  // key is resolved here (stand-in for a secrets manager lookup).
  getApiKey(clientId: string): string {
    const key = (DEMO_API_KEYS as Record<string, string>)[clientId];
    if (!key) throw new Error(`No API key configured for client_id=${clientId}`);
    return key;
  }
}
