import { Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosError } from 'axios';

/**
 * One JSON-RPC client for an MCP server.
 *
 * Both upstreams this bridge talks to — the 91astro brain and Foundry's run API — are MCP, not
 * REST. `pipeline-bridge` could get away with a plain `forward()` because the creative pipeline
 * speaks HTTP verbs; here every call is `POST` with a `tools/call` envelope, and the interesting
 * part is reading the answer back out.
 *
 * This is a faithful port of `slack-bot/pipeline/brain_bridge.py::call_brain_tool_parsed`, which
 * earned each of its branches the hard way. Two in particular are not optional:
 *
 * 1. THE RESPONSE MAY BE SSE, AND THE FIRST FRAME IS USUALLY NOT THE ANSWER. The server may open
 *    with `notifications/progress` frames and split one JSON payload across several `data:` lines.
 *    Taking the first frame gives you a progress notification and calls it a result. So frames are
 *    reassembled on blank lines and the TERMINAL response is selected by matching the request id
 *    AND carrying `result` or `error`.
 *
 * 2. A TOOL THAT ANSWERS AND REFUSES IS NOT A TRANSPORT FAILURE. `result.isError` means the server
 *    was reached and said no — worth surfacing verbatim to an operator. An unreachable server is a
 *    different fact and must not be retried the same way. The two throw different errors so the
 *    controller can map one to the upstream's own status and the other to 502.
 *
 * The original's docstring records what happens when this is got wrong: an audit built on the
 * truncating variant reported "0 brain offerings" against a table holding fourteen — "worse than no
 * audit, because a false gap costs more attention than a missing one."
 */

/** The server was reached and the tool refused, or answered unreadably. */
export class McpToolError extends Error {
  constructor(
    message: string,
    readonly tool: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

/** The server could not be reached, or did not speak JSON-RPC. */
export class McpTransportError extends Error {
  constructor(
    message: string,
    readonly tool: string,
  ) {
    super(message);
    this.name = 'McpTransportError';
  }
}

export class McpClient {
  private readonly logger = new Logger(McpClient.name);
  private readonly http: AxiosInstance;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly token: string,
    timeoutMs = 60000,
    private readonly label = 'mcp',
    /**
     * When set, the ONLY tool names this client may call. Anything else throws before a request
     * is built.
     *
     * This exists for one credential in particular. Reading and pausing a schedule needs Foundry's
     * BUILDER token, which is the same credential that can rewrite an agent's prompts, edit its
     * graph and deploy a new version. The dashboard needs two verbs out of that surface; handing it
     * the whole token and trusting the controller to only call two of them makes every future
     * route a place where that trust can quietly lapse.
     *
     * So the restriction lives on the transport, not on the caller's good intentions: a client
     * constructed with an allowlist cannot express the other calls at all.
     */
    private readonly allowedTools?: ReadonlySet<string>,
  ) {
    this.http = axios.create({ timeout: timeoutMs });
  }

  isConfigured(): boolean {
    return Boolean(this.url);
  }

  private assertAllowed(tool: string): void {
    if (this.allowedTools && !this.allowedTools.has(tool)) {
      throw new McpToolError(
        `${this.label} may not call '${tool}'`,
        tool,
        `This client is restricted to: ${[...this.allowedTools].join(', ')}. The restriction is ` +
          'deliberate — the token behind it can do far more than this surface should expose.',
      );
    }
  }

  /**
   * Call one tool and return its structured result.
   *
   * Always returns an object. A tool that yields a list wraps it — every brain tool already returns
   * `{rows: [...]}` or similar, and inventing an array-or-object union here would push the
   * ambiguity onto every caller.
   */
  async call<T = Record<string, unknown>>(
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    if (!this.isConfigured()) {
      throw new McpTransportError(`${this.label} is not configured`, tool);
    }
    this.assertAllowed(tool);
    const id = this.nextId++;
    let raw: string;
    try {
      const res = await this.http.request<string>({
        method: 'post',
        url: this.url,
        headers: {
          'Content-Type': 'application/json',
          // Both shapes must be acceptable: the server picks, and it picks SSE for larger results.
          Accept: 'application/json, text/event-stream',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        data: {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        },
        // Take the body verbatim; axios' JSON parser would choke on an SSE stream.
        responseType: 'text',
        transformResponse: [(d: unknown) => d],
      });
      raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    } catch (err) {
      const axiosErr = err as AxiosError;
      const message = axiosErr.message ?? 'request failed';
      this.logger.error(`${this.label} ${tool} transport failure: ${message}`);
      throw new McpTransportError(
        `Could not reach ${this.label}: ${message}`,
        tool,
      );
    }
    return this.parse<T>(raw, id, tool);
  }

  /** Extract the terminal JSON-RPC response and unwrap its structured content. */
  private parse<T>(raw: string, id: number, tool: string): T {
    let body = raw;

    if (raw.split(/\r?\n/).some((line) => line.startsWith('data:'))) {
      const frames: string[] = [];
      let current: string[] = [];
      for (const line of [...raw.split(/\r?\n/), '']) {
        if (line === '') {
          if (current.length) {
            frames.push(current.join('\n'));
            current = [];
          }
        } else if (line.startsWith('data:')) {
          current.push(line.slice(5).replace(/^ /, ''));
        }
      }
      // The LAST frame matching this request id wins. Not the first frame on the stream, which is
      // typically a progress notification carrying no result at all.
      let chosen: string | null = null;
      for (const frame of frames) {
        try {
          const candidate: unknown = JSON.parse(frame);
          if (
            candidate &&
            typeof candidate === 'object' &&
            (candidate as { id?: unknown }).id === id &&
            ('result' in (candidate as object) ||
              'error' in (candidate as object))
          ) {
            chosen = frame;
          }
        } catch {
          continue;
        }
      }
      if (chosen === null) {
        throw new McpTransportError(
          `${this.label} SSE returned no JSON-RPC response matching request ${id}`,
          tool,
        );
      }
      body = chosen;
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(body);
    } catch {
      throw new McpTransportError(
        `${this.label} returned a non-JSON body`,
        tool,
      );
    }
    if (!envelope || typeof envelope !== 'object') {
      throw new McpTransportError(
        `${this.label} returned a non-object envelope`,
        tool,
      );
    }
    const env = envelope as { error?: unknown; result?: unknown };
    if (env.error !== undefined) {
      throw new McpToolError(
        `${tool} failed`,
        tool,
        typeof env.error === 'string'
          ? env.error
          : JSON.stringify(env.error).slice(0, 400),
      );
    }
    const result = env.result;
    if (!result || typeof result !== 'object') {
      throw new McpTransportError(
        `${this.label} returned a non-object result`,
        tool,
      );
    }
    const r = result as {
      isError?: boolean;
      structuredContent?: unknown;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (r.isError) {
      throw new McpToolError(
        `${tool} reported an error`,
        tool,
        JSON.stringify(r.content ?? r.structuredContent ?? '').slice(0, 400),
      );
    }
    if (r.structuredContent && typeof r.structuredContent === 'object') {
      return this.refuseIfNotOk(r.structuredContent, tool) as T;
    }
    for (const block of r.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        try {
          const parsed: unknown = JSON.parse(block.text);
          if (parsed && typeof parsed === 'object') {
            return this.refuseIfNotOk(parsed, tool) as T;
          }
        } catch {
          continue;
        }
      }
    }
    throw new McpToolError(`${tool} returned no readable content`, tool);
  }

  /**
   * A payload saying `ok: false` is a refusal, even when nothing upstream flagged it.
   *
   * Foundry's run API answers a forbidden agent with
   * `{"ok": false, "error": "This token isn't allowed to run that agent."}` — HTTP 200, no
   * JSON-RPC error, and `isError` unset. Read literally that is a successful call, so the caller
   * went looking for `run_id`, did not find it, and reported "Foundry accepted the run but
   * returned no run id" — which is both wrong and useless. The upstream had already said exactly
   * what was wrong; the client threw the sentence away.
   *
   * Only `ok === false` counts. A missing `ok` is the normal shape for every brain tool
   * (`{count, rows}`), and treating absence as failure would break all of them.
   */
  private refuseIfNotOk(payload: unknown, tool: string): unknown {
    const p = payload as { ok?: unknown; error?: unknown };
    if (p && typeof p === 'object' && p.ok === false) {
      const detail =
        typeof p.error === 'string'
          ? p.error
          : JSON.stringify(p.error ?? payload).slice(0, 400);
      throw new McpToolError(`${tool} refused`, tool, detail);
    }
    return payload;
  }

  /**
   * Call a tool and return null instead of throwing.
   *
   * For reads that compose a page: one unavailable section should degrade that section, not blank
   * the console. The caller is expected to render the gap rather than pretend the data is empty —
   * "could not read" and "nothing there" are different facts and the UI distinguishes them.
   */
  async tryCall<T = Record<string, unknown>>(
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<T | null> {
    try {
      return await this.call<T>(tool, args);
    } catch (err) {
      this.logger.warn(
        `${this.label} ${tool} unavailable: ${(err as Error).message}`,
      );
      return null;
    }
  }
}
