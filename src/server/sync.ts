import { authorize } from "./auth.js";
import { json } from "./http.js";
import { toPublicRecord } from "./records.js";
import type {
  BootstrapRequest,
  CreateMutationDefinition,
  CreateSeamServerOptions,
  PullRequest,
  SeqLogEntry,
} from "./types.js";

export async function handleBootstrap<TMutations extends Record<string, CreateMutationDefinition>>(
  options: CreateSeamServerOptions<TMutations>,
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

export async function handlePull<TMutations extends Record<string, CreateMutationDefinition>>(
  options: CreateSeamServerOptions<TMutations>,
  request: Request,
  env: unknown,
): Promise<Response> {
  try {
    const body = (await request.json()) as PullRequest;
    const ctx = await options.resolveContext(request, env);
    const scopes = body.scopes ?? [];
    const minRetainedSeq = await options.db.getMinRetainedSeq();

    if (body.afterSeq < minRetainedSeq) {
      return json({ ok: false, error: { code: "CURSOR_EXPIRED", message: "CURSOR_EXPIRED" } }, 400);
    }

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
