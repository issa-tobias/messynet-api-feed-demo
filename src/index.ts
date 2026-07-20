// Feed Engine + API process bootstrap. Production entry point: starts
// the Scheduler (push deliveries) and the REST API (Delta Polling + Run
// Log endpoints) in the same process. PRD §2.3's open item C1 (standalone
// service vs. extension of Data API v2 vs. cron layer) is the CTO's call;
// this is built as a standalone service, which is the least assumption-
// laden of the three options to demonstrate against.

import { MockDataSource } from "./data/mockDataSource";
import { Extractor } from "./engine/extractor";
import { FeedEngine } from "./engine/feedEngine";
import { Scheduler } from "./engine/scheduler";
import { runLogger } from "./engine/runLogger";
import { createServer, jsonErrorHandler, jsonNotFound } from "./api/server";
import { SAMPLE_CLIENTS } from "./config/sampleClients";
import { InMemoryWebhookSecretProvider } from "./config/webhookSecrets";

const PORT = Number(process.env.PORT) || 4000;

const dataSource = new MockDataSource();
const extractor = new Extractor(dataSource);
const secrets = new InMemoryWebhookSecretProvider();
const engine = new FeedEngine(dataSource, extractor, secrets);

const scheduler = new Scheduler(engine, SAMPLE_CLIENTS);
scheduler.start();

const app = createServer(SAMPLE_CLIENTS, dataSource, runLogger);
app.use(jsonNotFound);
app.use(jsonErrorHandler);
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`MessyNet API Feed engine listening on :${PORT}`);
});
