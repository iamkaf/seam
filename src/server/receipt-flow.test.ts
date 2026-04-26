import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSeamServer, defineRecordType } from "./index.js";
import { createTestD1, migrateSeamD1 } from "../testing/index.js";

describe("mutation receipts", () => {
  it("replays the original response for a duplicate clientMutationId and envelope", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    let executions = 0;
    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
      mutations: {
        "task.create": {
          input: z.object({ listId: z.string(), title: z.string() }),
          scope: (input: { listId: string; title: string }) => ({ kind: "list", id: input.listId }),
          execute: (input: { listId: string; title: string }) => {
            executions += 1;
            return {
              writes: [
                {
                  op: "create",
                  type: "task",
                  scope: { kind: "list", id: input.listId },
                  data: { title: input.title, done: false },
                },
              ],
            };
          },
        },
      },
    });

    const requestBody = {
      mutation: "task.create",
      input: { listId: "inbox", title: "Retry safely" },
      clientMutationId: "client_mutation_1",
    };

    const firstResponse = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify(requestBody),
      }),
    );
    const first = await firstResponse.json();

    const secondResponse = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify(requestBody),
      }),
    );
    const second = await secondResponse.json();

    expect(secondResponse.status).toBe(200);
    expect(second).toEqual(first);
    expect(executions).toBe(1);
    expect(db.records).toHaveLength(1);
    expect(db.seqLogEntries()).toHaveLength(1);
    expect(db.receiptEntries()).toEqual([
      {
        actorId: "user_1",
        clientMutationId: "client_mutation_1",
        requestHash: expect.any(String),
        seq: 1,
        scopeKind: "list",
        scopeId: "inbox",
        responseJson: JSON.stringify(first),
        createdAt: expect.any(String),
      },
    ]);
  });

  it("rejects clientMutationId reuse with a different envelope", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    let executions = 0;
    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
      mutations: {
        "task.create": {
          input: z.object({ listId: z.string(), title: z.string() }),
          scope: (input: { listId: string; title: string }) => ({ kind: "list", id: input.listId }),
          execute: (input: { listId: string; title: string }) => {
            executions += 1;
            return {
              writes: [
                {
                  op: "create",
                  type: "task",
                  scope: { kind: "list", id: input.listId },
                  data: { title: input.title, done: false },
                },
              ],
            };
          },
        },
      },
    });

    await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "inbox", title: "Original" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );

    const reusedResponse = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "inbox", title: "Different" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    const reused = await reusedResponse.json();

    expect(reusedResponse.status).toBe(400);
    expect(reused).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_KEY_REUSED" },
      clientMutationId: "client_mutation_1",
    });
    expect(executions).toBe(1);
    expect(db.records).toHaveLength(1);
    expect(db.seqLogEntries()).toHaveLength(1);
    expect(db.receiptEntries()).toHaveLength(1);
  });

  it("rolls back records and seq_log when receipt insertion fails", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);
    db.failNextReceiptInsert();

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
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
          }),
        },
      },
    });

    const response = await seam.fetch(
      new Request("https://example.com/seam/mutate", {
        method: "POST",
        body: JSON.stringify({
          mutation: "task.create",
          input: { listId: "inbox", title: "Rollback me" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      ok: false,
      error: { code: "INVALID" },
      clientMutationId: "client_mutation_1",
    });
    expect(db.records).toHaveLength(0);
    expect(db.seqLogEntries()).toHaveLength(0);
    expect(db.receiptEntries()).toHaveLength(0);
  });
});
