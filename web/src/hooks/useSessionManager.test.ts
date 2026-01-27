import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSessionManager } from './useSessionManager';

// Mock the API client
vi.mock('@/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { apiClient } from '@/api/client';

const mockApiClient = apiClient as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

describe('useSessionManager', () => {
  const mockProjectId = '123e4567-e89b-12d3-a456-426614174000';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with empty state', () => {
    const { result } = renderHook(() => useSessionManager());

    expect(result.current.sessions).toEqual([]);
    expect(result.current.runningSessions).toEqual([]);
    expect(result.current.currentSession).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should load sessions when autoLoad is true', async () => {
    const mockSessions = [
      { id: '1', projectId: mockProjectId, title: 'Session 1', state: 'IDLE' as const, messageCount: 0, createdAtUtc: '', updatedAtUtc: '' },
      { id: '2', projectId: mockProjectId, title: 'Session 2', state: 'COMPLETED' as const, messageCount: 5, createdAtUtc: '', updatedAtUtc: '' },
    ];

    mockApiClient.get.mockResolvedValueOnce({ sessions: mockSessions });
    mockApiClient.get.mockResolvedValueOnce({ sessions: [] });

    const { result } = renderHook(() =>
      useSessionManager({ projectId: mockProjectId, autoLoad: true })
    );

    await waitFor(() => {
      expect(result.current.sessions).toEqual(mockSessions);
    });

    expect(mockApiClient.get).toHaveBeenCalledWith(`/api/projects/${mockProjectId}/managed-sessions`);
  });

  it('should create a new session', async () => {
    const newSession = {
      id: 'new-id',
      projectId: mockProjectId,
      title: 'New Session',
      state: 'IDLE' as const,
      messageCount: 0,
      createdAtUtc: '',
      updatedAtUtc: '',
    };

    mockApiClient.post.mockResolvedValueOnce(newSession);

    const { result } = renderHook(() =>
      useSessionManager({ projectId: mockProjectId })
    );

    let createdSession;
    await act(async () => {
      createdSession = await result.current.createSession('New Session');
    });

    expect(createdSession).toEqual(newSession);
    expect(result.current.sessions).toContainEqual(newSession);
    expect(result.current.currentSession).toEqual(newSession);
    expect(mockApiClient.post).toHaveBeenCalledWith('/api/sessions', {
      projectId: mockProjectId,
      title: 'New Session',
    });
  });

  it('should delete a session', async () => {
    const sessionId = 'session-to-delete';
    const initialSessions = [
      { id: sessionId, projectId: mockProjectId, title: 'To Delete', state: 'IDLE' as const, messageCount: 0, createdAtUtc: '', updatedAtUtc: '' },
      { id: 'other', projectId: mockProjectId, title: 'Other', state: 'IDLE' as const, messageCount: 0, createdAtUtc: '', updatedAtUtc: '' },
    ];

    mockApiClient.get.mockResolvedValueOnce({ sessions: initialSessions });
    mockApiClient.get.mockResolvedValueOnce({ sessions: [] });
    mockApiClient.delete.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() =>
      useSessionManager({ projectId: mockProjectId, autoLoad: true })
    );

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });

    await act(async () => {
      await result.current.deleteSession(sessionId);
    });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].id).toBe('other');
    expect(mockApiClient.delete).toHaveBeenCalledWith(`/api/sessions/${sessionId}`);
  });

  it('should switch current session', async () => {
    const sessions = [
      { id: '1', projectId: mockProjectId, title: 'Session 1', state: 'IDLE' as const, messageCount: 0, createdAtUtc: '', updatedAtUtc: '' },
      { id: '2', projectId: mockProjectId, title: 'Session 2', state: 'IDLE' as const, messageCount: 0, createdAtUtc: '', updatedAtUtc: '' },
    ];

    mockApiClient.get.mockResolvedValueOnce({ sessions });
    mockApiClient.get.mockResolvedValueOnce({ sessions: [] });
    mockApiClient.put.mockResolvedValueOnce({ success: true, currentSessionId: '2' });

    const { result } = renderHook(() =>
      useSessionManager({ projectId: mockProjectId, autoLoad: true })
    );

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });

    await act(async () => {
      await result.current.switchSession('2');
    });

    expect(result.current.currentSession?.id).toBe('2');
    expect(mockApiClient.put).toHaveBeenCalledWith(
      `/api/projects/${mockProjectId}/current-session`,
      { sessionId: '2' }
    );
  });

  it('should load messages for a session', async () => {
    const mockMessages = [
      { id: 'm1', role: 'user' as const, content: 'Hello', messageType: 'text' as const, createdAtUtc: '' },
      { id: 'm2', role: 'agent' as const, content: 'Hi there', messageType: 'text' as const, createdAtUtc: '' },
    ];

    mockApiClient.get.mockResolvedValueOnce({ messages: mockMessages, total: 2 });

    const { result } = renderHook(() =>
      useSessionManager({ projectId: mockProjectId })
    );

    let response;
    await act(async () => {
      response = await result.current.loadMessages('session-id', 0, 50);
    });

    expect(response).toEqual({ messages: mockMessages, total: 2 });
    expect(mockApiClient.get).toHaveBeenCalledWith('/api/sessions/session-id/messages?skip=0&take=50');
  });

  it('should handle errors when loading sessions', async () => {
    mockApiClient.get.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() =>
      useSessionManager({ projectId: mockProjectId, autoLoad: true })
    );

    await waitFor(() => {
      expect(result.current.error).toBe('Network error');
    });

    expect(result.current.isLoading).toBe(false);
  });

  it('should throw error when creating session without projectId', async () => {
    const { result } = renderHook(() => useSessionManager());

    await expect(result.current.createSession()).rejects.toThrow('Project ID is required');
  });

  it('should load running sessions', async () => {
    const runningSessions = [
      { id: 'r1', projectId: mockProjectId, title: 'Running 1', state: 'RUNNING' as const, messageCount: 10, createdAtUtc: '', updatedAtUtc: '' },
    ];

    mockApiClient.get.mockResolvedValueOnce({ sessions: runningSessions });

    const { result } = renderHook(() => useSessionManager());

    await act(async () => {
      await result.current.loadRunningSessions();
    });

    expect(result.current.runningSessions).toEqual(runningSessions);
    expect(mockApiClient.get).toHaveBeenCalledWith('/api/sessions/running');
  });
});
