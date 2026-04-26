import type { OutboxEntry, SeamDatabase } from "./types.js";

export interface ConsumeOutboxOptions {
  consumerName: string;
  limit: number;
  process(entry: OutboxEntry): Promise<void> | void;
}

export interface ConsumeOutboxResult {
  processed: number;
  lastOutboxId: number;
  hasMore: boolean;
}

export async function consumeOutbox(
  db: SeamDatabase,
  options: ConsumeOutboxOptions,
): Promise<ConsumeOutboxResult> {
  const lastOutboxId = await db.getOutboxConsumerCursor(options.consumerName);
  const limit = Math.max(1, options.limit);
  const entries = await db.listOutboxAfter(lastOutboxId, limit);
  let cursor = lastOutboxId;
  let processed = 0;

  for (const entry of entries) {
    await options.process(entry);
    cursor = entry.id;
    processed += 1;
  }

  await db.setOutboxConsumerCursor(options.consumerName, cursor);

  return { processed, lastOutboxId: cursor, hasMore: entries.length === limit };
}
