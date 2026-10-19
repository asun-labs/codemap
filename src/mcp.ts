#!/usr/bin/env node
import { startMcpServer } from './mcp/server.js';

startMcpServer().catch((e: unknown) => {
  console.error('codemap mcp 启动失败:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
