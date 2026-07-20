// Run Logger component (PRD §2.3, §7.4 Run Log Endpoint).
// In-memory store for this build; swapping to a persistent store (Mongo,
// Postgres) is a one-file change since everything else talks to this
// interface's methods only.

import { RunLogEntry, RunStatus } from "../types/runLog";

export class RunLogger {
  private entries = new Map<string, RunLogEntry>();

  create(entry: RunLogEntry): void {
    this.entries.set(entry.run_id, entry);
  }

  update(runId: string, patch: Partial<RunLogEntry>): void {
    const existing = this.entries.get(runId);
    if (!existing) throw new Error(`No run log entry for run_id=${runId}`);
    this.entries.set(runId, { ...existing, ...patch });
  }

  get(runId: string): RunLogEntry | undefined {
    return this.entries.get(runId);
  }

  query(opts: { clientId: string; since?: string; status?: RunStatus }): RunLogEntry[] {
    const sinceTime = opts.since ? new Date(opts.since).getTime() : -Infinity;
    return Array.from(this.entries.values())
      .filter((e) => e.client_id === opts.clientId)
      .filter((e) => new Date(e.scheduled_at).getTime() >= sinceTime)
      .filter((e) => (opts.status ? e.status === opts.status : true))
      .sort((a, b) => new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime());
  }
}

// Process-wide singleton so the scheduler, delivery agent, and API routes
// all observe the same run log without passing it through every layer.
export const runLogger = new RunLogger();
