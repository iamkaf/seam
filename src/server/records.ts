import type { z } from "zod";
import { SeamError, type SeamRecord, type SeamScope } from "../shared/types.js";
import type {
  CreateMutationDefinition,
  MutateRequest,
  RecordType,
  SeamDatabase,
  SeamWrite,
  StoredRecord,
} from "./types.js";

export function resolveCreateScope<TInput>(
  mutation: CreateMutationDefinition<z.ZodType<TInput>>,
  input: TInput,
): SeamScope {
  if (!mutation.scope) {
    throw new SeamError("INVALID", "scope required");
  }

  return mutation.scope(input);
}

export async function loadCurrent(db: SeamDatabase, body: MutateRequest): Promise<StoredRecord> {
  if (!body.id || body.expectedVersion === undefined) {
    throw new SeamError("INVALID", "id and expectedVersion required");
  }

  const current = await db.getRecord(body.id);

  if (!current || current.deletedAt) {
    throw new SeamError("NOT_FOUND");
  }

  return current;
}

export async function commitWrite(
  db: SeamDatabase,
  write: SeamWrite,
  recordType: RecordType,
  actorId: string,
  now: string,
  opId: string,
): Promise<StoredRecord> {
  if (write.op === "create") {
    const data = recordType.schema.parse(write.data) as Record<string, unknown>;
    const storedRecord: StoredRecord = {
      id: write.id ?? crypto.randomUUID(),
      type: write.type,
      scopeKind: write.scope.kind,
      scopeId: write.scope.id,
      version: 1,
      data,
      createdAt: now,
      createdBy: actorId,
      updatedAt: now,
      updatedBy: actorId,
      lastOpId: opId,
    };

    await db.createRecord(storedRecord);
    return storedRecord;
  }

  if (write.op === "delete") {
    const deleted = await db.deleteRecord({
      id: write.id,
      type: write.type,
      expectedVersion: write.expectedVersion,
      deletedAt: now,
      updatedBy: actorId,
      lastOpId: opId,
    });

    if (!deleted) {
      throw new SeamError("VERSION_CONFLICT", "Version conflict");
    }

    return deleted;
  }

  const data = recordType.schema.parse(write.data) as Record<string, unknown>;
  const updated = await db.updateRecord({
    id: write.id,
    type: write.type,
    expectedVersion: write.expectedVersion,
    data,
    updatedAt: now,
    updatedBy: actorId,
    lastOpId: opId,
  });

  if (!updated) {
    throw new SeamError("VERSION_CONFLICT", "Version conflict");
  }

  return updated;
}

export function toPublicRecord(record: StoredRecord): SeamRecord {
  return {
    id: record.id,
    type: record.type,
    version: record.version,
    data: record.data,
    scopeKind: record.scopeKind,
    scopeId: record.scopeId,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
    deletedAt: record.deletedAt,
  };
}
