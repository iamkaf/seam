import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import type { SeamRecord } from "../shared/types.js";
import { SeamProvider, useSeamMutation, useSeamProjection, useSeamStatus } from "./index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("React bindings", () => {
  it("initializes the client and subscribes projections to store changes", async () => {
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
    const responses = [
      { records: [first], seq: 1 },
      { records: [second], seq: 2, hasMore: false },
    ];
    const titles: string[][] = [];

    function Tasks() {
      const projected = useSeamProjection({
        scope: { kind: "list", id: "inbox" },
        select: (records) => records.map((candidate) => candidate.data.title as string),
      });
      titles.push(projected);

      return null;
    }

    await act(async () => {
      create(
        React.createElement(
          SeamProvider,
          {
            url: "https://example.com/seam",
            scopes: [{ kind: "list", id: "inbox" }],
            fetch: async () => Response.json(responses.shift()),
          },
          React.createElement(Tasks),
        ),
      );
    });

    expect(titles).toContainEqual(["First", "Second"]);
  });

  it("sends mutations with generated clientMutationId and expectedVersion metadata", async () => {
    const task = record({
      id: "task_1",
      type: "task",
      version: 1,
      data: { title: "Base" },
      scopeKind: "list",
      scopeId: "inbox",
    });
    const updated = record({ ...task, version: 2, data: { title: "Updated" } });
    const requests: unknown[] = [];
    let rename: ReturnType<typeof useSeamMutation> | undefined;
    const statuses: Array<ReturnType<typeof useSeamStatus>> = [];

    function Mutator() {
      rename = useSeamMutation("task.rename");
      statuses.push(useSeamStatus());

      return null;
    }

    await act(async () => {
      create(
        React.createElement(
          SeamProvider,
          {
            url: "https://example.com/seam",
            scopes: [{ kind: "list", id: "inbox" }],
            fetch: async (input, init) => {
              requests.push({ url: input.toString(), body: JSON.parse(init?.body as string) });

              if (input.toString().endsWith("/sync/bootstrap")) {
                return Response.json({ records: [task], seq: 1 });
              }

              if (input.toString().endsWith("/sync/pull")) {
                return Response.json({ records: [], seq: 1, hasMore: false });
              }

              return Response.json({
                ok: true,
                record: updated,
                records: [updated],
                seq: 2,
                clientMutationId: JSON.parse(init?.body as string).clientMutationId,
              });
            },
          },
          React.createElement(Mutator),
        ),
      );
    });

    await act(async () => {
      await rename?.mutate({ title: "Updated" }, { id: "task_1", expectedVersion: 1 });
    });

    const mutationRequest = requests.at(-1) as { url: string; body: Record<string, unknown> };
    expect(mutationRequest.url).toBe("https://example.com/seam/mutate");
    expect(mutationRequest.body).toMatchObject({
      mutation: "task.rename",
      input: { title: "Updated" },
      id: "task_1",
      expectedVersion: 1,
    });
    expect(typeof mutationRequest.body.clientMutationId).toBe("string");
    expect(rename?.data?.record).toEqual(updated);
    expect(statuses.at(-1)?.isPending).toBe(false);
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
