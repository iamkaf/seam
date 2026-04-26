import { describe, expect, it } from "vitest";
import type { SeamRecord } from "../shared/types.js";
import { createSeamClient } from "./index.js";

describe("client mutations", () => {
  it("applies optimistic creates and reconciles temporary IDs with server records", async () => {
    const requests: unknown[] = [];
    const serverRecord = record({
      id: "task_server",
      type: "task",
      data: { title: "Created" },
      scopeKind: "list",
      scopeId: "inbox",
    });
    const client = createSeamClient({
      url: "https://example.com/seam",
      fetch: async (_input, init) => {
        requests.push(JSON.parse(init?.body as string));

        return Response.json({
          ok: true,
          record: serverRecord,
          records: [serverRecord],
          seq: 1,
          clientMutationId: "mutation_1",
        });
      },
    });
    const snapshots: string[][] = [];
    client.subscribe(() => snapshots.push(client.records().map((candidate) => candidate.id)));

    await client.mutate(
      "task.create",
      { title: "Created" },
      {
        clientMutationId: "mutation_1",
        optimistic: {
          records: [
            record({
              id: "tmp_1",
              type: "task",
              data: { title: "Created" },
              scopeKind: "list",
              scopeId: "inbox",
            }),
          ],
        },
      },
    );

    expect(requests).toEqual([
      {
        mutation: "task.create",
        input: { title: "Created" },
        clientMutationId: "mutation_1",
      },
    ]);
    expect(snapshots).toContainEqual(["tmp_1"]);
    expect(snapshots).toContainEqual(["task_server"]);
    expect(client.records()).toEqual([serverRecord]);
  });

  it("rolls back optimistic state and merges the server record on version conflict", async () => {
    const base = record({
      id: "task_1",
      type: "task",
      version: 1,
      data: { title: "Base" },
      scopeKind: "list",
      scopeId: "inbox",
    });
    const serverRecord = record({
      ...base,
      version: 2,
      data: { title: "Server" },
    });
    const requests: unknown[] = [];
    const client = createSeamClient({
      url: "https://example.com/seam",
      fetch: async (input, init) => {
        requests.push({ url: input.toString(), body: JSON.parse(init?.body as string) });

        if (input.toString().endsWith("/sync/bootstrap")) {
          return Response.json({ records: [base], seq: 1 });
        }

        return Response.json({
          ok: false,
          error: { code: "VERSION_CONFLICT", message: "VERSION_CONFLICT", record: serverRecord },
          clientMutationId: "mutation_2",
        });
      },
    });

    await client.bootstrap({ scopes: [{ kind: "list", id: "inbox" }] });

    const response = await client.mutate(
      "task.rename",
      { title: "Optimistic" },
      {
        id: "task_1",
        expectedVersion: 1,
        clientMutationId: "mutation_2",
        optimistic: {
          records: [record({ ...base, version: 2, data: { title: "Optimistic" } })],
        },
      },
    );

    expect(requests.at(-1)).toEqual({
      url: "https://example.com/seam/mutate",
      body: {
        mutation: "task.rename",
        input: { title: "Optimistic" },
        id: "task_1",
        expectedVersion: 1,
        clientMutationId: "mutation_2",
      },
    });
    expect(response.error?.record).toEqual(serverRecord);
    expect(client.records()).toEqual([serverRecord]);
  });

  it("aborts later optimistic state that depends on a conflicted record", async () => {
    const base = record({
      id: "task_1",
      type: "task",
      version: 1,
      data: { title: "Base" },
      scopeKind: "list",
      scopeId: "inbox",
    });
    const conflictRecord = record({ ...base, version: 2, data: { title: "Server" } });
    const staleSuccess = record({ ...base, version: 3, data: { title: "Stale success" } });
    const responses: Array<(response: Response) => void> = [];
    const client = createSeamClient({
      url: "https://example.com/seam",
      fetch: async () => new Promise<Response>((resolve) => responses.push(resolve)),
    });

    const first = client.mutate(
      "task.rename",
      { title: "First" },
      {
        id: "task_1",
        expectedVersion: 1,
        clientMutationId: "mutation_1",
        optimistic: { records: [record({ ...base, version: 2, data: { title: "First" } })] },
      },
    );
    const second = client.mutate(
      "task.rename",
      { title: "Second" },
      {
        id: "task_1",
        expectedVersion: 2,
        clientMutationId: "mutation_2",
        optimistic: { records: [record({ ...base, version: 3, data: { title: "Second" } })] },
      },
    );

    responses[0](
      Response.json({
        ok: false,
        error: { code: "VERSION_CONFLICT", message: "VERSION_CONFLICT", record: conflictRecord },
        clientMutationId: "mutation_1",
      }),
    );
    await first;

    expect(client.records()).toEqual([conflictRecord]);

    responses[1](
      Response.json({
        ok: true,
        record: staleSuccess,
        records: [staleSuccess],
        seq: 3,
        clientMutationId: "mutation_2",
      }),
    );
    await second;

    expect(client.records()).toEqual([conflictRecord]);
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
