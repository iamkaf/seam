import { SeamError, type SeamRecord } from "../shared/types.js";
import { authorize } from "./auth.js";
import { json } from "./http.js";
import { commitWrite, loadCurrent, resolveCreateScope, toPublicRecord } from "./records.js";
import { hashMutationRequest } from "./receipts.js";
import type {
  CreateMutationDefinition,
  CreateSeamServerOptions,
  MutateRequest,
  RecordType,
} from "./types.js";

export async function handleMutate<TMutations extends Record<string, CreateMutationDefinition>>(
  options: CreateSeamServerOptions<TMutations>,
  recordTypes: Map<string, RecordType>,
  request: Request,
  env: unknown,
): Promise<Response> {
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

    if (commit.writes.length < 1 || commit.writes.length > 25) {
      throw new SeamError("INVALID", "Write set size must be between 1 and 25");
    }

    for (const write of commit.writes) {
      if (!recordTypes.has(write.type)) {
        throw new SeamError("INVALID", "Unknown record type");
      }

      if (
        write.op === "create" &&
        (write.scope.kind !== scope.kind || write.scope.id !== scope.id)
      ) {
        throw new SeamError("INVALID", "All writes must use the mutation scope");
      }
    }

    const responseBody = await options.db.runMutationBatch(async () => {
      const now = new Date().toISOString();
      const opId = crypto.randomUUID();
      const storedRecords = [];
      let seq = 0;

      for (const write of commit.writes) {
        const recordType = recordTypes.get(write.type);

        if (!recordType) {
          throw new SeamError("INVALID", "Unknown record type");
        }

        const storedRecord = await commitWrite(options.db, write, recordType, actorId, now, opId);
        storedRecords.push(storedRecord);
        seq = await options.db.appendSeqLog({
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
      }

      for (const effect of commit.effects ?? []) {
        if (isSeamCoreTable(effect.tableName)) {
          throw new SeamError("INVALID", "Commit effects cannot write Seam core tables");
        }

        await effect.execute();
      }

      const records = storedRecords.map(toPublicRecord);
      const recordById = new Map(storedRecords.map((record) => [record.id, record]));
      const successfulResponse = {
        ok: true,
        records,
        record: records[0],
        seq,
        clientMutationId: requestBody.clientMutationId,
      };

      await options.db.createMutationReceipt({
        actorId,
        clientMutationId: requestBody.clientMutationId,
        requestHash,
        seq,
        scopeKind: scope.kind,
        scopeId: scope.id,
        responseJson: JSON.stringify(successfulResponse),
        createdAt: now,
      });

      for (const event of commit.events ?? []) {
        const eventRecord = event.recordId ? recordById.get(event.recordId) : storedRecords[0];

        await options.db.appendOutbox({
          opId,
          seq,
          scopeKind: scope.kind,
          scopeId: scope.id,
          recordType: eventRecord?.type,
          recordId: event.recordId ?? eventRecord?.id,
          eventType: event.type,
          payload: event.payload,
          actorId,
          createdAt: now,
        });
      }

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
}

function isSeamCoreTable(tableName: string): boolean {
  return ["records", "seq_log", "seam_batch_assertions", "mutation_receipts", "outbox"].includes(
    tableName,
  );
}
