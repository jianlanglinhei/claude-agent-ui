import { useEffect } from 'react';

import { connectSse } from '@/api/sseClient';
import { useAgentState } from '@/hooks/useAgentState';
import Chat from '@/pages/Chat';

export default function App() {
  const { agentDir, sessionState } = useAgentState();

  useEffect(() => {
    connectSse();
  }, []);

  return <Chat agentDir={agentDir} sessionState={sessionState} />;
}
