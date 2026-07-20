// Scheduler component (PRD §2.3): "cron / event trigger per client config".

import cron, { ScheduledTask } from "node-cron";
import { ClientConfig } from "../types/config";
import { FeedEngine } from "./feedEngine";

export class Scheduler {
  private tasks: ScheduledTask[] = [];

  constructor(private engine: FeedEngine, private clients: ClientConfig[]) {}

  start(): void {
    for (const client of this.clients) {
      for (const feedConfig of client.feeds) {
        if (feedConfig.delivery.mechanism === "delta") {
          // Nothing to schedule - delta is pull-only (see feedEngine.ts).
          continue;
        }
        if (!cron.validate(feedConfig.cadence)) {
          // eslint-disable-next-line no-console
          console.error(
            `Invalid cron cadence "${feedConfig.cadence}" for client=${client.client_id} feed=${feedConfig.feed_type} - not scheduled`
          );
          continue;
        }
        const task = cron.schedule(
          feedConfig.cadence,
          () => {
            this.engine.runFeed(client, feedConfig).catch((err) => {
              // eslint-disable-next-line no-console
              console.error(
                `Unhandled error running feed client=${client.client_id} feed=${feedConfig.feed_type}:`,
                err
              );
            });
          },
          { timezone: "UTC" }
        );
        this.tasks.push(task);
      }
    }
  }

  stop(): void {
    for (const task of this.tasks) task.stop();
    this.tasks = [];
  }
}
