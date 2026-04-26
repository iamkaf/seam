import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSeamServer, defineRecordType } from "./index.js";
import { createTestD1, migrateSeamD1 } from "../testing/index.js";

describe("bounded write sets", () => {
  it("commits two created records with one op_id, two seq_log rows, and one receipt", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });
    const Summary = defineRecordType("summary", {
      schema: z.object({ taskCount: z.number() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task, Summary],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
      authorize: async () => true,
      mutations: {
        "task.createWithSummary": {
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
              {
                op: "create",
                type: "summary",
                scope: { kind: "list", id: input.listId },
                data: { taskCount: 1 },
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
          mutation: "task.createWithSummary",
          input: { listId: "inbox", title: "Two writes" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      seq: 2,
      clientMutationId: "client_mutation_1",
      record: { type: "task", data: { title: "Two writes", done: false } },
      records: [
        { type: "task", data: { title: "Two writes", done: false } },
        { type: "summary", data: { taskCount: 1 } },
      ],
    });

    const seqLog = db.seqLogEntries();
    expect(seqLog).toHaveLength(2);
    expect(seqLog[0].opId).toBe(seqLog[1].opId);
    expect(seqLog.map((entry) => entry.recordType)).toEqual(["task", "summary"]);
    expect(db.receiptEntries()).toEqual([
      expect.objectContaining({
        clientMutationId: "client_mutation_1",
        seq: 2,
        responseJson: JSON.stringify(body),
      }),
    ]);
  });

  it("rolls back all records and seq_log when one write fails", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });
    const Summary = defineRecordType("summary", {
      schema: z.object({ taskCount: z.number() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task, Summary],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
      authorize: async () => true,
      mutations: {
        "task.createWithInvalidSummary": {
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
              {
                op: "create",
                type: "summary",
                scope: { kind: "list", id: input.listId },
                data: { taskCount: "not a number" },
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
          mutation: "task.createWithInvalidSummary",
          input: { listId: "inbox", title: "Rollback" },
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

  it("rejects write sets that cross scopes", async () => {
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
        "task.crossScope": {
          input: z.object({ listId: z.string(), otherListId: z.string() }),
          scope: (input: { listId: string; otherListId: string }) => ({
            kind: "list",
            id: input.listId,
          }),
          execute: (input: { listId: string; otherListId: string }) => ({
            writes: [
              {
                op: "create",
                type: "task",
                scope: { kind: "list", id: input.listId },
                data: { title: "first", done: false },
              },
              {
                op: "create",
                type: "task",
                scope: { kind: "list", id: input.otherListId },
                data: { title: "second", done: false },
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
          mutation: "task.crossScope",
          input: { listId: "inbox", otherListId: "other" },
          clientMutationId: "client_mutation_1",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(db.records).toHaveLength(0);
    expect(db.seqLogEntries()).toHaveLength(0);
  });
});
