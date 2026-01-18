import { randomUUID } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'fs';
import { createRequire } from 'module';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ToolInput } from '../renderer/types/chat';
import { parsePartialJson } from '../renderer/utils/parsePartialJson';
import type { SystemInitInfo } from '../shared/types/system';
import { broadcast } from './sse';

type SessionState = 'idle' | 'running' | 'error';

type ToolUseState = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  streamIndex: number;
  inputJson?: string;
  parsedInput?: ToolInput;
  result?: string;
  isLoading?: boolean;
  isError?: boolean;
  subagentCalls?: SubagentToolCall[];
};

type SubagentToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  streamIndex?: number;
  inputJson?: string;
  parsedInput?: ToolInput;
  result?: string;
  isLoading?: boolean;
  isError?: boolean;
};

type ContentBlock = {
  type: 'text' | 'tool_use' | 'thinking';
  text?: string;
  tool?: ToolUseState;
  thinking?: string;
  thinkingStartedAt?: number;
  thinkingDurationMs?: number;
  thinkingStreamIndex?: number;
  isComplete?: boolean;
};

export type MessageWire = {
  id: string;
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  timestamp: string;
  attachments?: {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    savedPath?: string;
    relativePath?: string;
    previewUrl?: string;
    isImage?: boolean;
  }[];
};

type MessageQueueItem = {
  message: SDKUserMessage['message'];
  resolve: () => void;
};

export type SessionMetadata = {
  id: string;
  name: string;
  createdAt: string;
  lastMessageAt: string;
  state: SessionState;
  messageCount: number;
};

const requireModule = createRequire(import.meta.url);

// Session class encapsulates all state for a single chat session
class Session {
  readonly id: string;
  name: string;
  readonly createdAt: Date;
  lastMessageAt: Date;

  sessionState: SessionState = 'idle';
  querySession: Query | null = null;
  isProcessing = false;
  shouldAbortSession = false;
  sessionTerminationPromise: Promise<void> | null = null;
  isInterruptingResponse = false;
  isStreamingMessage = false;

  messages: MessageWire[] = [];
  streamIndexToToolId: Map<number, string> = new Map();
  toolResultIndexToId: Map<number, string> = new Map();
  childToolToParent: Map<string, string> = new Map();
  messageSequence = 0;

  logStream: WriteStream | null = null;
  logFilePath = '';
  logLines: string[] = [];
  systemInitInfo: SystemInitInfo | null = null;
  messageQueue: MessageQueueItem[] = [];

  constructor(id?: string) {
    this.id = id || randomUUID();
    this.name = `Session ${new Date().toLocaleString()}`;
    this.createdAt = new Date();
    this.lastMessageAt = new Date();
  }

  getMetadata(): SessionMetadata {
    return {
      id: this.id,
      name: this.name,
      createdAt: this.createdAt.toISOString(),
      lastMessageAt: this.lastMessageAt.toISOString(),
      state: this.sessionState,
      messageCount: this.messages.length
    };
  }

  private autoGenerateName(firstMessage: string): string {
    const preview = firstMessage.substring(0, 30).split(/[。\n]/)[0];
    return preview + (firstMessage.length > 30 ? '...' : '');
  }

  updateNameFromFirstMessage(): void {
    if (this.messages.length === 1 && this.messages[0].role === 'user') {
      const content = typeof this.messages[0].content === 'string' ? this.messages[0].content : '';
      this.name = this.autoGenerateName(content);
    }
  }

  setSessionState(nextState: SessionState): void {
    if (this.sessionState === nextState) {
      return;
    }
    this.sessionState = nextState;
    broadcast('chat:status', { sessionState: nextState, sessionId: this.id }, this.id);
  }

  ensureAssistantMessage(): MessageWire {
    const lastMessage = this.messages[this.messages.length - 1];
    if (lastMessage && lastMessage.role === 'assistant' && this.isStreamingMessage) {
      return lastMessage;
    }
    const assistant: MessageWire = {
      id: String(this.messageSequence++),
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString()
    };
    this.messages.push(assistant);
    this.isStreamingMessage = true;
    return assistant;
  }

  ensureContentArray(message: MessageWire): ContentBlock[] {
    if (typeof message.content === 'string') {
      const contentArray: ContentBlock[] = [];
      if (message.content) {
        contentArray.push({ type: 'text', text: message.content });
      }
      message.content = contentArray;
      return contentArray;
    }
    return message.content;
  }

  appendTextChunk(chunk: string): void {
    const message = this.ensureAssistantMessage();
    if (typeof message.content === 'string') {
      message.content += chunk;
      return;
    }
    const contentArray = message.content;
    const lastBlock = contentArray[contentArray.length - 1];
    if (lastBlock?.type === 'text') {
      lastBlock.text = `${lastBlock.text ?? ''}${chunk}`;
    } else {
      contentArray.push({ type: 'text', text: chunk });
    }
  }

  findToolBlockById(toolUseId: string): { tool: ToolUseState } | null {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const message = this.messages[i];
      if (message.role !== 'assistant') {
        continue;
      }
      if (typeof message.content === 'string') {
        continue;
      }
      const toolBlock = message.content.find(
        (block) => block.type === 'tool_use' && block.tool?.id === toolUseId
      );
      if (toolBlock && toolBlock.type === 'tool_use' && toolBlock.tool) {
        return { tool: toolBlock.tool };
      }
    }
    return null;
  }

  createLogStream(agentDir: string): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
    const logsDir = `${agentDir}/logs`;
    mkdirSync(logsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logFilePath = `${logsDir}/agent-${timestamp}-${this.id.slice(0, 8)}.log`;
    this.logStream = createWriteStream(this.logFilePath, { flags: 'a' });
    this.logLines.length = 0;
  }

  appendLogLine(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > 2000) {
      this.logLines.shift();
    }
    this.logStream?.write(`${line}\n`);
    broadcast('chat:log', line, this.id);
  }

  isSessionActive(): boolean {
    return this.isProcessing || this.querySession !== null;
  }
}

// SessionManager manages multiple sessions
class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private activeSessionId: string | null = null;
  private agentDir = '';

  setAgentDir(dir: string): void {
    this.agentDir = dir;
  }

  getAgentDir(): string {
    return this.agentDir;
  }

  createSession(): Session {
    const session = new Session();
    this.sessions.set(session.id, session);
    if (!this.activeSessionId) {
      this.activeSessionId = session.id;
    }
    session.createLogStream(this.agentDir);
    console.log(`[session] created id=${session.id}`);
    broadcast('session:created', session.getMetadata());
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getActiveSession(): Session | null {
    if (!this.activeSessionId) {
      return null;
    }
    return this.sessions.get(this.activeSessionId) || null;
  }

  setActiveSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    this.activeSessionId = id;
    console.log(`[session] switched to id=${id}`);
    broadcast('session:switched', { sessionId: id });
    return true;
  }

  deleteSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }

    // Cannot delete running session
    if (session.sessionState === 'running') {
      return false;
    }

    // Clean up
    if (session.logStream) {
      session.logStream.end();
    }

    this.sessions.delete(id);
    console.log(`[session] deleted id=${id}`);
    broadcast('session:deleted', { sessionId: id });

    // If this was the active session, switch to another or create new
    if (this.activeSessionId === id) {
      const remaining = Array.from(this.sessions.values());
      if (remaining.length > 0) {
        this.setActiveSession(remaining[0].id);
      } else {
        this.activeSessionId = null;
      }
    }

    return true;
  }

  listSessions(): SessionMetadata[] {
    return Array.from(this.sessions.values())
      .map((s) => s.getMetadata())
      .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
  }

  getOrCreateActiveSession(): Session {
    let session = this.getActiveSession();
    if (!session) {
      session = this.createSession();
    }
    return session;
  }
}

// Global session manager instance
const sessionManager = new SessionManager();

// Utility functions
function resolveClaudeCodeCli(): string {
  const cliPath = requireModule.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
  if (cliPath.includes('app.asar')) {
    const unpackedPath = cliPath.replace('app.asar', 'app.asar.unpacked');
    if (existsSync(unpackedPath)) {
      return unpackedPath;
    }
  }
  return cliPath;
}

function buildClaudeSessionEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => safeStringify(item));
}

function parseSystemInitInfo(message: unknown): SystemInitInfo | null {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const record = message as Record<string, unknown>;
  if (record.type !== 'system' || record.subtype !== 'init') {
    return null;
  }

  return {
    timestamp: new Date().toISOString(),
    type: asString(record.type),
    subtype: asString(record.subtype),
    cwd: asString(record.cwd),
    session_id: asString(record.session_id),
    tools: asStringArray(record.tools),
    mcp_servers: asStringArray(record.mcp_servers),
    model: asString(record.model),
    permissionMode: asString(record.permissionMode),
    slash_commands: asStringArray(record.slash_commands),
    apiKeySource: asString(record.apiKeySource),
    claude_code_version: asString(record.claude_code_version),
    output_style: asString(record.output_style),
    agents: asStringArray(record.agents),
    skills: asStringArray(record.skills),
    plugins: asStringArray(record.plugins),
    uuid: asString(record.uuid)
  };
}

function formatAssistantContent(content: unknown): string {
  if (!content) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') {
      continue;
    }
    if ('type' in block && block.type === 'text' && 'text' in block) {
      parts.push(String(block.text ?? ''));
      continue;
    }
    if ('type' in block && block.type === 'thinking' && 'thinking' in block) {
      const text = String(block.thinking ?? '').trim();
      if (text) {
        parts.push(`Thinking:\n${text}`);
      }
      continue;
    }
    if ('text' in block && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
}

function extractAgentErrorFromContent(content: unknown): string | null {
  const text = formatAssistantContent(content);
  if (!text) {
    return null;
  }
  if (/api error|authentication_error|unauthorized|forbidden/i.test(text)) {
    return text;
  }
  return null;
}

function extractAgentError(sdkMessage: unknown): string | null {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }
  const candidate = (sdkMessage as { error?: unknown }).error;
  if (candidate) {
    if (typeof candidate === 'string') {
      return candidate;
    }
    try {
      return JSON.stringify(candidate);
    } catch {
      return String(candidate);
    }
  }

  if (
    'type' in sdkMessage &&
    (sdkMessage as { type?: string }).type === 'assistant' &&
    'message' in sdkMessage
  ) {
    const assistantMessage = (sdkMessage as { message?: { content?: unknown } }).message;
    return extractAgentErrorFromContent(assistantMessage?.content);
  }

  return null;
}

// Session-specific streaming handlers
function handleThinkingStart(session: Session, index: number): void {
  const message = session.ensureAssistantMessage();
  const contentArray = session.ensureContentArray(message);
  contentArray.push({
    type: 'thinking',
    thinking: '',
    thinkingStreamIndex: index,
    thinkingStartedAt: Date.now()
  });
}

function handleThinkingChunk(session: Session, index: number, delta: string): void {
  const message = session.ensureAssistantMessage();
  const contentArray = session.ensureContentArray(message);
  const thinkingBlock = contentArray.find(
    (block) => block.type === 'thinking' && block.thinkingStreamIndex === index && !block.isComplete
  );
  if (thinkingBlock && thinkingBlock.type === 'thinking') {
    thinkingBlock.thinking = `${thinkingBlock.thinking ?? ''}${delta}`;
  }
}

function handleToolUseStart(
  session: Session,
  tool: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    streamIndex: number;
  }
): void {
  const message = session.ensureAssistantMessage();
  const contentArray = session.ensureContentArray(message);
  contentArray.push({
    type: 'tool_use',
    tool: {
      ...tool,
      inputJson: ''
    }
  });
}

function handleSubagentToolUseStart(
  session: Session,
  parentToolUseId: string,
  tool: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    streamIndex?: number;
  }
): void {
  const parentTool = session.findToolBlockById(parentToolUseId);
  if (!parentTool) {
    return;
  }
  session.childToolToParent.set(tool.id, parentToolUseId);
  if (!parentTool.tool.subagentCalls) {
    parentTool.tool.subagentCalls = [];
  }
  const existing = parentTool.tool.subagentCalls.find((call) => call.id === tool.id);
  if (existing) {
    existing.name = tool.name;
    existing.input = tool.input;
    existing.streamIndex = tool.streamIndex;
    return;
  }
  parentTool.tool.subagentCalls.push({
    id: tool.id,
    name: tool.name,
    input: tool.input,
    streamIndex: tool.streamIndex,
    inputJson: JSON.stringify(tool.input, null, 2),
    isLoading: true
  });
}

function ensureSubagentToolPlaceholder(
  session: Session,
  parentToolUseId: string,
  toolUseId: string
): void {
  const parentTool = session.findToolBlockById(parentToolUseId);
  if (!parentTool) {
    return;
  }
  if (!parentTool.tool.subagentCalls) {
    parentTool.tool.subagentCalls = [];
  }
  const existing = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (existing) {
    return;
  }
  session.childToolToParent.set(toolUseId, parentToolUseId);
  parentTool.tool.subagentCalls.push({
    id: toolUseId,
    name: 'Tool',
    input: {},
    inputJson: '{}',
    isLoading: true
  });
}

function handleToolInputDelta(
  session: Session,
  index: number,
  toolId: string,
  delta: string
): void {
  const message = session.ensureAssistantMessage();
  const contentArray = session.ensureContentArray(message);
  const toolBlock = contentArray.find(
    (block) => block.type === 'tool_use' && block.tool?.id === toolId
  );
  if (!toolBlock || toolBlock.type !== 'tool_use' || !toolBlock.tool) {
    return;
  }
  const newInputJson = `${toolBlock.tool.inputJson ?? ''}${delta}`;
  toolBlock.tool.inputJson = newInputJson;
  const parsedInput = parsePartialJson<ToolInput>(newInputJson);
  if (parsedInput) {
    toolBlock.tool.parsedInput = parsedInput;
  }
}

function handleSubagentToolInputDelta(
  session: Session,
  parentToolUseId: string,
  toolId: string,
  delta: string
): void {
  const parentTool = session.findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolId);
  if (!subCall) {
    return;
  }
  const newInputJson = `${subCall.inputJson ?? ''}${delta}`;
  subCall.inputJson = newInputJson;
  const parsedInput = parsePartialJson<ToolInput>(newInputJson);
  if (parsedInput) {
    subCall.parsedInput = parsedInput;
  }
}

function finalizeSubagentToolInput(
  session: Session,
  parentToolUseId: string,
  toolId: string
): void {
  const parentTool = session.findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolId);
  if (!subCall?.inputJson) {
    return;
  }
  try {
    subCall.parsedInput = JSON.parse(subCall.inputJson) as ToolInput;
  } catch {
    const parsed = parsePartialJson<ToolInput>(subCall.inputJson);
    if (parsed) {
      subCall.parsedInput = parsed;
    }
  }
}

function handleContentBlockStop(session: Session, index: number, toolId?: string): void {
  const message = session.ensureAssistantMessage();
  const contentArray = session.ensureContentArray(message);
  const thinkingBlock = contentArray.find(
    (block) => block.type === 'thinking' && block.thinkingStreamIndex === index && !block.isComplete
  );
  if (thinkingBlock && thinkingBlock.type === 'thinking') {
    thinkingBlock.isComplete = true;
    thinkingBlock.thinkingDurationMs =
      thinkingBlock.thinkingStartedAt ? Date.now() - thinkingBlock.thinkingStartedAt : undefined;
    return;
  }

  const toolBlock =
    toolId ?
      contentArray.find((block) => block.type === 'tool_use' && block.tool?.id === toolId)
    : contentArray.find((block) => block.type === 'tool_use' && block.tool?.streamIndex === index);

  if (toolBlock && toolBlock.type === 'tool_use' && toolBlock.tool?.inputJson) {
    try {
      toolBlock.tool.parsedInput = JSON.parse(toolBlock.tool.inputJson) as ToolInput;
    } catch {
      const parsed = parsePartialJson<ToolInput>(toolBlock.tool.inputJson);
      if (parsed) {
        toolBlock.tool.parsedInput = parsed;
      }
    }
  }
}

function setToolResult(
  session: Session,
  toolUseId: string,
  content: string,
  isError?: boolean
): void {
  const toolBlock = session.findToolBlockById(toolUseId);
  if (!toolBlock) {
    return;
  }
  toolBlock.tool.result = content;
  if (typeof isError === 'boolean') {
    toolBlock.tool.isError = isError;
  }
}

function getToolResult(session: Session, toolUseId: string): string | undefined {
  const toolBlock = session.findToolBlockById(toolUseId);
  return toolBlock?.tool.result;
}

function appendToolResultContent(
  session: Session,
  toolUseId: string,
  content: string,
  isError?: boolean
): string {
  const existing = getToolResult(session, toolUseId);
  const next = existing ? `${existing}\n${content}` : content;
  setToolResult(session, toolUseId, next, isError);
  return next;
}

function appendToolResultDelta(session: Session, toolUseId: string, delta: string): void {
  if (appendSubagentToolResultDelta(session, toolUseId, delta)) {
    return;
  }
  const toolBlock = session.findToolBlockById(toolUseId);
  if (!toolBlock) {
    return;
  }
  toolBlock.tool.result = `${toolBlock.tool.result ?? ''}${delta}`;
}

function handleToolResultStart(
  session: Session,
  toolUseId: string,
  content: string,
  isError: boolean
): void {
  if (handleSubagentToolResultStart(session, toolUseId, content, isError)) {
    return;
  }
  setToolResult(session, toolUseId, content, isError);
}

function handleToolResultComplete(
  session: Session,
  toolUseId: string,
  content: string,
  isError?: boolean
): void {
  if (handleSubagentToolResultComplete(session, toolUseId, content, isError)) {
    return;
  }
  setToolResult(session, toolUseId, content, isError);
}

function handleSubagentToolResultStart(
  session: Session,
  toolUseId: string,
  content: string,
  isError: boolean
): boolean {
  const parentToolUseId = session.childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return false;
  }
  const parentTool = session.findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return false;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (!subCall) {
    return false;
  }
  subCall.result = content;
  subCall.isError = isError;
  subCall.isLoading = true;
  return true;
}

function handleSubagentToolResultComplete(
  session: Session,
  toolUseId: string,
  content: string,
  isError?: boolean
): boolean {
  const parentToolUseId = session.childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return false;
  }
  const parentTool = session.findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return false;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (!subCall) {
    return false;
  }
  subCall.result = content;
  if (typeof isError === 'boolean') {
    subCall.isError = isError;
  }
  subCall.isLoading = false;
  return true;
}

function appendSubagentToolResultDelta(
  session: Session,
  toolUseId: string,
  delta: string
): boolean {
  const parentToolUseId = session.childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return false;
  }
  const parentTool = session.findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return false;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (!subCall) {
    return false;
  }
  subCall.result = `${subCall.result ?? ''}${delta}`;
  subCall.isLoading = true;
  return true;
}

function finalizeSubagentToolResult(session: Session, toolUseId: string): boolean {
  const parentToolUseId = session.childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return false;
  }
  const parentTool = session.findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return false;
  }
  const subCall = parentTool.tool.subagentCalls.find((call) => call.id === toolUseId);
  if (!subCall) {
    return false;
  }
  subCall.isLoading = false;
  return true;
}

function getSubagentToolResult(session: Session, toolUseId: string): string | undefined {
  const parentToolUseId = session.childToolToParent.get(toolUseId);
  if (!parentToolUseId) {
    return undefined;
  }
  const parentTool = session.findToolBlockById(parentToolUseId);
  if (!parentTool?.tool.subagentCalls) {
    return undefined;
  }
  return parentTool.tool.subagentCalls.find((call) => call.id === toolUseId)?.result;
}

function handleMessageComplete(session: Session): void {
  session.isStreamingMessage = false;
  session.setSessionState('idle');
}

function handleMessageStopped(session: Session): void {
  session.isStreamingMessage = false;
  session.setSessionState('idle');
  const lastMessage = session.messages[session.messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'assistant' || typeof lastMessage.content === 'string') {
    return;
  }
  lastMessage.content = lastMessage.content.map((block) => {
    if (block.type === 'thinking' && !block.isComplete) {
      return {
        ...block,
        isComplete: true,
        thinkingDurationMs:
          block.thinkingStartedAt ? Date.now() - block.thinkingStartedAt : undefined
      };
    }
    return block;
  });
}

function handleMessageError(session: Session, error: string): void {
  session.isStreamingMessage = false;
  session.setSessionState('idle');
  session.messages.push({
    id: String(session.messageSequence++),
    role: 'assistant',
    content: `Error: ${error}`,
    timestamp: new Date().toISOString()
  });
}

// Streaming session logic
async function startStreamingSession(session: Session): Promise<void> {
  if (session.sessionTerminationPromise) {
    await session.sessionTerminationPromise;
  }

  if (session.isProcessing || session.querySession) {
    return;
  }

  const env = buildClaudeSessionEnv();
  const agentDir = sessionManager.getAgentDir();
  console.log(`[agent] start session=${session.id} cwd=${agentDir}`);
  session.shouldAbortSession = false;
  session.isProcessing = true;
  session.streamIndexToToolId.clear();
  session.setSessionState('running');

  let resolveTermination: () => void;
  session.sessionTerminationPromise = new Promise((resolve) => {
    resolveTermination = resolve;
  });

  try {
    session.querySession = query({
      prompt: messageGenerator(session),
      options: {
        maxThinkingTokens: 32_000,
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
        executable: 'bun',
        env,
        stderr: (message: string) => {
          if (process.env.DEBUG === '1') {
            broadcast('chat:debug-message', message, session.id);
          }
        },
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code'
        },
        cwd: agentDir,
        includePartialMessages: true,
        allowDangerouslySkipPermissions: true
      }
    });

    console.log('[agent] session started');
    for await (const sdkMessage of session.querySession) {
      try {
        const line = `${new Date().toISOString()} ${JSON.stringify(sdkMessage)}`;
        console.log('[agent][sdk]', JSON.stringify(sdkMessage));
        session.appendLogLine(line);
      } catch (error) {
        console.log('[agent][sdk] (unserializable)', error);
      }
      const nextSystemInit = parseSystemInitInfo(sdkMessage);
      if (nextSystemInit) {
        session.systemInitInfo = nextSystemInit;
        broadcast('chat:system-init', { info: session.systemInitInfo }, session.id);
      }
      const agentError = extractAgentError(sdkMessage);
      if (agentError) {
        broadcast('chat:agent-error', { message: agentError }, session.id);
      }
      if (session.shouldAbortSession) {
        break;
      }

      if (sdkMessage.type === 'stream_event') {
        const streamEvent = sdkMessage.event;
        if (streamEvent.type === 'content_block_delta') {
          if (streamEvent.delta.type === 'text_delta') {
            if (sdkMessage.parent_tool_use_id) {
              const parentToolUseId =
                session.childToolToParent.get(sdkMessage.parent_tool_use_id) ?? null;
              if (parentToolUseId) {
                broadcast(
                  'chat:subagent-tool-result-delta',
                  {
                    parentToolUseId,
                    toolUseId: sdkMessage.parent_tool_use_id,
                    delta: streamEvent.delta.text
                  },
                  session.id
                );
              } else {
                broadcast(
                  'chat:tool-result-delta',
                  {
                    toolUseId: sdkMessage.parent_tool_use_id,
                    delta: streamEvent.delta.text
                  },
                  session.id
                );
              }
              appendToolResultDelta(session, sdkMessage.parent_tool_use_id, streamEvent.delta.text);
            } else {
              broadcast('chat:message-chunk', streamEvent.delta.text, session.id);
              session.appendTextChunk(streamEvent.delta.text);
            }
          } else if (streamEvent.delta.type === 'thinking_delta') {
            broadcast(
              'chat:thinking-chunk',
              {
                index: streamEvent.index,
                delta: streamEvent.delta.thinking
              },
              session.id
            );
            handleThinkingChunk(session, streamEvent.index, streamEvent.delta.thinking);
          } else if (streamEvent.delta.type === 'input_json_delta') {
            const toolId = session.streamIndexToToolId.get(streamEvent.index) ?? '';
            if (sdkMessage.parent_tool_use_id) {
              broadcast(
                'chat:subagent-tool-input-delta',
                {
                  parentToolUseId: sdkMessage.parent_tool_use_id,
                  toolId,
                  delta: streamEvent.delta.partial_json
                },
                session.id
              );
              handleSubagentToolInputDelta(
                session,
                sdkMessage.parent_tool_use_id,
                toolId,
                streamEvent.delta.partial_json
              );
            } else {
              broadcast(
                'chat:tool-input-delta',
                {
                  index: streamEvent.index,
                  toolId,
                  delta: streamEvent.delta.partial_json
                },
                session.id
              );
              handleToolInputDelta(
                session,
                streamEvent.index,
                toolId,
                streamEvent.delta.partial_json
              );
            }
          }
        } else if (streamEvent.type === 'content_block_start') {
          if (streamEvent.content_block.type === 'thinking') {
            broadcast('chat:thinking-start', { index: streamEvent.index }, session.id);
            handleThinkingStart(session, streamEvent.index);
          } else if (streamEvent.content_block.type === 'tool_use') {
            session.streamIndexToToolId.set(streamEvent.index, streamEvent.content_block.id);
            const toolPayload = {
              id: streamEvent.content_block.id,
              name: streamEvent.content_block.name,
              input: streamEvent.content_block.input || {},
              streamIndex: streamEvent.index
            };
            if (sdkMessage.parent_tool_use_id) {
              broadcast(
                'chat:subagent-tool-use',
                {
                  parentToolUseId: sdkMessage.parent_tool_use_id,
                  tool: toolPayload
                },
                session.id
              );
              handleSubagentToolUseStart(session, sdkMessage.parent_tool_use_id, toolPayload);
            } else {
              broadcast('chat:tool-use-start', toolPayload, session.id);
              handleToolUseStart(session, toolPayload);
            }
          } else if (
            (streamEvent.content_block.type === 'web_search_tool_result' ||
              streamEvent.content_block.type === 'web_fetch_tool_result' ||
              streamEvent.content_block.type === 'code_execution_tool_result' ||
              streamEvent.content_block.type === 'bash_code_execution_tool_result' ||
              streamEvent.content_block.type === 'text_editor_code_execution_tool_result' ||
              streamEvent.content_block.type === 'mcp_tool_result' ||
              streamEvent.content_block.type === 'tool_result') &&
            'tool_use_id' in streamEvent.content_block
          ) {
            const toolResultBlock = streamEvent.content_block as {
              tool_use_id: string;
              content?: string | unknown;
              is_error?: boolean;
            };

            let contentStr = '';
            if (typeof toolResultBlock.content === 'string') {
              contentStr = toolResultBlock.content;
            } else if (toolResultBlock.content !== null && toolResultBlock.content !== undefined) {
              contentStr = JSON.stringify(toolResultBlock.content, null, 2);
            }

            session.toolResultIndexToId.set(streamEvent.index, toolResultBlock.tool_use_id);
            if (contentStr) {
              const parentToolUseId =
                session.childToolToParent.get(toolResultBlock.tool_use_id) ??
                sdkMessage.parent_tool_use_id;
              if (parentToolUseId) {
                if (!session.childToolToParent.has(toolResultBlock.tool_use_id)) {
                  ensureSubagentToolPlaceholder(
                    session,
                    parentToolUseId,
                    toolResultBlock.tool_use_id
                  );
                }
                broadcast(
                  'chat:subagent-tool-result-start',
                  {
                    parentToolUseId,
                    toolUseId: toolResultBlock.tool_use_id,
                    content: contentStr,
                    isError: toolResultBlock.is_error || false
                  },
                  session.id
                );
              } else {
                broadcast(
                  'chat:tool-result-start',
                  {
                    toolUseId: toolResultBlock.tool_use_id,
                    content: contentStr,
                    isError: toolResultBlock.is_error || false
                  },
                  session.id
                );
              }
              handleToolResultStart(
                session,
                toolResultBlock.tool_use_id,
                contentStr,
                toolResultBlock.is_error || false
              );
            }
          }
        } else if (streamEvent.type === 'content_block_stop') {
          const toolId = session.streamIndexToToolId.get(streamEvent.index);
          if (sdkMessage.parent_tool_use_id) {
            if (toolId) {
              finalizeSubagentToolInput(session, sdkMessage.parent_tool_use_id, toolId);
            }
            const toolResultId = session.toolResultIndexToId.get(streamEvent.index);
            if (toolResultId) {
              session.toolResultIndexToId.delete(streamEvent.index);
              if (finalizeSubagentToolResult(session, toolResultId)) {
                const result = getSubagentToolResult(session, toolResultId) ?? '';
                const parentToolUseId = session.childToolToParent.get(toolResultId);
                if (parentToolUseId) {
                  broadcast(
                    'chat:subagent-tool-result-complete',
                    {
                      parentToolUseId,
                      toolUseId: toolResultId,
                      content: result
                    },
                    session.id
                  );
                }
              }
            }
          } else {
            broadcast(
              'chat:content-block-stop',
              {
                index: streamEvent.index,
                toolId: toolId || undefined
              },
              session.id
            );
            handleContentBlockStop(session, streamEvent.index, toolId || undefined);
          }
        }
      } else if (sdkMessage.type === 'user') {
        if (sdkMessage.parent_tool_use_id && sdkMessage.message?.content) {
          for (const block of sdkMessage.message.content) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'tool_result' &&
              'tool_use_id' in block
            ) {
              const toolResultBlock = block as {
                tool_use_id: string;
                content: string | unknown;
              };
              const contentStr =
                typeof toolResultBlock.content === 'string' ?
                  toolResultBlock.content
                : JSON.stringify(toolResultBlock.content ?? '', null, 2);
              const parentToolUseId =
                session.childToolToParent.get(toolResultBlock.tool_use_id) ??
                sdkMessage.parent_tool_use_id;
              if (parentToolUseId) {
                if (!session.childToolToParent.has(toolResultBlock.tool_use_id)) {
                  ensureSubagentToolPlaceholder(
                    session,
                    parentToolUseId,
                    toolResultBlock.tool_use_id
                  );
                }
                broadcast(
                  'chat:subagent-tool-result-complete',
                  {
                    parentToolUseId,
                    toolUseId: toolResultBlock.tool_use_id,
                    content: contentStr
                  },
                  session.id
                );
              } else {
                broadcast(
                  'chat:tool-result-complete',
                  {
                    toolUseId: toolResultBlock.tool_use_id,
                    content: contentStr
                  },
                  session.id
                );
              }
              handleToolResultComplete(session, toolResultBlock.tool_use_id, contentStr);
            }
          }
        }
      } else if (sdkMessage.type === 'assistant') {
        const assistantMessage = sdkMessage.message;
        if (sdkMessage.parent_tool_use_id && assistantMessage.content) {
          for (const block of assistantMessage.content) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'tool_use' &&
              'id' in block &&
              'name' in block
            ) {
              const toolBlock = block as {
                id: string;
                name: string;
                input?: Record<string, unknown>;
              };
              const payload = {
                id: toolBlock.id,
                name: toolBlock.name,
                input: toolBlock.input || {}
              };
              broadcast(
                'chat:subagent-tool-use',
                {
                  parentToolUseId: sdkMessage.parent_tool_use_id,
                  tool: payload
                },
                session.id
              );
              handleSubagentToolUseStart(session, sdkMessage.parent_tool_use_id, payload);
            }
          }
        }
        if (sdkMessage.parent_tool_use_id) {
          const text = formatAssistantContent(assistantMessage.content);
          if (text) {
            const next = appendToolResultContent(session, sdkMessage.parent_tool_use_id, text);
            broadcast(
              'chat:tool-result-complete',
              {
                toolUseId: sdkMessage.parent_tool_use_id,
                content: next
              },
              session.id
            );
          }
        }
        if (assistantMessage.content) {
          for (const block of assistantMessage.content) {
            if (
              typeof block === 'object' &&
              block !== null &&
              'tool_use_id' in block &&
              'content' in block
            ) {
              const toolResultBlock = block as {
                tool_use_id: string;
                content: string | unknown[] | unknown;
                is_error?: boolean;
              };

              let contentStr: string;
              if (typeof toolResultBlock.content === 'string') {
                contentStr = toolResultBlock.content;
              } else if (Array.isArray(toolResultBlock.content)) {
                contentStr = toolResultBlock.content
                  .map((c) => {
                    if (typeof c === 'string') {
                      return c;
                    }
                    if (typeof c === 'object' && c !== null) {
                      if ('text' in c && typeof c.text === 'string') {
                        return c.text;
                      }
                      if ('type' in c && c.type === 'text' && 'text' in c) {
                        return String(c.text);
                      }
                      return JSON.stringify(c, null, 2);
                    }
                    return String(c);
                  })
                  .join('\n');
              } else if (typeof toolResultBlock.content === 'object' && toolResultBlock.content) {
                contentStr = JSON.stringify(toolResultBlock.content, null, 2);
              } else {
                contentStr = String(toolResultBlock.content);
              }

              const parentToolUseId =
                session.childToolToParent.get(toolResultBlock.tool_use_id) ??
                sdkMessage.parent_tool_use_id;
              if (parentToolUseId) {
                if (!session.childToolToParent.has(toolResultBlock.tool_use_id)) {
                  ensureSubagentToolPlaceholder(
                    session,
                    parentToolUseId,
                    toolResultBlock.tool_use_id
                  );
                }
                broadcast(
                  'chat:subagent-tool-result-complete',
                  {
                    parentToolUseId,
                    toolUseId: toolResultBlock.tool_use_id,
                    content: contentStr,
                    isError: toolResultBlock.is_error || false
                  },
                  session.id
                );
              } else {
                broadcast(
                  'chat:tool-result-complete',
                  {
                    toolUseId: toolResultBlock.tool_use_id,
                    content: contentStr,
                    isError: toolResultBlock.is_error || false
                  },
                  session.id
                );
              }
              handleToolResultComplete(
                session,
                toolResultBlock.tool_use_id,
                contentStr,
                toolResultBlock.is_error || false
              );
            }
          }
        }
      } else if (sdkMessage.type === 'result') {
        broadcast('chat:message-complete', null, session.id);
        handleMessageComplete(session);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    console.error('[agent] session error', errorMessage);
    broadcast('chat:message-error', errorMessage, session.id);
    handleMessageError(session, errorMessage);
    session.setSessionState('error');
  } finally {
    session.isProcessing = false;
    session.querySession = null;
    if (session.sessionState !== 'error') {
      session.setSessionState('idle');
    }
    resolveTermination!();
  }
}

async function* messageGenerator(session: Session): AsyncGenerator<SDKUserMessage> {
  while (true) {
    if (session.shouldAbortSession) {
      return;
    }

    await new Promise<void>((resolve) => {
      const checkQueue = () => {
        if (session.shouldAbortSession) {
          resolve();
          return;
        }

        if (session.messageQueue.length > 0) {
          resolve();
        } else {
          setTimeout(checkQueue, 100);
        }
      };
      checkQueue();
    });

    if (session.shouldAbortSession) {
      return;
    }

    const item = session.messageQueue.shift();
    if (item) {
      yield {
        type: 'user' as const,
        message: item.message,
        parent_tool_use_id: null,
        session_id: session.id
      };
      item.resolve();
    }
  }
}

// Public API functions
export function getAgentState(sessionId?: string): {
  agentDir: string;
  sessionState: SessionState;
  hasInitialPrompt: boolean;
  sessionId: string;
} {
  const session =
    sessionId ? sessionManager.getSession(sessionId) : sessionManager.getActiveSession();
  if (!session) {
    return {
      agentDir: sessionManager.getAgentDir(),
      sessionState: 'idle',
      hasInitialPrompt: false,
      sessionId: ''
    };
  }
  return {
    agentDir: sessionManager.getAgentDir(),
    sessionState: session.sessionState,
    hasInitialPrompt: session.messages.length > 0,
    sessionId: session.id
  };
}

export function getSystemInitInfo(sessionId?: string): SystemInitInfo | null {
  const session =
    sessionId ? sessionManager.getSession(sessionId) : sessionManager.getActiveSession();
  return session?.systemInitInfo || null;
}

export function getLogLines(sessionId?: string): string[] {
  const session =
    sessionId ? sessionManager.getSession(sessionId) : sessionManager.getActiveSession();
  return session?.logLines || [];
}

export function getMessages(sessionId?: string): MessageWire[] {
  const session =
    sessionId ? sessionManager.getSession(sessionId) : sessionManager.getActiveSession();
  return session?.messages || [];
}

export function initializeAgent(nextAgentDir: string, initialPrompt?: string | null): void {
  sessionManager.setAgentDir(nextAgentDir);
  console.log(`[agent] init dir=${nextAgentDir} initialPrompt=${initialPrompt ? 'yes' : 'no'}`);

  // Create initial session
  const session = sessionManager.createSession();
  if (initialPrompt && initialPrompt.trim()) {
    void enqueueUserMessage(initialPrompt.trim(), session.id);
  }
}

export async function enqueueUserMessage(text: string, sessionId?: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  let session: Session;
  if (sessionId) {
    const found = sessionManager.getSession(sessionId);
    if (!found) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    session = found;
  } else {
    session = sessionManager.getOrCreateActiveSession();
  }

  console.log(`[agent] enqueue message session=${session.id} len=${trimmed.length}`);
  session.lastMessageAt = new Date();
  session.setSessionState('running');

  const userMessage: MessageWire = {
    id: String(session.messageSequence++),
    role: 'user',
    content: trimmed,
    timestamp: new Date().toISOString()
  };
  session.messages.push(userMessage);
  broadcast('chat:message-replay', { message: userMessage }, session.id);

  // Auto-generate session name from first message
  session.updateNameFromFirstMessage();
  if (session.messages.length === 1) {
    broadcast('session:updated', session.getMetadata());
  }

  if (!session.isSessionActive()) {
    console.log('[agent] starting session (idle -> running)');
    startStreamingSession(session).catch((error) => {
      console.error('[agent] failed to start session', error);
    });
  }

  await new Promise<void>((resolve) => {
    session.messageQueue.push({
      message: {
        role: 'user',
        content: [{ type: 'text', text: trimmed }]
      },
      resolve
    });
  });
}

export async function interruptCurrentResponse(sessionId?: string): Promise<boolean> {
  const session =
    sessionId ? sessionManager.getSession(sessionId) : sessionManager.getActiveSession();
  if (!session || !session.querySession) {
    return false;
  }

  if (session.isInterruptingResponse) {
    return true;
  }

  session.isInterruptingResponse = true;
  try {
    await session.querySession.interrupt();
    broadcast('chat:message-stopped', null, session.id);
    handleMessageStopped(session);
    return true;
  } finally {
    session.isInterruptingResponse = false;
  }
}

export function isSessionActive(sessionId?: string): boolean {
  const session =
    sessionId ? sessionManager.getSession(sessionId) : sessionManager.getActiveSession();
  return session?.isSessionActive() || false;
}

// Session management functions
export function createSession(): SessionMetadata {
  const session = sessionManager.createSession();
  return session.getMetadata();
}

export function deleteSession(sessionId: string): boolean {
  return sessionManager.deleteSession(sessionId);
}

export function switchSession(sessionId: string): boolean {
  return sessionManager.setActiveSession(sessionId);
}

export function listSessions(): SessionMetadata[] {
  return sessionManager.listSessions();
}

export function getActiveSessionId(): string | null {
  const session = sessionManager.getActiveSession();
  return session?.id || null;
}
