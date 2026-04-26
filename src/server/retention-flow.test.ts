import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestD1, migrateSeamD1 } from "../testing/index.js";
import { createSeamServer, defineRecordType } from "./index.js";

describe("retention and cursor expiry", () => {
  it("prunes seq_log, records the retention floor, and expires stale pull cursors", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);
    const seam = createTaskSeam(db);

    await createTask(seam, "client_mutation_1", "First");
    await createTask(seam, "client_mutation_2", "Second");

    const result = await seam.pruneSeqLog({ beforeSeq: 2 });

    expect(result).toEqual({ minRetainedSeq: 2, prunedSeqLogEntries: 1, prunedReceipts: 1 });
    expect(db.minRetainedSeq()).toBe(2);
    expect(db.seqLogEntries().map((entry) => entry.seq)).toEqual([2]);
    expect(db.receiptEntries().map((receipt) => receipt.clientMutationId)).toEqual([
      "client_mutation_2",
    ]);

    const staleResponse = await seam.fetch(
      new Request("https://example.com/seam/sync/pull", {
        method: "POST",
        body: JSON.stringify({ afterSeq: 0, scopes: [{ kind: "list", id: "inbox" }] }),
      }),
    );
    const stale = await staleResponse.json();

    expect(staleResponse.status).toBe(400);
    expect(stale).toEqual({
      ok: false,
      error: { code: "CURSOR_EXPIRED", message: "CURSOR_EXPIRED" },
    });

    const bootstrapResponse = await seam.fetch(
      new Request("https://example.com/seam/sync/bootstrap", {
        method: "POST",
        body: JSON.stringify({ scopes: [{ kind: "list", id: "inbox" }] }),
      }),
    );
    const bootstrap = await bootstrapResponse.json();

    expect(bootstrapResponse.status).toBe(200);
    expect(bootstrap.records).toHaveLength(2);
    expect(bootstrap.seq).toBe(2);
  });

  it("keeps soft-deleted records while retained seq_log entries reference them", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);
    const seam = createTaskSeam(db);

    const createResponse = await createTask(seam, "client_mutation_1", "Delete me");
    const created = await createResponse.json();
    await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.delete",
          id: created.record.id,
          expectedVersion: 1,
          input: {},
          clientMutationId: "client_mutation_2",
        }),
      }),
    );

    await seam.pruneSeqLog({ beforeSeq: 2 });

    expect(db.seqLogEntries().map((entry) => entry.recordId)).toEqual([created.record.id]);
    expect(
      db.records.map((record) => ({ id: record.id, deleted: Boolean(record.deletedAt) })),
    ).toEqual([{ id: created.record.id, deleted: true }]);
  });
});

function createTaskSeam(db: ReturnType<typeof createTestD1>) {
  const Task = defineRecordType("task", {
    schema: z.object({ title: z.string(), done: z.boolean() }),
  });

  return createSeamServer({
    db,
    records: [Task],
    resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
    mutations: {
      "task.create": {
        input: z.object({ title: z.string() }),
        scope: () => ({ kind: "list", id: "inbox" }),
        execute: (input: { title: string }) => ({
          writes: [
            {
              op: "create",
              type: "task",
              scope: { kind: "list", id: "inbox" },
              data: { title: input.title, done: false },
            },
          ],
        }),
      },
      "task.delete": {
        record: "task",
        input: z.object({}),
        execute: (_input: Record<string, never>, { current }) => ({
          writes: [
            {
              op: "delete",
              id: current.id,
              type: "task",
              expectedVersion: current.version,
            },
          ],
        }),
      },
    },
  });
}

async function createTask(
  seam: ReturnType<typeof createTaskSeam>,
  clientMutationId: string,
  title: string,
): Promise<Response> {
  return seam.fetch(
    new Request("https://example.com/seam/mutate", {
      method: "POST",
      body: JSON.stringify({ mutation: "task.create", input: { title }, clientMutationId }),
    }),
  );
}
