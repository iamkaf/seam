import { seamD1Schema } from "../server/schema.js";
import type { CommitEffect } from "../server/index.js";
import type { SeamScope } from "../shared/types.js";

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

interface MutationReceipt {
  actorId: string;
  clientMutationId: string;
  requestHash: string;
  seq: number;
  scopeKind: string;
  scopeId: string;
  responseJson: string;
  createdAt: string;
}

interface OutboxEntry {
  id: number;
  opId: string;
  seq: number;
  scopeKind: string;
  scopeId: string;
  recordType?: string;
  recordId?: string;
  eventType: string;
  payload: Record<string, unknown>;
  actorId: string;
  createdAt: string;
}

interface OutboxInsert {
  opId: string;
  seq: number;
  scopeKind: string;
  scopeId: string;
  recordType?: string;
  recordId?: string;
  eventType: string;
  payload: Record<string, unknown>;
  actorId: string;
  createdAt: string;
}

export interface TestD1 {
  schemaApplied: boolean;
  tables: Set<string>;
  appTables: Map<string, Record<string, unknown>[]>;
  records: StoredRecord[];
  seqLog: SeqLogEntry[];
  receipts: MutationReceipt[];
  outbox: OutboxEntry[];
  outboxConsumerCursors: Map<string, number>;
  retainedSeqFloor: number;
  shouldFailNextReceiptInsert: boolean;
  tableNames(): string[];
  seqLogEntries(): SeqLogEntry[];
  receiptEntries(): MutationReceipt[];
  outboxEntries(): OutboxEntry[];
  consumerCursor(consumerName: string): number;
  minRetainedSeq(): number;
  createAppTable(name: string): void;
  appRows(name: string): Record<string, unknown>[];
  prepareAppInsert(tableName: string, row: Record<string, unknown>): CommitEffect;
  failNextReceiptInsert(): void;
  forceRecordVersion(id: string, version: number): void;
  runMutationBatch<T>(operation: () => Promise<T>): Promise<T>;
  getRecord(id: string): Promise<StoredRecord | undefined>;
  getRecords(ids: string[]): Promise<StoredRecord[]>;
  listRecordsForScopes(scopes: SeamScope[]): Promise<StoredRecord[]>;
  listSeqForScopes(request: SeqScanRequest): Promise<SeqLogEntry[]>;
  getMaxSeq(): Promise<number>;
  getMutationReceipt(
    actorId: string,
    clientMutationId: string,
  ): Promise<MutationReceipt | undefined>;
  createRecord(record: StoredRecord): Promise<void>;
  updateRecord(write: UpdateRecordWrite): Promise<StoredRecord | undefined>;
  deleteRecord(write: DeleteRecordWrite): Promise<StoredRecord | undefined>;
  appendSeqLog(entry: Omit<SeqLogEntry, "seq">): Promise<number>;
  createMutationReceipt(receipt: MutationReceipt): Promise<void>;
  appendOutbox(entry: OutboxInsert): Promise<number>;
  listOutboxAfter(lastOutboxId: number, limit: number): Promise<OutboxEntry[]>;
  getOutboxConsumerCursor(consumerName: string): Promise<number>;
  setOutboxConsumerCursor(consumerName: string, lastOutboxId: number): Promise<void>;
  getMinRetainedSeq(): Promise<number>;
  pruneSeqLog(beforeSeq: number): Promise<PruneSeqLogResult>;
}

interface PruneSeqLogResult {
  minRetainedSeq: number;
  prunedSeqLogEntries: number;
  prunedReceipts: number;
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

interface SeqScanRequest {
  scopes: SeamScope[];
  afterSeq: number;
  untilSeq?: number;
  limit: number;
}

export function createTestD1(): TestD1 {
  return {
    schemaApplied: false,
    tables: new Set(),
    appTables: new Map(),
    records: [],
    seqLog: [],
    receipts: [],
    outbox: [],
    outboxConsumerCursors: new Map(),
    retainedSeqFloor: 0,
    shouldFailNextReceiptInsert: false,
    tableNames() {
      return [...this.tables].sort();
    },
    seqLogEntries() {
      return [...this.seqLog];
    },
    receiptEntries() {
      return [...this.receipts];
    },
    outboxEntries() {
      return [...this.outbox];
    },
    consumerCursor(consumerName) {
      return this.outboxConsumerCursors.get(consumerName) ?? 0;
    },
    minRetainedSeq() {
      return this.retainedSeqFloor;
    },
    createAppTable(name) {
      this.appTables.set(name, []);
    },
    appRows(name) {
      return this.appTables.get(name) ?? [];
    },
    prepareAppInsert(tableName, row) {
      return {
        tableName,
        execute: () => {
          const rows = this.appTables.get(tableName);

          if (!rows) {
            throw new Error(`Unknown app table: ${tableName}`);
          }

          rows.push(row);
        },
      };
    },
    failNextReceiptInsert() {
      this.shouldFailNextReceiptInsert = true;
    },
    forceRecordVersion(id, version) {
      const record = this.records.find((candidate) => candidate.id === id);

      if (record) {
        record.version = version;
      }
    },
    async runMutationBatch(operation) {
      const records = this.records.map((record) => ({ ...record, data: { ...record.data } }));
      const seqLog = this.seqLog.map((entry) => ({ ...entry }));
      const receipts = this.receipts.map((receipt) => ({ ...receipt }));
      const outbox = this.outbox.map((entry) => ({ ...entry, payload: { ...entry.payload } }));
      const outboxConsumerCursors = new Map(this.outboxConsumerCursors);
      const appTables = new Map(
        [...this.appTables.entries()].map(([name, rows]) => [
          name,
          rows.map((row) => ({ ...row })),
        ]),
      );

      try {
        return await operation();
      } catch (error) {
        this.records = records;
        this.seqLog = seqLog;
        this.receipts = receipts;
        this.outbox = outbox;
        this.outboxConsumerCursors = outboxConsumerCursors;
        this.appTables = appTables;
        throw error;
      }
    },
    async getRecord(id) {
      return this.records.find((record) => record.id === id);
    },
    async getRecords(ids) {
      return ids.flatMap((id) => {
        const record = this.records.find((candidate) => candidate.id === id);

        return record ? [record] : [];
      });
    },
    async listRecordsForScopes(scopes) {
      return this.records.filter((record) =>
        scopes.some((scope) => scope.kind === record.scopeKind && scope.id === record.scopeId),
      );
    },
    async listSeqForScopes(request) {
      return this.seqLog
        .filter(
          (entry) =>
            entry.seq > request.afterSeq &&
            (request.untilSeq === undefined || entry.seq <= request.untilSeq) &&
            request.scopes.some(
              (scope) => scope.kind === entry.scopeKind && scope.id === entry.scopeId,
            ),
        )
        .sort((left, right) => left.seq - right.seq)
        .slice(0, request.limit);
    },
    async getMaxSeq() {
      return this.seqLog.at(-1)?.seq ?? 0;
    },
    async getMutationReceipt(actorId, clientMutationId) {
      return this.receipts.find(
        (receipt) => receipt.actorId === actorId && receipt.clientMutationId === clientMutationId,
      );
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
    async createMutationReceipt(receipt) {
      if (this.shouldFailNextReceiptInsert) {
        this.shouldFailNextReceiptInsert = false;
        throw new Error("receipt insert failed");
      }

      this.receipts.push(receipt);
    },
    async appendOutbox(entry) {
      const id = this.outbox.length + 1;
      this.outbox.push({ ...entry, id });
      return id;
    },
    async listOutboxAfter(lastOutboxId, limit) {
      return this.outbox.filter((entry) => entry.id > lastOutboxId).slice(0, limit);
    },
    async getOutboxConsumerCursor(consumerName) {
      return this.consumerCursor(consumerName);
    },
    async setOutboxConsumerCursor(consumerName, lastOutboxId) {
      this.outboxConsumerCursors.set(consumerName, lastOutboxId);
    },
    async getMinRetainedSeq() {
      return this.retainedSeqFloor;
    },
    async pruneSeqLog(beforeSeq) {
      const previousSeqLogCount = this.seqLog.length;
      const previousReceiptCount = this.receipts.length;

      this.seqLog = this.seqLog.filter((entry) => entry.seq >= beforeSeq);
      this.receipts = this.receipts.filter((receipt) => receipt.seq >= beforeSeq);
      this.retainedSeqFloor = Math.max(this.retainedSeqFloor, beforeSeq);

      return {
        minRetainedSeq: this.retainedSeqFloor,
        prunedSeqLogEntries: previousSeqLogCount - this.seqLog.length,
        prunedReceipts: previousReceiptCount - this.receipts.length,
      };
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
    "seam_retention",
  ]);
}
