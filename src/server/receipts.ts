import type { MutateRequest } from "./types.js";

export async function hashMutationRequest(body: MutateRequest): Promise<string> {
  const canonical = JSON.stringify({
    mutation: body.mutation,
    input: sortJson(body.input),
    id: body.id,
    expectedVersion: body.expectedVersion,
  });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }

  return value;
}
