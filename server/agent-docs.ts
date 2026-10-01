import {readFileSync} from 'node:fs';
import {join} from 'node:path';
// Explicit .ts extensions: the stdio MCP server imports this file under Node's type stripping.
import {TOOL_SPECS,toolParameters} from '../mcp/tools.ts';
import {AGENT_BRIDGE_MCP_PATH,AGENT_BRIDGE_PREFIX,READ_METHODS,WRITE_METHODS,type AgentPresence,type HubChartsResponse} from '../src/lib/agent/protocol.ts';

/** Agent onboarding served by the dev server (/llms.txt, /llm.txt,
 * /llms-full.txt). The skill files are the single source: they are read on
 * every request, so edits show up without a restart and never drift from
 * what Claude Code loads as the project skill. */
export const SKILL_DIR='.claude/skills/tvchart-agent';
export const REFERENCE_DOCS:Record<string,string>={
  'drawing-tools':'Every drawing tool id, point order and props',
  overlays:'Overlay kinds (line/hist/band/markers/shapes/objects) with examples',
  recipes:'Support/resistance, trendlines, fibonacci, waves, trade plans, indicator events, cleanup',
};
export interface AgentDocContext {root:string;origin:string;charts:HubChartsResponse;agents:readonly AgentPresence[];full:boolean}

const read=(root:string,path:string)=>{try{return readFileSync(join(root,path),'utf8');}catch{return '';}};
const body=(text:string)=>text.replace(/^---\n[\s\S]*?\n---\n/,'').trim();
/** Skill-relative links become URLs on this server. */
const linkReferences=(text:string,origin:string)=>text.replace(/`?reference\/([\w-]+)\.md`?/g,(_match,name:string)=>`[${name}.md](${origin}${AGENT_BRIDGE_PREFIX}/docs/${name}.md)`);
const shiftHeadings=(text:string,levels:number)=>text.replace(/^(#{1,5}) /gm,(_match,marks:string)=>`${'#'.repeat(Math.min(6,marks.length+levels))} `);

export function renderReference(root:string,name:string):string|undefined {
  if(!Object.hasOwn(REFERENCE_DOCS,name))return;
  const text=read(root,`${SKILL_DIR}/reference/${name}.md`);return text?text.trim()+'\n':undefined;
}
/** The skill with every reference inline: the MCP guide resource and prompt. */
export function renderGuide(root:string):string {
  const parts=[`# open-tradingview agent guide`,'',shiftHeadings(body(read(root,`${SKILL_DIR}/SKILL.md`)).replace(/`?reference\/([\w-]+)\.md`?/g,'the "$1" reference below'),1)];
  for(const name of Object.keys(REFERENCE_DOCS)){const text=renderReference(root,name);if(text)parts.push('',`## Reference: ${name}`,'',shiftHeadings(text,1));}
  return parts.join('\n')+'\n';
}
export function renderAgentDoc(context:AgentDocContext):string {
  const {root,origin,charts,agents,full}=context,mcpUrl=origin+AGENT_BRIDGE_MCP_PATH,stdio=join(root,'mcp/server.ts'),api=origin+AGENT_BRIDGE_PREFIX;
  const chartLines=charts.charts.length?charts.charts.map(chart=>`  - ${chart.symbol} · ${chart.interval} · ${chart.source}${chart.active?' (active)':''} — chartId \`${chart.chartId}\`${chart.visible?'':' · page in background'}`):['  - none — open '+origin+' in a browser tab'];
  const agentLines=agents.length?agents.map(agent=>`  - ${agent.name} (${agent.transport}) since ${new Date(agent.since).toISOString()}`):['  - none'];
  const tools=TOOL_SPECS.map(spec=>full?[`### ${spec.name} — ${spec.title}${spec.readOnly?' (read-only)':''}`,'',spec.description,'',...toolParameters(spec).map(line=>`- ${line}`),''].join('\n')
    :`- \`${spec.name}\`${spec.readOnly?' (read)':''} — ${spec.description}`);
  const references=Object.entries(REFERENCE_DOCS);
  const lines=[
    '# open-tradingview',
    '',
    `> Self-built Svelte + WebGL charting app (K-line, indicators, drawing tools, pattern detectors, market-structure analysis) running at ${origin}. AI agents connect over MCP to read the full state of the chart the user is looking at and to draw or annotate it with any tool. Local-only service: no authentication.`,
    '',
    '## Live status',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Charts connected: ${charts.charts.length}`,...chartLines,
    `- AI clients connected: ${agents.length}`,...agentLines,
    `- Project root: \`${root}\``,
    '',
    '## Connect',
    '',
    '### MCP over HTTP (served by this dev server)',
    '',
    `- URL: \`${mcpUrl}\` (Streamable HTTP, no auth)`,
    `- Claude Code: \`claude mcp add --transport http open-tradingview ${mcpUrl}\``,
    `- JSON-config clients (Cursor, VS Code, Windsurf, Claude Desktop connectors…): \`{"mcpServers":{"open-tradingview":{"type":"http","url":"${mcpUrl}"}}}\``,
    '- Bound to this server: if the dev server moves to another port, update the URL (or use stdio).',
    '',
    '### MCP over stdio (auto-discovers every running open-tradingview server)',
    '',
    `- Claude Code in this repository: the project \`.mcp.json\` already declares \`open-tradingview\` — approve it via \`/mcp\`. Elsewhere: \`claude mcp add open-tradingview -- node ${stdio}\``,
    `- JSON-config clients: \`{"mcpServers":{"open-tradingview":{"command":"node","args":["${stdio}"]}}}\``,
    `- Codex CLI (\`~/.codex/config.toml\`): \`[mcp_servers.open-tradingview]\` with \`command = "node"\` and \`args = ["${stdio}"]\``,
    `- Needs Node ≥ 24 and \`pnpm install\` in the project root. \`TVCHART_BRIDGE_URL=${origin}\` pins it to this server.`,
    '',
    '### Plain HTTP (scripts without MCP)',
    '',
    `- \`GET ${api}/charts\` — connected charts and the active one`,
    `- \`POST ${api}/call\` with \`{"method":"state","params":{},"chartId":"optional"}\` — read methods: ${READ_METHODS.join(', ')}; write methods: ${WRITE_METHODS.join(', ')}. \`params\` are the MCP tool arguments without \`chartId\`. Send \`Accept: application/x-ndjson\` to stream progress lines before the result.`,
    `- \`GET ${api}/events?since=0&waitMs=20000\` — selection/market/scene events (long-poll)`,
    '',
    '## Tools',
    '',
    ...(full?[]:[`Parameters: [${origin}/llms-full.txt](${origin}/llms-full.txt) or the MCP \`tools/list\` schemas.`,'']),
    ...tools,
    '',
    '## How to use the chart well (project skill `tvchart-agent`)',
    '',
    shiftHeadings(linkReferences(body(read(root,`${SKILL_DIR}/SKILL.md`)),origin),1),
    '',
    '## References',
    '',
    ...references.map(([name,title])=>`- [${name}.md](${api}/docs/${name}.md): ${title}`),
    ...(full?[]:[`- [llms-full.txt](${origin}/llms-full.txt): this document with every tool parameter and reference inline`]),
    '- Architecture, protocol and design decisions: `docs/architecture/agent-bridge.md` in the repository',
    '',
  ];
  if(full)for(const [name] of references){const text=renderReference(root,name);if(text)lines.push(`## Reference: ${name}.md`,'',shiftHeadings(text,1),'');}
  return lines.join('\n');
}
