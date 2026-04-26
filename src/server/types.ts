import type { z } from "zod";
import type { SeamRecord, SeamScope } from "../shared/types.js";

export interface SeamContext {
  actorId: string | null;
  actorType: "anonymous" | "user" | "token" | "service";
}

export type SeamAuthorizeAction = "bootstrap" | "pull" | "create" | "mutate";

export interface SeamAuthorizeInput {
  ctx: SeamContext;
  scope: SeamScope;
  action: SeamAuthorizeAction;
  record?: SeamRecord;
}

export interface RecordType<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  schema: TSchema;
}

export interface CreateWrite {
  op: "create";
  type: string;
  scope: SeamScope;
  data: Record<string, unknown>;
  id?: string;
}

export interface UpdateWrite {
  op: "update";
  id: string;
  type: string;
  expectedVersion: number;
  data: Record<string, unknown>;
}

export interface DeleteWrite {
  op: "delete";
  id: string;
  type: string;
  expectedVersion: number;
}

export type SeamWrite = CreateWrite | UpdateWrite | DeleteWrite;

export interface MutationCommit {
  writes: SeamWrite[];
  primaryRecordId?: string;
  effects?: CommitEffect[];
  events?: MutationEvent[];
}

export interface CommitEffect {
  tableName: string;
  execute(): Promise<void> | void;
}

export interface MutationEvent {
  type: string;
  payload: Record<string, unknown>;
  recordId?: string;
}

type ScopeResolver<TInput> = {
  resolve(input: TInput): SeamScope;
}["resolve"];

type MutationExecutor<TInput> = {
  execute(
    input: TInput,
    ctx: { seam: SeamContext; scope: SeamScope; current: SeamRecord },
  ): MutationCommit | Promise<MutationCommit>;
}["execute"];

export interface CreateMutationDefinition<TInput extends z.ZodType = z.ZodType> {
  record?: string;
  input: TInput;
  scope?: ScopeResolver<z.output<TInput>>;
  execute: MutationExecutor<z.output<TInput>>;
}

export interface CreateSeamServerOptions<
  TMutations extends Record<string, CreateMutationDefinition>,
> {
  db: SeamDatabase;
  records: RecordType[];
  resolveContext: (request: Request, env?: unknown) => SeamContext | Promise<SeamContext>;
  authorize?: (input: SeamAuthorizeInput) => boolean | Promise<boolean>;
  mutations: TMutations;
}

export interface SeamDatabase {
  runMutationBatch<T>(operation: () => Promise<T>): Promise<T>;
  getRecord(id: string): Promise<StoredRecord | undefined>;
  getRecords(ids: string[]): Promise<StoredRecord[]>;
  listRecordsForScopes(scopes: SeamScope[]): Promise<StoredRecord[]>;
  listSeqForScopes(request: SeqScanRequest): Promise<SeqLogEntry[]>;
  getMaxSeq(): Promise<number>;
  getMutationReceipt(
    actorId: string,
    clientMutationId: string,
  ): Promise<MutationReceipt | undefined>;
  createRecord(record: StoredRecord): Promise<void>;
  updateRecord(write: UpdateRecordWrite): Promise<StoredRecord | undefined>;
  deleteRecord(write: DeleteRecordWrite): Promise<StoredRecord | undefined>;
  appendSeqLog(entry: SeqLogInsert): Promise<number>;
  createMutationReceipt(receipt: MutationReceipt): Promise<void>;
  appendOutbox(entry: OutboxInsert): Promise<number>;
  listOutboxAfter(lastOutboxId: number, limit: number): Promise<OutboxEntry[]>;
  getOutboxConsumerCursor(consumerName: string): Promise<number>;
  setOutboxConsumerCursor(consumerName: string, lastOutboxId: number): Promise<void>;
}

export interface MutateRequest {
  mutation: string;
  input: Record<string, unknown>;
  id?: string;
  expectedVersion?: number;
  clientMutationId: string;
}

export interface BootstrapRequest {
  scopes: SeamScope[];
}

export interface PullRequest {
  afterSeq: number;
  scopes: SeamScope[];
  limit?: number;
  untilSeq?: number;
}

export interface SeqLogEntry {
  seq: number;
  opId: string;
  scopeKind: string;
  scopeId: string;
  recordType: string;
  recordId: string;
  mutationType: string;
  actorId: string;
  timestamp: string;
  version: number;
}

interface SeqScanRequest {
  scopes: SeamScope[];
  afterSeq: number;
  untilSeq?: number;
  limit: number;
}

export interface StoredRecord {
  id: string;
  type: string;
  scopeKind: string;
  scopeId: string;
  version: number;
  data: Record<string, unknown>;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  deletedAt?: string;
  lastOpId: string;
}

interface SeqLogInsert {
  opId: string;
  scopeKind: string;
  scopeId: string;
  recordType: string;
  recordId: string;
  mutationType: string;
  actorId: string;
  timestamp: string;
  version: number;
}

interface UpdateRecordWrite {
  id: string;
  type: string;
  expectedVersion: number;
  data: Record<string, unknown>;
  updatedAt: string;
  updatedBy: string;
  lastOpId: string;
}

interface DeleteRecordWrite {
  id: string;
  type: string;
  expectedVersion: number;
  deletedAt: string;
  updatedBy: string;
  lastOpId: string;
}

interface MutationReceipt {
  actorId: string;
  clientMutationId: string;
  requestHash: string;
  seq: number;
  scopeKind: string;
  scopeId: string;
  responseJson: string;
  createdAt: string;
}

interface OutboxInsert {
  opId: string;
  seq: number;
  scopeKind: string;
  scopeId: string;
  recordType?: string;
  recordId?: string;
  eventType: string;
  payload: Record<string, unknown>;
  actorId: string;
  createdAt: string;
}

export interface OutboxEntry extends OutboxInsert {
  id: number;
}
