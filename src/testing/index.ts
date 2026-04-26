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
  getRecord(id: string): Promise<StoredRecord | undefined>;
  createRecord(record: StoredRecord): Promise<void>;
  updateRecord(write: UpdateRecordWrite): Promise<StoredRecord | undefined>;
  deleteRecord(write: DeleteRecordWrite): Promise<StoredRecord | undefined>;
  appendSeqLog(entry: Omit<SeqLogEntry, "seq">): Promise<number>;
}

interface UpdateRecordWrite {
  id: string;
  type: string;
  expectedVersion: number;
  data: Record<string, unknown>;
  updatedAt: string;
  updatedBy: string;
  lastOpId: string;
}

interface DeleteRecordWrite {
  id: string;
  type: string;
  expectedVersion: number;
  deletedAt: string;
  updatedBy: string;
  lastOpId: string;
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
    async getRecord(id) {
      return this.records.find((record) => record.id === id);
    },
    async createRecord(record) {
      this.records.push(record);
    },
    async updateRecord(write) {
      const record = this.records.find(
        (candidate) =>
          candidate.id === write.id &&
          candidate.type === write.type &&
          candidate.version === write.expectedVersion,
      );

      if (!record) {
        return undefined;
      }

      record.version += 1;
      record.data = write.data;
      record.updatedAt = write.updatedAt;
      record.updatedBy = write.updatedBy;
      record.lastOpId = write.lastOpId;

      return record;
    },
    async deleteRecord(write) {
      const record = this.records.find(
        (candidate) =>
          candidate.id === write.id &&
          candidate.type === write.type &&
          candidate.version === write.expectedVersion,
      );

      if (!record) {
        return undefined;
      }

      record.version += 1;
      record.deletedAt = write.deletedAt;
      record.updatedAt = write.deletedAt;
      record.updatedBy = write.updatedBy;
      record.lastOpId = write.lastOpId;

      return record;
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
