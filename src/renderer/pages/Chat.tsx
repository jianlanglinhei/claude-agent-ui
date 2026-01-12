import { useState } from 'react';

import { chatClient } from '@/api/chatClient';
import DirectoryPanel from '@/components/DirectoryPanel';
import MessageList from '@/components/MessageList';
import SimpleChatInput from '@/components/SimpleChatInput';
import { useAgentLogs } from '@/hooks/useAgentLogs';
import { useAutoScroll } from '@/hooks/useAutoScroll';
import { useClaudeChat } from '@/hooks/useClaudeChat';

interface ChatProps {
  agentDir: string;
  sessionState: 'idle' | 'running' | 'error';
}

export default function Chat({ agentDir, sessionState }: ChatProps) {
  const [inputValue, setInputValue] = useState('');
  const [showLogs, setShowLogs] = useState(false);
  const { messages, setMessages, isLoading, setIsLoading } = useClaudeChat();
  const logs = useAgentLogs();
  const messagesContainerRef = useAutoScroll(isLoading, messages);

  const handleSendMessage = async () => {
    const trimmedMessage = inputValue.trim();
    if (!trimmedMessage || isLoading || sessionState === 'running') {
      return;
    }
    setInputValue('');
    setIsLoading(true);

    try {
      const response = await chatClient.sendMessage({ text: trimmedMessage });
      if (!response.success && response.error) {
        const errorMessage = {
          id: (Date.now() + 1).toString(),
          role: 'assistant' as const,
          content: `Error: ${response.error}`,
          timestamp: new Date()
        };
        setMessages((prev) => [...prev, errorMessage]);
        setIsLoading(false);
      }
    } catch (error) {
      const errorMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant' as const,
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
        timestamp: new Date()
      };
      setMessages((prev) => [...prev, errorMessage]);
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-screen bg-white text-neutral-900">
      <div className="flex w-3/4 flex-col border-r border-neutral-200">
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <div className="text-sm font-semibold text-neutral-700">Agent</div>
            <div className="text-xs text-neutral-500">Status: {sessionState}</div>
          </div>
          <div className="flex items-center gap-3 text-xs text-neutral-400">
            <button
              type="button"
              onClick={() => setShowLogs((prev) => !prev)}
              className="rounded border border-neutral-200 px-2 py-1 text-[11px] font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-800"
            >
              {showLogs ? 'Hide logs' : 'Logs'}
            </button>
            <span>Single session</span>
          </div>
        </div>

        <div className="flex flex-1 flex-col overflow-hidden">
          {showLogs && (
            <div className="border-b border-neutral-200 bg-neutral-50 px-4 py-3">
              <div className="mb-2 text-xs font-semibold text-neutral-600">Agent SDK Logs</div>
              <div className="max-h-52 overflow-y-auto rounded border border-neutral-200 bg-white p-2 font-mono text-[11px] leading-relaxed text-neutral-700">
                {logs.length === 0 ?
                  <div className="text-neutral-400">No logs yet.</div>
                : logs.map((line, index) => (
                    <div key={`${index}-${line.slice(0, 12)}`} className="whitespace-pre-wrap">
                      {line}
                    </div>
                  ))
                }
              </div>
            </div>
          )}
          <MessageList
            messages={messages}
            isLoading={isLoading}
            containerRef={messagesContainerRef}
            bottomPadding={120}
          />
          <SimpleChatInput
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSendMessage}
            isLoading={isLoading || sessionState === 'running'}
          />
        </div>
      </div>

      <div className="flex w-1/4 flex-col">
        <DirectoryPanel agentDir={agentDir} />
      </div>
    </div>
  );
}
