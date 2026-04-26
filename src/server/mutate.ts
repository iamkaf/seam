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

    if (commit.writes.length !== 1) {
      throw new SeamError("INVALID", "Only single-record mutations are supported in this slice");
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
}
