import type { z } from "zod";
import { SeamError, type SeamRecord, type SeamScope } from "../shared/types.js";

export { SeamError } from "../shared/types.js";

export interface SeamContext {
  actorId: string | null;
  actorType: "anonymous" | "user" | "token" | "service";
}

export interface RecordType<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  schema: TSchema;
}

export interface CreateWrite {
  op: "create";
  type: string;
  scope: SeamScope;
  data: Record<string, unknown>;
  id?: string;
}

export interface UpdateWrite {
  op: "update";
  id: string;
  type: string;
  expectedVersion: number;
  data: Record<string, unknown>;
}

export interface DeleteWrite {
  op: "delete";
  id: string;
  type: string;
  expectedVersion: number;
}

export type SeamWrite = CreateWrite | UpdateWrite | DeleteWrite;

export interface MutationCommit {
  writes: SeamWrite[];
  primaryRecordId?: string;
}

type ScopeResolver<TInput> = {
  resolve(input: TInput): SeamScope;
}["resolve"];

type MutationExecutor<TInput> = {
  execute(
    input: TInput,
    ctx: { seam: SeamContext; scope: SeamScope; current: SeamRecord },
  ): MutationCommit | Promise<MutationCommit>;
}["execute"];

export interface CreateMutationDefinition<TInput extends z.ZodType = z.ZodType> {
  record?: string;
  input: TInput;
  scope?: ScopeResolver<z.output<TInput>>;
  execute: MutationExecutor<z.output<TInput>>;
}

export interface SeamDatabase {
  getRecord(id: string): Promise<StoredRecord | undefined>;
  createRecord(record: StoredRecord): Promise<void>;
  updateRecord(write: UpdateRecordWrite): Promise<StoredRecord | undefined>;
  deleteRecord(write: DeleteRecordWrite): Promise<StoredRecord | undefined>;
  appendSeqLog(entry: SeqLogInsert): Promise<number>;
}

export interface CreateSeamServerOptions<
  TMutations extends Record<string, CreateMutationDefinition>,
> {
  db: SeamDatabase;
  records: RecordType[];
  resolveContext: (request: Request, env?: unknown) => SeamContext | Promise<SeamContext>;
  mutations: TMutations;
}

interface MutateRequest {
  mutation: string;
  input: Record<string, unknown>;
  id?: string;
  expectedVersion?: number;
  clientMutationId: string;
}

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

interface SeqLogInsert {
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

export function defineRecordType<TSchema extends z.ZodType>(
  name: string,
  definition: { schema: TSchema },
): RecordType<TSchema> {
  return { name, schema: definition.schema };
}

export function createSeamServer<TMutations extends Record<string, CreateMutationDefinition>>(
  options: CreateSeamServerOptions<TMutations>,
) {
  const recordTypes = new Map(options.records.map((record) => [record.name, record]));

  return {
    fetch: async (request: Request, env?: unknown): Promise<Response> => {
      const url = new URL(request.url);

      if (request.method !== "POST" || url.pathname !== "/seam/mutate") {
        return json({ ok: false, error: { code: "NOT_FOUND", message: "Not found" } }, 404);
      }

      let body: Partial<MutateRequest> = {};

      try {
        const requestBody = (await request.json()) as MutateRequest;
        body = requestBody;
        const mutation = options.mutations[requestBody.mutation];

        if (!mutation) {
          throw new SeamError("INVALID", "Unknown mutation");
        }

        if (!requestBody.clientMutationId) {
          throw new SeamError("INVALID", "clientMutationId required");
        }

        const seam = await options.resolveContext(request, env);

        if (!seam.actorId || seam.actorType === "anonymous") {
          throw new SeamError("UNAUTHORIZED");
        }

        const input = mutation.input.parse(requestBody.input);
        const current = mutation.record
          ? await loadCurrent(options.db, requestBody, mutation.record)
          : undefined;
        const scope = current
          ? { kind: current.scopeKind, id: current.scopeId }
          : resolveCreateScope(mutation, input);
        const commit = await mutation.execute(input, {
          seam,
          scope,
          current: current ? toPublicRecord(current) : (undefined as unknown as SeamRecord),
        });

        if (commit.writes.length !== 1) {
          throw new SeamError(
            "INVALID",
            "Only single-record mutations are supported in this slice",
          );
        }

        const write = commit.writes[0];
        const recordType = recordTypes.get(write.type);

        if (!recordType) {
          throw new SeamError("INVALID", "Unknown record type");
        }

        const now = new Date().toISOString();
        const opId = crypto.randomUUID();
        const storedRecord = await commitWrite(
          options.db,
          write,
          recordType,
          seam.actorId,
          now,
          opId,
        );
        const seq = await options.db.appendSeqLog({
          opId,
          scopeKind: storedRecord.scopeKind,
          scopeId: storedRecord.scopeId,
          recordType: storedRecord.type,
          recordId: storedRecord.id,
          mutationType: requestBody.mutation,
          actorId: seam.actorId,
          timestamp: now,
          version: storedRecord.version,
        });

        const record = toPublicRecord(storedRecord);

        return json({
          ok: true,
          records: [record],
          record,
          seq,
          clientMutationId: requestBody.clientMutationId,
        });
      } catch (error) {
        if (error instanceof SeamError) {
          return json(
            {
              ok: false,
              error: { code: error.code, message: error.message, record: error.record },
              clientMutationId: body.clientMutationId,
            },
            400,
          );
        }

        return json({ ok: false, error: { code: "INVALID", message: "Invalid request" } }, 400);
      }
    },
  };
}

function resolveCreateScope<TInput>(
  mutation: CreateMutationDefinition<z.ZodType<TInput>>,
  input: TInput,
): SeamScope {
  if (!mutation.scope) {
    throw new SeamError("INVALID", "scope required");
  }

  return mutation.scope(input);
}

async function loadCurrent(
  db: SeamDatabase,
  body: MutateRequest,
  recordType: string,
): Promise<StoredRecord> {
  if (!body.id || body.expectedVersion === undefined) {
    throw new SeamError("INVALID", "id and expectedVersion required");
  }

  const current = await db.getRecord(body.id);

  if (!current || current.deletedAt) {
    throw new SeamError("NOT_FOUND");
  }

  if (current.type !== recordType) {
    throw new SeamError("TYPE_MISMATCH");
  }

  if (current.version !== body.expectedVersion) {
    throw new SeamError("VERSION_CONFLICT", "Version conflict", toPublicRecord(current));
  }

  return current;
}

async function commitWrite(
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

function toPublicRecord(record: StoredRecord): SeamRecord {
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
