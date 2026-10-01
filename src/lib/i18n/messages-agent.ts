/** Status-bar entry of the local MCP agent bridge (src/lib/agent). */
export const agentBridgeMessages:Record<string,string>={
  'AI 图表桥接':'AI chart bridge','AI 桥接重连中':'AI bridge reconnecting','AI 操作中':'AI working','AI 已连接':'AI connected','只读':'Read-only',
  '本机 AI Agent 通过 MCP 读取行情、指标与形态证据，并用可编辑绘图、叠加层和指标标注当前图表。':'Local AI agents read market data, indicators and pattern evidence over MCP, then annotate this chart with editable drawings, overlays and indicators.',
  '连接':'Connection','已连接':'Connected','重试中':'Retrying','本页调用':'Calls on this page','最近调用':'Last call','允许 AI 修改图表':'Allow AI to edit the chart',
  'AI 未连接':'AI not connected','本页':'This page','已接入本地服务':'Linked to the local service','AI 客户端':'AI clients','{0} 个在线':'{0} online','无':'None','连接于':'since',
  '还没有 AI 客户端连接。在 Claude Code 等工具中添加 MCP 服务即可，方法见接入说明。':'No AI client is connected yet. Add the MCP server in Claude Code or another client — see the setup guide.','接入说明':'Setup guide',
  '关闭后 AI 仍可读取，但不能绘制、修改或切换视图。AI 绘图带作者标记，可在对象树中编辑或删除，也可撤销。':'When off, AI can still read but cannot draw, edit or change the view. AI drawings are tagged with their author; edit or delete them in the object tree, or undo.',
};
