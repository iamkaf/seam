import type { z } from "zod";
import { SeamError } from "../shared/types.js";
import { json } from "./http.js";
import { importRecords } from "./import.js";
import { handleMutate } from "./mutate.js";
import { consumeOutbox } from "./outbox.js";
import { handleBootstrap, handlePull } from "./sync.js";
import type { CreateMutationDefinition, CreateSeamServerOptions, RecordType } from "./types.js";

export { SeamError } from "../shared/types.js";
export type {
  CreateMutationDefinition,
  CreateSeamServerOptions,
  CreateWrite,
  CommitEffect,
  DeleteWrite,
  MutationCommit,
  MutationEvent,
  OutboxEntry,
  RecordType,
  SeamAuthorizeAction,
  SeamAuthorizeInput,
  SeamContext,
  SeamDatabase,
  SeamWrite,
  UpdateWrite,
} from "./types.js";
export type {
  ImportChunkResult,
  ImportRecord,
  ImportRecordsOptions,
  ImportRecordsResult,
} from "./import.js";
export type { ConsumeOutboxOptions, ConsumeOutboxResult } from "./outbox.js";

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
    importRecords: (importOptions: Parameters<typeof importRecords>[2]) =>
      importRecords(options.db, recordTypes, importOptions),
    consumeOutbox: (consumeOptions: Parameters<typeof consumeOutbox>[1]) =>
      consumeOutbox(options.db, consumeOptions),
    fetch: async (request: Request, env?: unknown): Promise<Response> => {
      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/seam/sync/bootstrap") {
        return handleBootstrap(options, request, env);
      }

      if (request.method === "POST" && url.pathname === "/seam/sync/pull") {
        return handlePull(options, request, env);
      }

      if (request.method === "POST" && url.pathname === "/seam/mutate") {
        return handleMutate(options, recordTypes, request, env);
      }

      return json({ ok: false, error: { code: "NOT_FOUND", message: "Not found" } }, 404);
    },
  };
}
