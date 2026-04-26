import { SeamError, type SeamScope } from "../shared/types.js";
import { commitWrite } from "./records.js";
import type { RecordType, SeamDatabase, SeamWrite } from "./types.js";

export type ImportRecord =
  | {
      op: "create";
      type: string;
      data: Record<string, unknown>;
      id?: string;
    }
  | {
      op: "update";
      id: string;
      type: string;
      data: Record<string, unknown>;
    }
  | {
      op: "delete";
      id: string;
      type: string;
    };

export interface ImportRecordsOptions {
  actorId: string;
  scope: SeamScope;
  mutationType: string;
  records: ImportRecord[];
  chunkSize: number;
}

export interface ImportChunkResult {
  ok: boolean;
  seq: number;
  created: number;
  updated: number;
  deleted: number;
  error?: string;
}

export interface ImportRecordsResult {
  importId: string;
  ok: boolean;
  seq: number;
  created: number;
  updated: number;
  deleted: number;
  chunks: ImportChunkResult[];
}

export async function importRecords(
  db: SeamDatabase,
  recordTypes: Map<string, RecordType>,
  options: ImportRecordsOptions,
): Promise<ImportRecordsResult> {
  const importId = crypto.randomUUID();
  const chunkSize = Math.max(1, options.chunkSize);
  const chunks: ImportChunkResult[] = [];
  let seq = 0;
  let created = 0;
  let updated = 0;
  let deleted = 0;

  for (let index = 0; index < options.records.length; index += chunkSize) {
    const records = options.records.slice(index, index + chunkSize);

    try {
      const chunk = await db.runMutationBatch(async () => {
        const now = new Date().toISOString();
        const opId = crypto.randomUUID();
        const counts = { created: 0, updated: 0, deleted: 0 };
        let chunkSeq = seq;

        for (const record of records) {
          const recordType = recordTypes.get(record.type);

          if (!recordType) {
            throw new SeamError("INVALID", "Unknown record type");
          }

          const write = await toImportWrite(db, options.scope, record);
          const storedRecord = await commitWrite(db, write, recordType, options.actorId, now, opId);
          chunkSeq = await db.appendSeqLog({
            opId,
            scopeKind: storedRecord.scopeKind,
            scopeId: storedRecord.scopeId,
            recordType: storedRecord.type,
            recordId: storedRecord.id,
            mutationType: options.mutationType,
            actorId: options.actorId,
            timestamp: now,
            version: storedRecord.version,
          });

          if (record.op === "create") counts.created += 1;
          if (record.op === "update") counts.updated += 1;
          if (record.op === "delete") counts.deleted += 1;
        }

        return { ok: true, seq: chunkSeq, ...counts };
      });

      chunks.push(chunk);
      seq = chunk.seq;
      created += chunk.created;
      updated += chunk.updated;
      deleted += chunk.deleted;
    } catch (error) {
      chunks.push({
        ok: false,
        seq,
        created: 0,
        updated: 0,
        deleted: 0,
        error: error instanceof Error ? error.message : "Import chunk failed",
      });
      break;
    }
  }

  return {
    importId,
    ok: chunks.every((chunk) => chunk.ok),
    seq,
    created,
    updated,
    deleted,
    chunks,
  };
}

async function toImportWrite(
  db: SeamDatabase,
  scope: SeamScope,
  record: ImportRecord,
): Promise<SeamWrite> {
  if (record.op === "create") {
    return { ...record, scope };
  }

  const current = await db.getRecord(record.id);

  if (!current || current.deletedAt) {
    throw new SeamError("NOT_FOUND");
  }

  if (
    current.type !== record.type ||
    current.scopeKind !== scope.kind ||
    current.scopeId !== scope.id
  ) {
    throw new SeamError("NOT_FOUND");
  }

  if (record.op === "delete") {
    return {
      op: "delete",
      id: record.id,
      type: record.type,
      expectedVersion: current.version,
    };
  }

  return {
    op: "update",
    id: record.id,
    type: record.type,
    expectedVersion: current.version,
    data: record.data,
  };
}
