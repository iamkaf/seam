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

export interface MutationCommit {
  writes: CreateWrite[];
  primaryRecordId?: string;
}

type ScopeResolver<TInput> = {
  resolve(input: TInput): SeamScope;
}["resolve"];

type MutationExecutor<TInput> = {
  execute(
    input: TInput,
    ctx: { seam: SeamContext; scope: SeamScope },
  ): MutationCommit | Promise<MutationCommit>;
}["execute"];

export interface CreateMutationDefinition<TInput extends z.ZodType = z.ZodType> {
  input: TInput;
  scope: ScopeResolver<z.output<TInput>>;
  execute: MutationExecutor<z.output<TInput>>;
}

export interface SeamDatabase {
  createRecord(record: StoredRecord): Promise<void>;
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

      try {
        const body = (await request.json()) as MutateRequest;
        const mutation = options.mutations[body.mutation];

        if (!mutation) {
          throw new SeamError("INVALID", "Unknown mutation");
        }

        if (!body.clientMutationId) {
          throw new SeamError("INVALID", "clientMutationId required");
        }

        const seam = await options.resolveContext(request, env);

        if (!seam.actorId || seam.actorType === "anonymous") {
          throw new SeamError("UNAUTHORIZED");
        }

        const input = mutation.input.parse(body.input);
        const scope = mutation.scope(input);
        const commit = await mutation.execute(input, { seam, scope });

        if (commit.writes.length !== 1 || commit.writes[0]?.op !== "create") {
          throw new SeamError(
            "INVALID",
            "Only single create mutations are supported in this slice",
          );
        }

        const write = commit.writes[0];
        const recordType = recordTypes.get(write.type);

        if (!recordType) {
          throw new SeamError("INVALID", "Unknown record type");
        }

        const data = recordType.schema.parse(write.data) as Record<string, unknown>;
        const id = write.id ?? crypto.randomUUID();
        const now = new Date().toISOString();
        const opId = crypto.randomUUID();
        const storedRecord: StoredRecord = {
          id,
          type: write.type,
          scopeKind: write.scope.kind,
          scopeId: write.scope.id,
          version: 1,
          data,
          createdAt: now,
          createdBy: seam.actorId,
          updatedAt: now,
          updatedBy: seam.actorId,
          lastOpId: opId,
        };

        await options.db.createRecord(storedRecord);
        const seq = await options.db.appendSeqLog({
          opId,
          scopeKind: storedRecord.scopeKind,
          scopeId: storedRecord.scopeId,
          recordType: storedRecord.type,
          recordId: storedRecord.id,
          mutationType: body.mutation,
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
          clientMutationId: body.clientMutationId,
        });
      } catch (error) {
        if (error instanceof SeamError) {
          return json({ ok: false, error: { code: error.code, message: error.message } }, 400);
        }

        return json({ ok: false, error: { code: "INVALID", message: "Invalid request" } }, 400);
      }
    },
  };
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
