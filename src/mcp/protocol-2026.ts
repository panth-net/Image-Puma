import { SUPPORTED_PROTOCOL_VERSIONS as SDK_LEGACY_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';

/**
 * MCP 2026-07-28 conformance layer.
 *
 * The 1.x TypeScript SDK tops out at the `2025-11-25` revision: it has no
 * `server/discover`, no per-request protocol versioning, no `resultType`, and
 * no cacheable list results. Rather than rewrite a working server onto the v2
 * SDK betas, this module wraps the transport and adds the modern surface around
 * the SDK, leaving every tool handler untouched.
 *
 * The result is a dual-era server: legacy clients keep using `initialize` /
 * `ping` and see only additive extra fields, while modern clients get a
 * stateless, self-describing server that never needs the handshake.
 */

export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/** Newest-first, as `server/discover` and `UnsupportedProtocolVersionError` both require. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([
  ...new Set<string>([MODERN_PROTOCOL_VERSION, ...SDK_LEGACY_PROTOCOL_VERSIONS]),
]);

export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
export const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

/** Spec-reserved code from the `-32020`..`-32099` MCP block. */
export const UNSUPPORTED_PROTOCOL_VERSION_ERROR = -32022;
const INVALID_PARAMS_ERROR = -32602;

/**
 * `resources/read` and the template list are not implemented here, but the
 * cacheable-result rule is keyed off the method name, so listing them keeps the
 * table honest if resources are ever added.
 */
const CACHEABLE_RESULT_METHODS = new Set([
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/read',
  'resources/templates/list',
]);

/**
 * Tool and prompt lists are fixed for the life of the process, so an hour of
 * client-side caching costs nothing. `private` because a local single-user
 * server must never let a shared intermediary cache its responses.
 */
const LIST_CACHE_TTL_MS = 3_600_000;
const LIST_CACHE_SCOPE = 'private';

const JSON_SCHEMA_2020_12_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

export interface ModernServerInfo {
  name: string;
  version: string;
}

export interface ModernProtocolOptions {
  serverInfo: ModernServerInfo;
  /** Advertised by `server/discover`; mirrors what the SDK reports to `initialize`. */
  capabilities: Record<string, unknown>;
  instructions?: string;
  /** Used to answer unknown tool names with `-32602` instead of a tool-level error. */
  toolNames: readonly string[];
}

interface JsonRpcRequestLike {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: { _meta?: Record<string, unknown> } & Record<string, unknown>;
}

interface JsonRpcResultLike {
  jsonrpc: '2.0';
  id: string | number;
  result: Record<string, unknown>;
}

function isRequest(message: JSONRPCMessage): message is JSONRPCMessage & JsonRpcRequestLike {
  const candidate = message as Partial<JsonRpcRequestLike>;
  return typeof candidate.method === 'string' && candidate.id !== undefined;
}

function isResultResponse(message: JSONRPCMessage): message is JSONRPCMessage & JsonRpcResultLike {
  const candidate = message as Partial<JsonRpcResultLike>;
  return candidate.id !== undefined
    && candidate.result !== undefined
    && typeof candidate.result === 'object'
    && candidate.result !== null;
}

/** JSON-RPC ids may be numbers or strings; `1` and `"1"` are different requests. */
function requestKey(id: string | number): string {
  return `${typeof id}:${id}`;
}

function requestedProtocolVersion(request: JsonRpcRequestLike): string | undefined {
  const declared = request.params?._meta?.[PROTOCOL_VERSION_META_KEY];
  return typeof declared === 'string' ? declared : undefined;
}

/**
 * Rewrites the JSON Schema dialect the SDK stamps on generated tool schemas.
 *
 * The SDK hardcodes `draft-07` when converting Zod schemas, but 2026-07-28
 * requires JSON Schema 2020-12 and subjects `inputSchema`/`outputSchema` to
 * strict validation. Every schema this server emits is already valid 2020-12 —
 * a test asserts that against the 2020-12 metaschema — so only the declared
 * dialect has to change.
 */
function normalizeSchemaDialect(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const schema = value as Record<string, unknown>;
  if (typeof schema.type === 'string' || schema.$schema !== undefined) {
    schema.$schema = JSON_SCHEMA_2020_12_DIALECT;
  }
}

function normalizeToolListSchemas(result: Record<string, unknown>): void {
  const tools = result.tools;
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const entry = tool as Record<string, unknown>;
    normalizeSchemaDialect(entry.inputSchema);
    normalizeSchemaDialect(entry.outputSchema);
  }
}

export function buildDiscoverResult(options: ModernProtocolOptions): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: options.capabilities,
    ...(options.instructions ? { instructions: options.instructions } : {}),
    ttlMs: LIST_CACHE_TTL_MS,
    cacheScope: LIST_CACHE_SCOPE,
    _meta: {
      [SERVER_INFO_META_KEY]: {
        name: options.serverInfo.name,
        version: options.serverInfo.version,
      },
    },
  };
}

/**
 * Transport decorator that answers the modern RPCs itself and decorates
 * everything the SDK produces on the way out.
 *
 * It sits between the SDK `Server` and the real transport: `Protocol.connect`
 * assigns `onmessage`/`onclose`/`onerror` here, and this class forwards from
 * the wrapped transport after filtering. Requests it fully answers
 * (`server/discover`, version rejections, malformed `tools/call`) are never
 * handed to the SDK.
 */
export class ModernProtocolTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  private readonly pendingMethods = new Map<string, string>();
  private readonly toolNames: Set<string>;

  constructor(
    private readonly inner: Transport,
    private readonly options: ModernProtocolOptions,
  ) {
    this.toolNames = new Set(options.toolNames);
    inner.onmessage = (message, extra) => this.handleIncoming(message, extra);
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error) => this.onerror?.(error);
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  async close(): Promise<void> {
    this.pendingMethods.clear();
    await this.inner.close();
  }

  send(message: JSONRPCMessage, sendOptions?: TransportSendOptions): Promise<void> {
    return this.inner.send(this.decorateOutgoing(message), sendOptions);
  }

  private handleIncoming(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    if (!isRequest(message)) {
      this.onmessage?.(message, extra);
      return;
    }

    const declaredVersion = requestedProtocolVersion(message);
    if (declaredVersion !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(declaredVersion)) {
      void this.respondWithError(message.id, UNSUPPORTED_PROTOCOL_VERSION_ERROR, 'Unsupported protocol version', {
        supported: [...SUPPORTED_PROTOCOL_VERSIONS],
        requested: declaredVersion,
      });
      return;
    }

    if (message.method === 'server/discover') {
      void this.respondWithResult(message.id, buildDiscoverResult(this.options));
      return;
    }

    const paramsError = this.validateNamedParams(message);
    if (paramsError) {
      void this.respondWithError(message.id, INVALID_PARAMS_ERROR, paramsError);
      return;
    }

    this.pendingMethods.set(requestKey(message.id), message.method);
    this.onmessage?.(message, extra);
  }

  /**
   * The SDK reports a malformed `tools/call` as `-32603 Internal error` and an
   * unknown tool name as an `isError` tool result. Both are protocol-level
   * faults that 2026-07-28 assigns `-32602`. Argument-schema failures are left
   * alone: those are tool-execution errors and stay `isError` results so the
   * model can self-correct (SEP-1303).
   */
  private validateNamedParams(request: JsonRpcRequestLike): string | undefined {
    if (request.method !== 'tools/call' && request.method !== 'prompts/get') return undefined;

    const name = request.params?.name;
    if (typeof name !== 'string' || name.length === 0) {
      return `Invalid params: ${request.method} requires a non-empty string "name".`;
    }
    if (request.method === 'tools/call' && !this.toolNames.has(name)) {
      return `Unknown tool: ${name}`;
    }
    return undefined;
  }

  /**
   * Stamps the fields 2026-07-28 requires on every result. All are additive, so
   * legacy clients see them as unknown extra fields and ignore them.
   */
  private decorateOutgoing(message: JSONRPCMessage): JSONRPCMessage {
    if (!isResultResponse(message)) return message;

    const method = this.pendingMethods.get(requestKey(message.id));
    this.pendingMethods.delete(requestKey(message.id));

    const result: Record<string, unknown> = { ...message.result };
    result.resultType = result.resultType ?? 'complete';
    result._meta = {
      ...(result._meta as Record<string, unknown> | undefined),
      [SERVER_INFO_META_KEY]: {
        name: this.options.serverInfo.name,
        version: this.options.serverInfo.version,
      },
    };

    if (method && CACHEABLE_RESULT_METHODS.has(method)) {
      result.ttlMs = result.ttlMs ?? LIST_CACHE_TTL_MS;
      result.cacheScope = result.cacheScope ?? LIST_CACHE_SCOPE;
    }
    if (method === 'tools/list') normalizeToolListSchemas(result);

    return { ...message, result } as JSONRPCMessage;
  }

  private respondWithResult(id: string | number, result: Record<string, unknown>): Promise<void> {
    return this.inner
      .send({ jsonrpc: '2.0', id, result } as JSONRPCMessage)
      .catch((error: unknown) => {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      });
  }

  private respondWithError(
    id: string | number,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<void> {
    return this.inner
      .send({
        jsonrpc: '2.0',
        id,
        error: { code, message, ...(data === undefined ? {} : { data }) },
      } as JSONRPCMessage)
      .catch((error: unknown) => {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      });
  }
}
