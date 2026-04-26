import type { SeamRecord, SeamScope } from "../shared/types.js";

interface CreateSeamClientOptions {
  url: string;
  fetch?: typeof fetch;
}

interface BootstrapRequest {
  scopes: SeamScope[];
}

interface BootstrapResponse {
  records: SeamRecord[];
  seq: number;
  revokedScopes?: SeamScope[];
}

interface PullRequest {
  afterSeq: number;
  scopes: SeamScope[];
  untilSeq?: number;
}

interface PullResponse {
  records: SeamRecord[];
  seq: number;
  hasMore: boolean;
  revokedScopes?: SeamScope[];
}

interface ProjectionOptions<T> {
  scope: SeamScope;
  select(records: SeamRecord[]): T;
}

export function createSeamClient(options: CreateSeamClientOptions) {
  const request = options.fetch ?? fetch;
  const store = new Map<string, SeamRecord>();
  let cursor = 0;
  let activeScopes: SeamScope[] = [];

  return {
    async bootstrap(body: BootstrapRequest): Promise<BootstrapResponse> {
      const previousCursor = cursor;
      const previousScopes = activeScopes;
      const bootstrap = await post<BootstrapResponse>(
        request,
        `${options.url}/sync/bootstrap`,
        body,
      );

      mergeRecords(store, bootstrap.records);
      cursor = bootstrap.seq;
      activeScopes = mergeScopes(activeScopes, body.scopes, bootstrap.revokedScopes ?? []);

      if (previousScopes.length > 0 && previousCursor < bootstrap.seq) {
        cursor = previousCursor;
        await pullUntil(previousScopes, bootstrap.seq);
      }

      return bootstrap;
    },
    async sync(): Promise<void> {
      await pullUntil(activeScopes);
    },
    cursor: () => cursor,
    records: () => [...store.values()],
    activeScopes: () => [...activeScopes],
    project<T>(projection: ProjectionOptions<T>): T {
      return projection.select(
        [...store.values()].filter(
          (record) =>
            !record.deletedAt &&
            record.scopeKind === projection.scope.kind &&
            record.scopeId === projection.scope.id,
        ),
      );
    },
  };

  async function pullUntil(scopes: SeamScope[], untilSeq?: number): Promise<void> {
    let hasMore = scopes.length > 0;

    while (hasMore) {
      const body: PullRequest = {
        afterSeq: cursor,
        scopes,
      };

      if (untilSeq !== undefined) {
        body.untilSeq = untilSeq;
      }

      const pull = await post<PullResponse>(request, `${options.url}/sync/pull`, body);

      mergeRecords(store, pull.records);
      activeScopes = removeScopes(activeScopes, pull.revokedScopes ?? []);
      cursor = pull.seq;
      hasMore = pull.hasMore;
    }
  }
}

async function post<T>(request: typeof fetch, url: string, body: unknown): Promise<T> {
  const response = await request(url, {
    method: "POST",
    body: JSON.stringify(body),
  });

  return (await response.json()) as T;
}

function mergeRecords(store: Map<string, SeamRecord>, records: SeamRecord[]): void {
  for (const record of records) {
    if (record.deletedAt) {
      store.delete(record.id);
    } else {
      store.set(record.id, record);
    }
  }
}

function mergeScopes(current: SeamScope[], next: SeamScope[], revoked: SeamScope[]): SeamScope[] {
  const scopes = new Map(current.map((scope) => [scopeKey(scope), scope]));

  for (const scope of next) {
    scopes.set(scopeKey(scope), scope);
  }

  for (const scope of revoked) {
    scopes.delete(scopeKey(scope));
  }

  return [...scopes.values()];
}

function removeScopes(current: SeamScope[], revoked: SeamScope[]): SeamScope[] {
  const revokedKeys = new Set(revoked.map(scopeKey));

  return current.filter((scope) => !revokedKeys.has(scopeKey(scope)));
}

function scopeKey(scope: SeamScope): string {
  return `${scope.kind}:${scope.id}`;
}
