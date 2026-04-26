import { describe, expect, it } from "vitest";
import type { SeamRecord } from "../shared/types.js";
import { createSeamClient } from "./index.js";

describe("client store and projections", () => {
  it("bootstraps scopes into the in-memory store and derives projections", async () => {
    const task = record({
      id: "task_1",
      type: "task",
      data: { title: "Bootstrap", done: false },
      scopeKind: "list",
      scopeId: "inbox",
    });
    const client = createSeamClient({
      url: "https://example.com/seam",
      fetch: async () => Response.json({ records: [task], seq: 7 }),
    });

    await client.bootstrap({ scopes: [{ kind: "list", id: "inbox" }] });

    expect(client.cursor()).toBe(7);
    expect(client.records()).toEqual([task]);
    expect(
      client.project({
        scope: { kind: "list", id: "inbox" },
        select: (records) => records.map((candidate) => candidate.data.title),
      }),
    ).toEqual(["Bootstrap"]);
  });

  it("pulls until hasMore is false and advances only to response seq", async () => {
    const first = record({
      id: "task_1",
      type: "task",
      data: { title: "First" },
      scopeKind: "list",
      scopeId: "inbox",
    });
    const second = record({
      id: "task_2",
      type: "task",
      data: { title: "Second" },
      scopeKind: "list",
      scopeId: "inbox",
    });
    const requests: unknown[] = [];
    const responses = [
      { records: [], seq: 0 },
      { records: [first], seq: 1, hasMore: true },
      { records: [second], seq: 2, hasMore: false },
    ];
    const client = createSeamClient({
      url: "https://example.com/seam",
      fetch: async (_input, init) => {
        requests.push(JSON.parse(init?.body as string));

        return Response.json(responses.shift());
      },
    });

    await client.bootstrap({ scopes: [{ kind: "list", id: "inbox" }] });
    await client.sync();

    expect(requests).toEqual([
      { scopes: [{ kind: "list", id: "inbox" }] },
      { afterSeq: 0, scopes: [{ kind: "list", id: "inbox" }] },
      { afterSeq: 1, scopes: [{ kind: "list", id: "inbox" }] },
    ]);
    expect(client.cursor()).toBe(2);
    expect(client.records().map((candidate) => candidate.id)).toEqual(["task_1", "task_2"]);
  });

  it("adds scopes by pulling existing scopes through the bootstrap watermark", async () => {
    const inbox = record({
      id: "task_1",
      type: "task",
      data: { title: "Inbox" },
      scopeKind: "list",
      scopeId: "inbox",
    });
    const inboxUpdate = record({
      id: "task_2",
      type: "task",
      data: { title: "Missed while joining" },
      scopeKind: "list",
      scopeId: "inbox",
    });
    const archive = record({
      id: "task_3",
      type: "task",
      data: { title: "Archive" },
      scopeKind: "list",
      scopeId: "archive",
    });
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = createSeamClient({
      url: "https://example.com/seam",
      fetch: async (input, init) => {
        const url = input.toString();
        const body = JSON.parse(init?.body as string) as unknown;
        requests.push({ url, body });

        if (url.endsWith("/sync/bootstrap")) {
          return Response.json(
            requests.length === 1 ? { records: [inbox], seq: 1 } : { records: [archive], seq: 3 },
          );
        }

        return Response.json({ records: [inboxUpdate], seq: 3, hasMore: false });
      },
    });

    await client.bootstrap({ scopes: [{ kind: "list", id: "inbox" }] });
    await client.bootstrap({ scopes: [{ kind: "list", id: "archive" }] });

    expect(requests).toEqual([
      {
        url: "https://example.com/seam/sync/bootstrap",
        body: { scopes: [{ kind: "list", id: "inbox" }] },
      },
      {
        url: "https://example.com/seam/sync/bootstrap",
        body: { scopes: [{ kind: "list", id: "archive" }] },
      },
      {
        url: "https://example.com/seam/sync/pull",
        body: {
          afterSeq: 1,
          scopes: [{ kind: "list", id: "inbox" }],
          untilSeq: 3,
        },
      },
    ]);
    expect(client.cursor()).toBe(3);
    expect(client.records().map((candidate) => candidate.id)).toEqual([
      "task_1",
      "task_3",
      "task_2",
    ]);
  });

  it("removes tombstoned records from the store and projections", async () => {
    const task = record({
      id: "task_1",
      type: "task",
      data: { title: "Delete me" },
      scopeKind: "list",
      scopeId: "inbox",
    });
    const tombstone = record({
      ...task,
      deletedAt: "2026-01-01T00:01:00.000Z",
      version: 2,
    });
    const responses = [
      { records: [task], seq: 1 },
      { records: [tombstone], seq: 2, hasMore: false },
    ];
    const client = createSeamClient({
      url: "https://example.com/seam",
      fetch: async () => Response.json(responses.shift()),
    });

    await client.bootstrap({ scopes: [{ kind: "list", id: "inbox" }] });

    expect(client.records()).toEqual([task]);

    await client.sync();

    expect(client.records()).toEqual([]);
    expect(
      client.project({
        scope: { kind: "list", id: "inbox" },
        select: (records) => records.map((candidate) => candidate.id),
      }),
    ).toEqual([]);
  });
});

function record(overrides: Partial<SeamRecord>): SeamRecord {
  return {
    id: "record_1",
    type: "record",
    version: 1,
    data: {},
    scopeKind: "scope",
    scopeId: "scope_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "user_1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "user_1",
    ...overrides,
  };
}
