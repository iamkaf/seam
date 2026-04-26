import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSeamServer, defineRecordType } from "./index.js";
import { createTestD1, migrateSeamD1 } from "../testing/index.js";

describe("bulk imports", () => {
  it("commits imported records in chunks and logs every changed record", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
      mutations: {},
    });

    const result = await seam.importRecords({
      actorId: "token:importer",
      scope: { kind: "list", id: "inbox" },
      mutationType: "task.import",
      chunkSize: 2,
      records: [
        { op: "create", type: "task", data: { title: "One", done: false } },
        { op: "create", type: "task", data: { title: "Two", done: false } },
        { op: "create", type: "task", data: { title: "Three", done: false } },
      ],
    });

    expect(result).toMatchObject({
      importId: expect.any(String),
      ok: true,
      seq: 3,
      created: 3,
      updated: 0,
      deleted: 0,
      chunks: [
        { ok: true, seq: 2, created: 2, updated: 0, deleted: 0 },
        { ok: true, seq: 3, created: 1, updated: 0, deleted: 0 },
      ],
    });
    expect(db.records.map((record) => record.data.title)).toEqual(["One", "Two", "Three"]);
    expect(db.seqLogEntries()).toHaveLength(3);
    expect(db.seqLogEntries().map((entry) => entry.mutationType)).toEqual([
      "task.import",
      "task.import",
      "task.import",
    ]);
  });

  it("reports partial imports when a later chunk fails", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
      mutations: {},
    });

    const result = await seam.importRecords({
      actorId: "token:importer",
      scope: { kind: "list", id: "inbox" },
      mutationType: "task.import",
      chunkSize: 1,
      records: [
        { op: "create", type: "task", data: { title: "Committed", done: false } },
        { op: "create", type: "task", data: { title: "Invalid", done: "no" } },
        { op: "create", type: "task", data: { title: "Skipped", done: false } },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      seq: 1,
      created: 1,
      updated: 0,
      deleted: 0,
      chunks: [
        { ok: true, seq: 1, created: 1, updated: 0, deleted: 0 },
        { ok: false, seq: 1, created: 0, updated: 0, deleted: 0, error: expect.any(String) },
      ],
    });
    expect(db.records.map((record) => record.data.title)).toEqual(["Committed"]);
    expect(db.seqLogEntries()).toHaveLength(1);
  });

  it("imports updates and deletes from current primary versions", async () => {
    const db = createTestD1();
    await migrateSeamD1(db);

    const Task = defineRecordType("task", {
      schema: z.object({ title: z.string(), done: z.boolean() }),
    });

    const seam = createSeamServer({
      db,
      records: [Task],
      resolveContext: async () => ({ actorId: "user_1", actorType: "user" }),
      mutations: {},
    });

    await seam.importRecords({
      actorId: "token:importer",
      scope: { kind: "list", id: "inbox" },
      mutationType: "task.import",
      chunkSize: 10,
      records: [
        { op: "create", id: "task_1", type: "task", data: { title: "One", done: false } },
        { op: "create", id: "task_2", type: "task", data: { title: "Two", done: false } },
      ],
    });

    const result = await seam.importRecords({
      actorId: "token:importer",
      scope: { kind: "list", id: "inbox" },
      mutationType: "task.import",
      chunkSize: 10,
      records: [
        { op: "update", id: "task_1", type: "task", data: { title: "One updated", done: true } },
        { op: "delete", id: "task_2", type: "task" },
      ],
    });

    expect(result).toMatchObject({ ok: true, seq: 4, created: 0, updated: 1, deleted: 1 });
    expect(db.records.find((record) => record.id === "task_1")).toMatchObject({
      version: 2,
      data: { title: "One updated", done: true },
    });
    expect(db.records.find((record) => record.id === "task_2")).toMatchObject({
      version: 2,
      deletedAt: expect.any(String),
    });
    expect(db.seqLogEntries()).toHaveLength(4);
  });
});
