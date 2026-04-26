import type { SeamDatabase } from "./types.js";

export interface PruneSeqLogOptions {
  beforeSeq: number;
}

export interface PruneSeqLogResult {
  minRetainedSeq: number;
  prunedSeqLogEntries: number;
  prunedReceipts: number;
}

export async function pruneSeqLog(
  db: SeamDatabase,
  options: PruneSeqLogOptions,
): Promise<PruneSeqLogResult> {
  return db.pruneSeqLog(options.beforeSeq);
}
