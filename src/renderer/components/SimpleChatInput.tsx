import { ArrowUp } from 'lucide-react';
import { useEffect, useRef } from 'react';

interface SimpleChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  isLoading: boolean;
}

export default function SimpleChatInput({
  value,
  onChange,
  onSend,
  isLoading
}: SimpleChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!isLoading && value.trim()) {
        onSend();
      }
    }
  };

  return (
    <div className="border-t border-[var(--line)] bg-[var(--paper-strong)]/70 px-6 py-4 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-end gap-3 rounded-2xl border border-[var(--line)] bg-[var(--paper-strong)] px-4 py-3 shadow-[var(--shadow-soft)]">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder="输入bug，解决 bug"
          className="min-h-[44px] w-full resize-none bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={isLoading || !value.trim()}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--ink)] text-[var(--paper-strong)] transition-colors hover:bg-[var(--accent)] disabled:bg-[var(--ink-muted)] disabled:cursor-not-allowed"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
