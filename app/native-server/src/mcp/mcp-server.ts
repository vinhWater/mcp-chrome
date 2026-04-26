import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { setupTools } from './register-tools';

/**
 * Factory function to create a new MCP Server instance.
 * Each session gets its own Server instance to support multiple concurrent connections.
 * All instances share the same native messaging host connection via setupTools.
 */
export const createMcpServer = (): Server => {
  const server = new Server(
    {
      name: 'ChromeMcpServer',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  setupTools(server);
  return server;
};
