import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSeamServer, defineRecordType } from "./index.js";
import { createTestD1, migrateSeamD1 } from "../testing/index.js";

describe("durable outbox", () => {
  it("writes mutation events to outbox in the same batch without extra seq_log rows", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
      authorize: async () => true,
      mutations: {
        "task.create": {
          input: z.object({ listId: z.string(), title: z.string() }),
          scope: (input: { listId: string; title: string }) => ({ kind: "list", id: input.listId }),
          execute: (input: { listId: string; title: string }) => ({
            writes: [
              {
                op: "create",
                type: "task",
                scope: { kind: "list", id: input.listId },
                data: { title: input.title, done: false },
              },
            ],
            events: [{ type: "task.created", payload: { title: input.title } }],
          }),
        },
      },
    });

    const response = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "inbox", title: "Outbox" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(db.seqLogEntries()).toHaveLength(1);
    expect(db.outboxEntries()).toEqual([
      expect.objectContaining({
        id: 1,
        opId: db.seqLogEntries()[0].opId,
        seq: body.seq,
        scopeKind: "list",
        scopeId: "inbox",
        recordType: "task",
        recordId: body.record.id,
        eventType: "task.created",
        payload: { title: "Outbox" },
        actorId: "user_1",
        createdAt: expect.any(String),
      }),
    ]);
  });

  it("consumes outbox rows by cursor and retries when processing fails", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
      authorize: async () => true,
      mutations: {
        "task.create": {
          input: z.object({ listId: z.string(), title: z.string() }),
          scope: (input: { listId: string; title: string }) => ({ kind: "list", id: input.listId }),
          execute: (input: { listId: string; title: string }) => ({
            writes: [
              {
                op: "create",
                type: "task",
                scope: { kind: "list", id: input.listId },
                data: { title: input.title, done: false },
              },
            ],
            events: [{ type: "task.created", payload: { title: input.title } }],
          }),
        },
      },
    });

    for (const title of ["One", "Two", "Three"]) {
      await seam.fetch(
        new Request("https://example.com/seam/mutate", {
          method: "POST",
          body: JSON.stringify({
            mutation: "task.create",
            input: { listId: "inbox", title },
            clientMutationId: `client_mutation_${title}`,
          }),
        }),
      );
    }

    const processed: number[] = [];
    const first = await seam.consumeOutbox({
      consumerName: "indexer",
      limit: 2,
      process: async (entry) => {
        processed.push(entry.id);
      },
    });

    expect(first).toEqual({ processed: 2, lastOutboxId: 2, hasMore: true });
    expect(processed).toEqual([1, 2]);

    await expect(
      seam.consumeOutbox({
        consumerName: "indexer",
        limit: 2,
        process: async (entry) => {
          processed.push(entry.id);
          throw new Error("transient failure");
        },
      }),
    ).rejects.toThrow("transient failure");
    expect(db.consumerCursor("indexer")).toBe(2);

    const retry = await seam.consumeOutbox({
      consumerName: "indexer",
      limit: 2,
      process: async (entry) => {
        processed.push(entry.id);
      },
    });

    expect(retry).toEqual({ processed: 1, lastOutboxId: 3, hasMore: false });
    expect(processed).toEqual([1, 2, 3, 3]);
  });
});
