import { useCallback, useEffect, useState } from 'react';
import type { ProjectDto } from '@/api/types';
import type { CodeSelection } from '@/lib/chatPromptXml';
import { useSignalRConnection } from '@/hooks/useSignalRConnection';
import { useSessionManager, type Session } from '@/hooks/useSessionManager';
import { SessionPanel } from '@/components/session/SessionPanel';
import { RunningSessionsIndicator } from '@/components/session/RunningSessionsIndicator';
import { ProjectChat } from './ProjectChat';
import { Button } from '@/components/ui/button';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

export interface SessionAwareProjectChatProps {
  project: ProjectDto;
  detailsOpen: boolean;
  detailsPortalTarget: HTMLDivElement | null;
  activeFilePath?: string | null;
  codeSelection?: CodeSelection | null;
  onClearCodeSelection?: () => void;
  onToolOutput?: (chunk: string) => void;
  currentToolType?: 'Codex' | 'ClaudeCode' | null;
  showSessionPanel?: boolean;
}

export function SessionAwareProjectChat({
  project,
  detailsOpen,
  detailsPortalTarget,
  activeFilePath,
  codeSelection,
  onClearCodeSelection,
  onToolOutput,
  currentToolType,
  showSessionPanel = false,
}: SessionAwareProjectChatProps) {
  const [sessionPanelOpen, setSessionPanelOpen] = useState(showSessionPanel);

  // Session management
  const {
    sessions,
    runningSessions,
    currentSession,
    isLoading: sessionsLoading,
    loadRunningSessions,
    createSession,
    deleteSession,
    updateSessionTitle,
    switchSession,
    setCurrentSession,
  } = useSessionManager({ projectId: project.id, autoLoad: true });

  // SignalR connection
  const {
    connectionState,
    joinSession,
    leaveSession,
    currentSessionId,
  } = useSignalRConnection({
    hubUrl: '/api/chat',
    autoConnect: true,
    maxRetries: 5,
    onMessage: (message) => {
      console.log('[SignalR] Received message:', message);
      // Messages are handled by the existing SSE mechanism in ProjectChat
      // SignalR is used as an additional channel for real-time updates
    },
    onStatusUpdate: (status) => {
      console.log('[SignalR] Status update:', status);
      // Refresh running sessions when status changes
      loadRunningSessions();
    },
  });

  // Join session when current session changes
  useEffect(() => {
    if (currentSession && connectionState === 'connected') {
      joinSession(currentSession.id).catch(console.error);
    }
  }, [currentSession?.id, connectionState, joinSession]);

  // Refresh running sessions periodically
  useEffect(() => {
    const interval = setInterval(() => {
      loadRunningSessions();
    }, 10000); // Every 10 seconds

    return () => clearInterval(interval);
  }, [loadRunningSessions]);

  // Handle session click
  const handleSessionClick = useCallback(async (session: Session) => {
    try {
      await switchSession(session.id);
      setCurrentSession(session);
      
      // Leave current session and join new one
      if (currentSessionId && currentSessionId !== session.id) {
        await leaveSession(currentSessionId);
      }
      await joinSession(session.id);
    } catch (error) {
      console.error('Failed to switch session:', error);
    }
  }, [switchSession, setCurrentSession, currentSessionId, leaveSession, joinSession]);

  // Handle create session
  const handleCreateSession = useCallback(async (title?: string) => {
    try {
      const session = await createSession(title);
      await joinSession(session.id);
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  }, [createSession, joinSession]);

  // Handle delete session
  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await deleteSession(sessionId);
      if (currentSessionId === sessionId) {
        await leaveSession(sessionId);
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  }, [deleteSession, currentSessionId, leaveSession]);

  // Handle rename session
  const handleRenameSession = useCallback(async (sessionId: string, newTitle: string) => {
    try {
      await updateSessionTitle(sessionId, newTitle);
    } catch (error) {
      console.error('Failed to rename session:', error);
    }
  }, [updateSessionTitle]);

  // Handle first message - update session title
  const handleFirstMessage = useCallback(async (text: string) => {
    if (currentSession?.id) {
      try {
        await updateSessionTitle(currentSession.id, text);
      } catch (error) {
        console.error('Failed to update session title:', error);
      }
    }
  }, [currentSession?.id, updateSessionTitle]);

  // Toggle session panel
  const toggleSessionPanel = useCallback(() => {
    setSessionPanelOpen(prev => !prev);
  }, []);

  return (
    <div className="flex h-full w-full bg-background relative overflow-hidden selection:bg-primary/10">
      {/* Session Panel (Sidebar) - Minimalist ChatGPT style */}
      <div 
        className={`
          flex-shrink-0 bg-muted/5 border-r border-border/40 h-full transition-all duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]
          ${sessionPanelOpen ? 'w-[260px] opacity-100 translate-x-0' : 'w-0 opacity-0 -translate-x-8 overflow-hidden border-none'}
        `}
      >
        <div className="w-[260px] h-full flex flex-col">
          <SessionPanel
            sessions={sessions}
            runningSessions={runningSessions}
            currentSessionId={currentSession?.id}
            isLoading={sessionsLoading}
            onSessionClick={handleSessionClick}
            onCreateSession={handleCreateSession}
            onDeleteSession={handleDeleteSession}
            onRenameSession={handleRenameSession}
          />
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0 h-full relative group/chat">
        {/* Floating Toggle & Context - Minimalist integration */}
        <div className="absolute top-4 left-4 z-40 flex items-center gap-3 pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-1.5 bg-background/50 backdrop-blur-md p-1.5 rounded-xl border border-border/30 shadow-sm transition-all hover:shadow-md opacity-0 group-hover/chat:opacity-100 focus-within:opacity-100">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleSessionPanel}
              className="size-8 text-muted-foreground hover:text-foreground rounded-lg"
              title={sessionPanelOpen ? '关闭侧边栏' : '打开侧边栏'}
            >
              {sessionPanelOpen ? (
                <PanelLeftClose className="size-4.5" />
              ) : (
                <PanelLeftOpen className="size-4.5" />
              )}
            </Button>
            
            {/* Contextual Info (Collapsed Mode) */}
            {(!sessionPanelOpen || runningSessions.length > 0) && (
              <div className="flex items-center gap-2 border-l border-border/40 pl-2 ml-1">
                {runningSessions.length > 0 && !sessionPanelOpen && (
                  <RunningSessionsIndicator
                    runningSessions={runningSessions}
                    onSessionClick={handleSessionClick}
                  />
                )}
                
                {currentSession && !sessionPanelOpen && (
                  <span className="text-xs font-medium text-foreground/70 truncate max-w-[120px] animate-in fade-in slide-in-from-left-2">
                    {currentSession.title || '新会话'}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Project Chat - Occupies full height and width */}
        <div className="flex-1 min-h-0 w-full relative">
          <ProjectChat
            project={project}
            detailsOpen={detailsOpen}
            detailsPortalTarget={detailsPortalTarget}
            activeFilePath={activeFilePath}
            codeSelection={codeSelection}
            onClearCodeSelection={onClearCodeSelection}
            onToolOutput={onToolOutput}
            currentToolType={currentToolType}
            sessionId={currentSession?.id}
            onFirstMessage={handleFirstMessage}
          />
        </div>
      </div>
    </div>
  );
}
