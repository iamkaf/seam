import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSeamServer, defineRecordType } from "./index.js";
import { createTestD1, migrateSeamD1 } from "../testing/index.js";

describe("create mutation flow", () => {
  it("applies the Seam D1 core schema", async () => {
    const db = createTestD1();

    await migrateSeamD1(db);

    expect(db.tableNames()).toEqual([
      "mutation_receipts",
      "outbox",
      "records",
      "seam_batch_assertions",
      "seam_retention",
      "seq_log",
    ]);
  });

  it("creates a record through POST /seam/mutate", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

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
          input: { listId: "inbox", title: "Write tests first" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      seq: 1,
      clientMutationId: "client_mutation_1",
      record: {
        type: "task",
        version: 1,
        data: { title: "Write tests first", done: false },
        scopeKind: "list",
        scopeId: "inbox",
        createdBy: "user_1",
        updatedBy: "user_1",
      },
      records: [
        {
          type: "task",
          version: 1,
          data: { title: "Write tests first", done: false },
          scopeKind: "list",
          scopeId: "inbox",
        },
      ],
    });
    expect(body.record.id).toEqual(expect.any(String));
    expect(body.record.createdAt).toEqual(expect.any(String));
    expect(body.record.updatedAt).toEqual(expect.any(String));
  });

  it("writes exactly one seq_log row for a create mutation", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

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
          input: { listId: "inbox", title: "Write seq log" },
          clientMutationId: "client_mutation_2",
        }),
      }),
    );
    const body = await response.json();

    expect(db.seqLogEntries()).toEqual([
      {
        seq: 1,
        opId: expect.any(String),
        scopeKind: "list",
        scopeId: "inbox",
        recordType: "task",
        recordId: body.record.id,
        mutationType: "task.create",
        actorId: "user_1",
        timestamp: body.record.updatedAt,
        version: 1,
      },
    ]);
  });
});
