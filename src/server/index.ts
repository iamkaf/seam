import type { z } from "zod";
import { SeamError, type SeamRecord, type SeamScope } from "../shared/types.js";

export { SeamError } from "../shared/types.js";

export interface SeamContext {
  actorId: string | null;
  actorType: "anonymous" | "user" | "token" | "service";
}

export type SeamAuthorizeAction = "bootstrap" | "pull" | "create" | "mutate";

export interface SeamAuthorizeInput {
  ctx: SeamContext;
  scope: SeamScope;
  action: SeamAuthorizeAction;
  record?: SeamRecord;
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
  appendSeqLog(entry: SeqLogInsert): Promise<number>;
  createMutationReceipt(receipt: MutationReceipt): Promise<void>;
}

export interface CreateSeamServerOptions<
  TMutations extends Record<string, CreateMutationDefinition>,
> {
  db: SeamDatabase;
  records: RecordType[];
  resolveContext: (request: Request, env?: unknown) => SeamContext | Promise<SeamContext>;
  authorize?: (input: SeamAuthorizeInput) => boolean | Promise<boolean>;
  mutations: TMutations;
}

interface MutateRequest {
  mutation: string;
  input: Record<string, unknown>;
  id?: string;
  expectedVersion?: number;
  clientMutationId: string;
}

interface BootstrapRequest {
  scopes: SeamScope[];
}

interface PullRequest {
  afterSeq: number;
  scopes: SeamScope[];
  limit?: number;
  untilSeq?: number;
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

interface SeqScanRequest {
  scopes: SeamScope[];
  afterSeq: number;
  untilSeq?: number;
  limit: number;
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

      if (request.method === "POST" && url.pathname === "/seam/sync/bootstrap") {
        return handleBootstrap(options, request, env);
      }

      if (request.method === "POST" && url.pathname === "/seam/sync/pull") {
        return handlePull(options, request, env);
      }

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
        const actorId = seam.actorId;

        const requestHash = await hashMutationRequest(requestBody);
        const receipt = await options.db.getMutationReceipt(actorId, requestBody.clientMutationId);

        if (receipt) {
          if (receipt.requestHash !== requestHash) {
            throw new SeamError("IDEMPOTENCY_KEY_REUSED");
          }

          return json(JSON.parse(receipt.responseJson));
        }

        const input = mutation.input.parse(requestBody.input);
        const current = mutation.record ? await loadCurrent(options.db, requestBody) : undefined;
        const scope = current
          ? { kind: current.scopeKind, id: current.scopeId }
          : resolveCreateScope(mutation, input);

        if (current) {
          const allowed = await authorize(options, {
            ctx: seam,
            scope,
            action: "mutate",
            record: toPublicRecord(current),
          });

          if (!allowed) {
            throw new SeamError("NOT_FOUND");
          }

          if (current.type !== mutation.record) {
            throw new SeamError("TYPE_MISMATCH");
          }

          if (current.version !== requestBody.expectedVersion) {
            throw new SeamError("VERSION_CONFLICT", "Version conflict", toPublicRecord(current));
          }
        } else if (!(await authorize(options, { ctx: seam, scope, action: "create" }))) {
          throw new SeamError("FORBIDDEN");
        }

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

        const responseBody = await options.db.runMutationBatch(async () => {
          const now = new Date().toISOString();
          const opId = crypto.randomUUID();
          const storedRecord = await commitWrite(options.db, write, recordType, actorId, now, opId);
          const seq = await options.db.appendSeqLog({
            opId,
            scopeKind: storedRecord.scopeKind,
            scopeId: storedRecord.scopeId,
            recordType: storedRecord.type,
            recordId: storedRecord.id,
            mutationType: requestBody.mutation,
            actorId,
            timestamp: now,
            version: storedRecord.version,
          });

          const record = toPublicRecord(storedRecord);
          const successfulResponse = {
            ok: true,
            records: [record],
            record,
            seq,
            clientMutationId: requestBody.clientMutationId,
          };

          await options.db.createMutationReceipt({
            actorId,
            clientMutationId: requestBody.clientMutationId,
            requestHash,
            seq,
            scopeKind: storedRecord.scopeKind,
            scopeId: storedRecord.scopeId,
            responseJson: JSON.stringify(successfulResponse),
            createdAt: now,
          });

          return successfulResponse;
        });

        return json(responseBody);
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

        return json(
          {
            ok: false,
            error: { code: "INVALID", message: "Invalid request" },
            clientMutationId: body.clientMutationId,
          },
          400,
        );
      }
    },
  };
}

async function handleBootstrap(
  options: CreateSeamServerOptions<Record<string, CreateMutationDefinition>>,
  request: Request,
  env: unknown,
): Promise<Response> {
  try {
    const body = (await request.json()) as BootstrapRequest;
    const ctx = await options.resolveContext(request, env);
    const scopes = body.scopes ?? [];
    const authorizedScopes = [];
    const revokedScopes = [];

    for (const scope of scopes) {
      if (await authorize(options, { ctx, scope, action: "bootstrap" })) {
        authorizedScopes.push(scope);
      } else {
        revokedScopes.push(scope);
      }
    }

    const records = await options.db.listRecordsForScopes(authorizedScopes);
    const seq = await options.db.getMaxSeq();

    return json({
      records: records.map(toPublicRecord),
      seq,
      revokedScopes: revokedScopes.length > 0 ? revokedScopes : undefined,
    });
  } catch {
    return json({ ok: false, error: { code: "INVALID", message: "Invalid request" } }, 400);
  }
}

async function authorize(
  options: CreateSeamServerOptions<Record<string, CreateMutationDefinition>>,
  input: SeamAuthorizeInput,
): Promise<boolean> {
  return options.authorize ? options.authorize(input) : true;
}

async function handlePull(
  options: CreateSeamServerOptions<Record<string, CreateMutationDefinition>>,
  request: Request,
  env: unknown,
): Promise<Response> {
  try {
    const body = (await request.json()) as PullRequest;
    const ctx = await options.resolveContext(request, env);
    const scopes = body.scopes ?? [];
    const authorizedScopes = [];
    const revokedScopes = [];

    for (const scope of scopes) {
      if (await authorize(options, { ctx, scope, action: "pull" })) {
        authorizedScopes.push(scope);
      } else {
        revokedScopes.push(scope);
      }
    }

    const limit = Math.min(body.limit ?? 500, 1000);
    const entries = await options.db.listSeqForScopes({
      scopes: authorizedScopes,
      afterSeq: body.afterSeq,
      untilSeq: body.untilSeq,
      limit,
    });
    const highestByRecord = new Map<string, SeqLogEntry>();

    for (const entry of entries) {
      const previous = highestByRecord.get(entry.recordId);

      if (!previous || previous.version < entry.version) {
        highestByRecord.set(entry.recordId, entry);
      }
    }

    const records = await options.db.getRecords([...highestByRecord.keys()]);
    const materialized = records.filter((record) => {
      const scanned = highestByRecord.get(record.id);

      return scanned && record.version >= scanned.version;
    });
    const blocked =
      records.length !== highestByRecord.size || materialized.length !== records.length;

    if (blocked) {
      return json({ records: [], seq: body.afterSeq, hasMore: true });
    }

    const hasMore = entries.length === limit;
    const responseSeq =
      entries.at(-1)?.seq ?? (body.untilSeq !== undefined ? body.untilSeq : body.afterSeq);

    return json({
      records: materialized.map(toPublicRecord),
      seq: responseSeq,
      hasMore,
      revokedScopes: revokedScopes.length > 0 ? revokedScopes : undefined,
    });
  } catch {
    return json({ ok: false, error: { code: "INVALID", message: "Invalid request" } }, 400);
  }
}

async function hashMutationRequest(body: MutateRequest): Promise<string> {
  const canonical = JSON.stringify({
    mutation: body.mutation,
    input: sortJson(body.input),
    id: body.id,
    expectedVersion: body.expectedVersion,
  });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }

  return value;
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

async function loadCurrent(db: SeamDatabase, body: MutateRequest): Promise<StoredRecord> {
  if (!body.id || body.expectedVersion === undefined) {
    throw new SeamError("INVALID", "id and expectedVersion required");
  }

  const current = await db.getRecord(body.id);

  if (!current || current.deletedAt) {
    throw new SeamError("NOT_FOUND");
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
