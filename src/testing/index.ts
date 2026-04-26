import { seamD1Schema } from "../server/schema.js";

interface StoredRecord {
  id: string;
  type: string;
  scopeKind: string;
  scopeId: string;
  version: number;
  data: Record<string, unknown>;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  deletedAt?: string;
  lastOpId: string;
}

interface SeqLogEntry {
  seq: number;
  opId: string;
  scopeKind: string;
  scopeId: string;
  recordType: string;
  recordId: string;
  mutationType: string;
  actorId: string;
  timestamp: string;
  version: number;
}

export interface TestD1 {
  schemaApplied: boolean;
  tables: Set<string>;
  records: StoredRecord[];
  seqLog: SeqLogEntry[];
  tableNames(): string[];
  seqLogEntries(): SeqLogEntry[];
  createRecord(record: StoredRecord): Promise<void>;
  appendSeqLog(entry: Omit<SeqLogEntry, "seq">): Promise<number>;
}

export function createTestD1(): TestD1 {
  return {
    schemaApplied: false,
    tables: new Set(),
    records: [],
    seqLog: [],
    tableNames() {
      return [...this.tables].sort();
    },
    seqLogEntries() {
      return [...this.seqLog];
    },
    async createRecord(record) {
      this.records.push(record);
    },
    async appendSeqLog(entry) {
      const seq = this.seqLog.length + 1;
      this.seqLog.push({ ...entry, seq });
      return seq;
    },
  };
}

export async function migrateSeamD1(db: TestD1): Promise<void> {
  if (
    !seamD1Schema.includes("CREATE TABLE records") ||
    !seamD1Schema.includes("CREATE TABLE seq_log")
  ) {
    throw new Error("Invalid Seam D1 schema");
  }

  db.schemaApplied = true;
  db.tables = new Set([
    "records",
    "seq_log",
    "seam_batch_assertions",
    "mutation_receipts",
    "outbox",
  ]);
}
