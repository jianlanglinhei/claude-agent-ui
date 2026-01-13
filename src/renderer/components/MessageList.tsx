import { Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import type { CSSProperties, RefObject } from 'react';

import Message from '@/components/Message';
import { getRandomSuggestion } from '@/constants/chatSuggestions';
import type { Message as MessageType } from '@/types/chat';

interface MessageListProps {
  messages: MessageType[];
  isLoading: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  bottomPadding?: number;
}

const containerClasses = 'flex-1 overflow-y-auto px-3 py-3';

export default function MessageList({
  messages,
  isLoading,
  containerRef,
  bottomPadding
}: MessageListProps) {
  const containerStyle: CSSProperties | undefined =
    bottomPadding ? { paddingBottom: bottomPadding } : undefined;

  // Get a random suggestion when there are no messages
  // This will change each time messages.length changes (including when it becomes 0)
  const suggestion = useMemo(() => {
    if (messages.length === 0) {
      return getRandomSuggestion();
    }
    return '';
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div
        ref={containerRef}
        className={`relative flex ${containerClasses}`}
        style={containerStyle}
      >
        <div className="mx-auto flex w-full max-w-2xl flex-1 items-center justify-center px-4">
          <div className="soft-panel w-full px-6 py-8 text-center">
            <p className="text-[10px] font-semibold tracking-[0.45em] text-[var(--ink-muted)] uppercase">
              Agent UI
            </p>
            <h2 className="font-display mt-3 text-2xl text-[var(--ink)]">{suggestion}</h2>
            <p className="mt-3 text-sm text-[var(--ink-muted)]">
              Try asking for a plan, a refactor, or a quick diagnosis.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`relative ${containerClasses}`} style={containerStyle}>
      <div className="mx-auto max-w-3xl space-y-2">
        {messages.map((message, index) => (
          <Message
            key={message.id}
            message={message}
            isLoading={isLoading && index === messages.length - 1}
          />
        ))}
        {isLoading && (
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--ink-muted)]">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Streaming response...</span>
          </div>
        )}
      </div>
    </div>
  );
}
