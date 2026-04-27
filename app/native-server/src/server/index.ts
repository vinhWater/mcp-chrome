/**
 * HTTP Server - Core server implementation.
 *
 * Responsibilities:
 * - Fastify instance management
 * - Plugin registration (CORS, etc.)
 * - Route delegation to specialized modules
 * - MCP transport handling
 * - Server lifecycle management
 */
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import {
  NATIVE_SERVER_PORT,
  TIMEOUTS,
  SERVER_CONFIG,
  HTTP_STATUS,
  ERROR_MESSAGES,
} from '../constant';
import { NativeMessagingHost } from '../native-messaging-host';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../mcp/mcp-server';
import { AgentStreamManager } from '../agent/stream-manager';
import { AgentChatService } from '../agent/chat-service';
import { CodexEngine } from '../agent/engines/codex';
import { ClaudeEngine } from '../agent/engines/claude';
import { closeDb } from '../agent/db';
import { registerAgentRoutes } from './routes';

// ============================================================
// Types
// ============================================================

interface ExtensionRequestPayload {
  data?: unknown;
}

// ============================================================
// Server Class
// ============================================================

// Session idle timeout: 30 minutes
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
// Cleanup sweep interval: every 5 minutes
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';

export class Server {
  private fastify: FastifyInstance;
  public isRunning = false;
  private nativeHost: NativeMessagingHost | null = null;
  private transportsMap: Map<string, StreamableHTTPServerTransport | SSEServerTransport> =
    new Map();
  // Per-session MCP Server instances
  private mcpServersMap: Map<string, McpServer> = new Map();
  // Track last activity time per session for idle timeout
  private sessionLastActivity: Map<string, number> = new Map();
  // Periodic cleanup timer
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private agentStreamManager: AgentStreamManager;
  private agentChatService: AgentChatService;

  constructor() {
    this.fastify = Fastify({ logger: SERVER_CONFIG.LOGGER_ENABLED });
    this.agentStreamManager = new AgentStreamManager();
    this.agentChatService = new AgentChatService({
      engines: [new CodexEngine(), new ClaudeEngine()],
      streamManager: this.agentStreamManager,
    });
    this.setupPlugins();
    this.setupRoutes();
  }

  /**
   * Associate NativeMessagingHost instance.
   */
  public setNativeHost(nativeHost: NativeMessagingHost): void {
    this.nativeHost = nativeHost;
  }

  private async setupPlugins(): Promise<void> {
    await this.fastify.register(cors, {
      origin: (origin, cb) => {
        // Allow requests with no origin (e.g., curl, server-to-server)
        if (!origin) {
          return cb(null, true);
        }
        // Check if origin matches any pattern in whitelist
        const allowed = SERVER_CONFIG.CORS_ORIGIN.some((pattern) =>
          pattern instanceof RegExp ? pattern.test(origin) : origin.startsWith(pattern),
        );
        cb(null, allowed);
      },
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      credentials: true,
    });
  }

  private setupRoutes(): void {
    // Health check
    this.setupHealthRoutes();

    // Extension communication
    this.setupExtensionRoutes();

    // Agent routes (delegated to separate module)
    registerAgentRoutes(this.fastify, {
      streamManager: this.agentStreamManager,
      chatService: this.agentChatService,
    });

    // MCP routes
    this.setupMcpRoutes();
  }

  // ============================================================
  // Health Routes
  // ============================================================

  private setupHealthRoutes(): void {
    this.fastify.get('/ping', async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.status(HTTP_STATUS.OK).send({
        status: 'ok',
        message: 'pong',
      });
    });
  }

  // ============================================================
  // Extension Routes
  // ============================================================

  private setupExtensionRoutes(): void {
    this.fastify.get(
      '/ask-extension',
      async (request: FastifyRequest<{ Body: ExtensionRequestPayload }>, reply: FastifyReply) => {
        if (!this.nativeHost) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE });
        }
        if (!this.isRunning) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.SERVER_NOT_RUNNING });
        }

        try {
          const extensionResponse = await this.nativeHost.sendRequestToExtensionAndWait(
            request.query,
            'process_data',
            TIMEOUTS.EXTENSION_REQUEST_TIMEOUT,
          );
          return reply.status(HTTP_STATUS.OK).send({ status: 'success', data: extensionResponse });
        } catch (error: unknown) {
          const err = error as Error;
          if (err.message.includes('timed out')) {
            return reply
              .status(HTTP_STATUS.GATEWAY_TIMEOUT)
              .send({ status: 'error', message: ERROR_MESSAGES.REQUEST_TIMEOUT });
          } else {
            return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
              status: 'error',
              message: `Failed to get response from extension: ${err.message}`,
            });
          }
        }
      },
    );
  }

  // ============================================================
  // MCP Routes
  // ============================================================

  private setupMcpRoutes(): void {
    // SSE endpoint
    this.fastify.get('/sse', async (_, reply) => {
      try {
        reply.raw.writeHead(HTTP_STATUS.OK, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const transport = new SSEServerTransport('/messages', reply.raw);
        const sessionId = transport.sessionId;
        this.transportsMap.set(sessionId, transport);
        this.sessionLastActivity.set(sessionId, Date.now());

        // Create a dedicated MCP Server for this SSE session
        const mcpServer = createMcpServer();
        this.mcpServersMap.set(sessionId, mcpServer);

        reply.raw.on('close', () => {
          this.cleanupSession(sessionId);
        });

        await mcpServer.connect(transport);

        reply.raw.write(':\n\n');
      } catch (error) {
        if (!reply.sent) {
          reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
        }
      }
    });

    // SSE messages endpoint
    this.fastify.post('/messages', async (req, reply) => {
      try {
        const { sessionId } = req.query as { sessionId?: string };
        const transport = this.transportsMap.get(sessionId || '') as SSEServerTransport;
        if (!sessionId || !transport) {
          reply.code(HTTP_STATUS.BAD_REQUEST).send('No transport found for sessionId');
          return;
        }

        await transport.handlePostMessage(req.raw, reply.raw, req.body);
      } catch (error) {
        if (!reply.sent) {
          reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
        }
      }
    });

    // MCP POST endpoint
    this.fastify.post('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport | undefined = this.transportsMap.get(
        sessionId || '',
      ) as StreamableHTTPServerTransport;

      if (transport) {
        // Transport found, update last activity
        if (sessionId) {
          this.sessionLastActivity.set(sessionId, Date.now());
        }
      } else if (!sessionId && isInitializeRequest(request.body)) {
        // New session: create a dedicated transport and MCP Server instance
        const newSessionId = randomUUID();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (initializedSessionId) => {
            if (transport && initializedSessionId === newSessionId) {
              this.transportsMap.set(initializedSessionId, transport);
              this.sessionLastActivity.set(initializedSessionId, Date.now());
            }
          },
        });

        transport.onclose = () => {
          if (transport?.sessionId) {
            this.cleanupSession(transport.sessionId);
          }
        };

        // Each session gets its own MCP Server instance
        const mcpServer = createMcpServer();
        this.mcpServersMap.set(newSessionId, mcpServer);
        await mcpServer.connect(transport);
      } else {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_MCP_REQUEST });
        return;
      }

      // Hijack the reply so Fastify hands over full control of the response
      // to the SDK transport (which writes its own headers, status, and SSE stream).
      reply.hijack();

      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    });

    // MCP GET endpoint (standalone SSE stream for server-initiated messages)
    this.fastify.get('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId
        ? (this.transportsMap.get(sessionId) as StreamableHTTPServerTransport)
        : undefined;

      if (!transport) {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({
          error: ERROR_MESSAGES.INVALID_SSE_SESSION,
        });
        return;
      }

      // Update last activity timestamp for this session
      this.sessionLastActivity.set(sessionId!, Date.now());

      // IMPORTANT: Hijack the reply BEFORE passing to transport.
      // This tells Fastify we're taking over the response completely,
      // allowing the SDK transport to manage its own SSE headers and streaming.
      reply.hijack();

      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    });

    // MCP DELETE endpoint — client explicitly terminates session
    this.fastify.delete('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId
        ? (this.transportsMap.get(sessionId) as StreamableHTTPServerTransport)
        : undefined;

      if (!transport) {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_SESSION_ID });
        return;
      }

      // Hijack before delegating to SDK transport
      reply.hijack();

      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
        // Session cleanup happens via transport.onclose callback
        // (set up during POST /mcp initialize), triggered by SDK's handleDeleteRequest
      } catch (error) {
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    });
  }

  // ============================================================
  // Server Lifecycle
  // ============================================================

  // ============================================================
  // Session Cleanup
  // ============================================================

  /**
   * Cleanup a single session: close MCP server, remove transport and activity tracking.
   */
  private async cleanupSession(sessionId: string): Promise<void> {
    // Close the MCP Server instance for this session
    const mcpServer = this.mcpServersMap.get(sessionId);
    if (mcpServer) {
      try {
        await mcpServer.close();
      } catch {
        // Ignore close errors during cleanup
      }
      this.mcpServersMap.delete(sessionId);
    }

    // Remove transport and activity tracking
    this.transportsMap.delete(sessionId);
    this.sessionLastActivity.delete(sessionId);
  }

  /**
   * Sweep and cleanup idle sessions that exceeded the timeout.
   */
  private async cleanupIdleSessions(): Promise<void> {
    const now = Date.now();
    const expiredSessions: string[] = [];

    for (const [sessionId, lastActivity] of this.sessionLastActivity) {
      if (now - lastActivity > SESSION_IDLE_TIMEOUT_MS) {
        expiredSessions.push(sessionId);
      }
    }

    for (const sessionId of expiredSessions) {
      await this.cleanupSession(sessionId);
    }

    if (expiredSessions.length > 0) {
      console.log(`[MCP] Cleaned up ${expiredSessions.length} idle session(s)`);
    }
  }

  /**
   * Cleanup all active sessions (used during server shutdown).
   */
  private async cleanupAllSessions(): Promise<void> {
    const sessionIds = [...this.mcpServersMap.keys()];
    for (const sessionId of sessionIds) {
      await this.cleanupSession(sessionId);
    }
  }

  // ============================================================
  // Server Lifecycle
  // ============================================================

  public async start(port = NATIVE_SERVER_PORT, nativeHost: NativeMessagingHost): Promise<void> {
    if (!this.nativeHost) {
      this.nativeHost = nativeHost;
    } else if (this.nativeHost !== nativeHost) {
      this.nativeHost = nativeHost;
    }

    if (this.isRunning) {
      return;
    }

    try {
      await this.fastify.listen({ port, host: SERVER_CONFIG.HOST });

      // Set port environment variables after successful listen for Chrome MCP URL resolution
      process.env.CHROME_MCP_PORT = String(port);
      process.env.MCP_HTTP_PORT = String(port);

      // Start periodic session cleanup timer
      this.cleanupTimer = setInterval(() => {
        this.cleanupIdleSessions().catch(() => {
          // Ignore cleanup errors
        });
      }, SESSION_CLEANUP_INTERVAL_MS);

      this.isRunning = true;
    } catch (err) {
      this.isRunning = false;
      throw err;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      // Stop cleanup timer
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }

      // Cleanup all active sessions
      await this.cleanupAllSessions();

      await this.fastify.close();
      closeDb();
      this.isRunning = false;
    } catch (err) {
      this.isRunning = false;
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }
      closeDb();
      throw err;
    }
  }

  public getInstance(): FastifyInstance {
    return this.fastify;
  }
}

const serverInstance = new Server();
export default serverInstance;
