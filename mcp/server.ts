#!/usr/bin/env node
/** TVCHART MCP server over stdio. Run from the project: `pnpm mcp` or `node mcp/server.ts`.
 * It discovers every running TVCHART dev server of this project and relays tool
 * calls to the chart page; the dev server also serves the same tools over HTTP
 * at /mcp. See docs/architecture/agent-bridge.md and GET /llms.txt. */
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {INSTRUCTIONS,SERVER_INFO,registerTvchartTools} from './tools.ts';
import {HubClient} from './hub-client.ts';
import {AgentPresenceLink} from './presence.ts';
import {renderGuide} from '../server/agent-docs.ts';

const root=process.env.TVCHART_ROOT??resolve(import.meta.dirname,'..'),agentId=`stdio-${randomUUID().slice(0,8)}`;
const server=new McpServer(SERVER_INFO,{instructions:INSTRUCTIONS});
const name=()=>server.server.getClientVersion()?.name??'mcp';
const hub=new HubClient({root,agent:name,agentId});
const presence=new AgentPresenceLink({hub,id:agentId,name});
registerTvchartTools(server,hub,{guide:()=>renderGuide(root)});
// Presence starts once the client has introduced itself, so the chart can show its name.
server.server.oninitialized=()=>presence.start();
let stopped=false;
const shutdown=()=>{if(stopped)return;stopped=true;presence.stop();void server.close().finally(()=>process.exit(0));};
process.stdin.on('end',shutdown);process.stdin.on('close',shutdown);
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
await server.connect(new StdioServerTransport());
