import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { MessageSquare, Plus, Trash2 } from 'lucide-react';

import type { Session } from '../../shared/types/ipc';

interface SessionListProps {
  sessions: Session[];
  activeSessionId: string | null;
  onCreateSession: () => void;
  onSwitchSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  isLoading: boolean;
}

export default function SessionList({
  sessions,
  activeSessionId,
  onCreateSession,
  onSwitchSession,
  onDeleteSession,
  isLoading
}: SessionListProps) {
  const formatTime = (timestamp: string) => {
    try {
      return formatDistanceToNow(new Date(timestamp), { addSuffix: true, locale: zhCN });
    } catch {
      return timestamp;
    }
  };

  const getStateLabel = (state: Session['state']) => {
    switch (state) {
      case 'running':
        return '运行中';
      case 'error':
        return '错误';
      default:
        return '';
    }
  };

  const getStateColor = (state: Session['state']) => {
    switch (state) {
      case 'running':
        return 'bg-blue-500/20 text-blue-700 border-blue-500/30';
      case 'error':
        return 'bg-red-500/20 text-red-700 border-red-500/30';
      default:
        return '';
    }
  };

  return (
    <div className="flex h-full w-[280px] flex-col border-r border-[var(--line)] bg-white">
      {/* Fixed Header */}
      <div className="flex-shrink-0 border-b border-[var(--line)] px-4 py-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-[0.3em] text-[var(--ink-muted)] uppercase">
            AUTOFIX
          </h2>
        </div>
        <button
          type="button"
          onClick={onCreateSession}
          disabled={isLoading}
          className="action-button flex w-full items-center justify-center gap-2 bg-[var(--ink)] px-4 py-2 text-xs font-semibold text-[var(--paper-strong)] hover:bg-[var(--accent)] disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          新建会话
        </button>
      </div>

      {/* Scrollable Session List */}
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ?
          <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
            <MessageSquare className="mb-2 h-8 w-8 text-[var(--ink-muted)]/50" />
            <p className="text-xs text-[var(--ink-muted)]">暂无会话</p>
            <p className="mt-1 text-[10px] text-[var(--ink-muted)]/70">点击上方按钮创建新会话</p>
          </div>
        : <div className="space-y-1 p-2">
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const canDelete = session.state !== 'running';

              return (
                <div
                  key={session.id}
                  className={`group relative cursor-pointer rounded-lg border p-3 transition-all ${
                    isActive ?
                      'border-[var(--accent)] bg-[var(--accent)]/5'
                    : 'border-transparent bg-[var(--paper-contrast)]/30 hover:bg-[var(--paper-contrast)]/60'
                  }`}
                  onClick={() => onSwitchSession(session.id)}
                >
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-[var(--ink)]">
                        {session.name}
                      </div>
                      <div className="mt-1 text-[10px] text-[var(--ink-muted)]">
                        {formatTime(session.lastMessageAt)}
                      </div>
                    </div>
                    {canDelete && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteSession(session.id);
                        }}
                        className="opacity-0 transition-opacity group-hover:opacity-100"
                        title="删除会话"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-[var(--ink-muted)] hover:text-red-600" />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="text-[10px] text-[var(--ink-muted)]">
                      {session.messageCount} 条消息
                    </div>
                    {session.state !== 'idle' && (
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[9px] font-medium ${getStateColor(session.state)}`}
                      >
                        {getStateLabel(session.state)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        }
      </div>
    </div>
  );
}
