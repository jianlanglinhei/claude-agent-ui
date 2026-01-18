import { useEffect, useState } from 'react';

import { chatClient } from '@/api/chatClient';

import type { Session } from '../../shared/types/ipc';

export function useSessionManager() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Load sessions on mount
  useEffect(() => {
    void loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for session events
  useEffect(() => {
    const unsubscribeCreated = chatClient.onSessionCreated((session) => {
      setSessions((prev) => [session, ...prev]);
      if (!activeSessionId) {
        setActiveSessionId(session.id);
      }
    });

    const unsubscribeDeleted = chatClient.onSessionDeleted((data) => {
      setSessions((prev) => prev.filter((s) => s.id !== data.sessionId));
      if (activeSessionId === data.sessionId) {
        setActiveSessionId(null);
      }
    });

    const unsubscribeSwitched = chatClient.onSessionSwitched((data) => {
      setActiveSessionId(data.sessionId);
    });

    const unsubscribeUpdated = chatClient.onSessionUpdated((session) => {
      setSessions((prev) => prev.map((s) => (s.id === session.id ? session : s)));
    });

    return () => {
      unsubscribeCreated();
      unsubscribeDeleted();
      unsubscribeSwitched();
      unsubscribeUpdated();
    };
  }, [activeSessionId]);

  const loadSessions = async () => {
    try {
      const loadedSessions = await chatClient.listSessions();
      setSessions(loadedSessions);
      // Set first session as active if none is set
      if (loadedSessions.length > 0 && !activeSessionId) {
        setActiveSessionId(loadedSessions[0].id);
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  };

  const createSession = async () => {
    if (isLoading) return;
    setIsLoading(true);
    try {
      const session = await chatClient.createSession();
      // SSE event will update the state
      await switchSession(session.id);
    } catch (error) {
      console.error('Failed to create session:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const deleteSession = async (sessionId: string) => {
    if (isLoading) return;
    setIsLoading(true);
    try {
      await chatClient.deleteSession(sessionId);
      // SSE event will update the state
    } catch (error) {
      console.error('Failed to delete session:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const switchSession = async (sessionId: string) => {
    if (isLoading || sessionId === activeSessionId) return;
    setIsLoading(true);
    try {
      await chatClient.switchSession(sessionId);
      // SSE event will update the state
    } catch (error) {
      console.error('Failed to switch session:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return {
    sessions,
    activeSessionId,
    isLoading,
    createSession,
    deleteSession,
    switchSession,
    loadSessions
  };
}
