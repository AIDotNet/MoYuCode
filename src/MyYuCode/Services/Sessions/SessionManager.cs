using MyYuCode.Data;
using MyYuCode.Data.Entities;

namespace MyYuCode.Services.Sessions;

/// <summary>
/// 会话管理服务，负责会话的创建、删除、查询等操作
/// </summary>
public sealed class SessionManager
{
    private readonly JsonDataStore _dataStore;
    private readonly ILogger<SessionManager> _logger;

    public SessionManager(JsonDataStore dataStore, ILogger<SessionManager> logger)
    {
        _dataStore = dataStore ?? throw new ArgumentNullException(nameof(dataStore));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// 创建新会话
    /// </summary>
    public async Task<SessionEntity> CreateSessionAsync(Guid projectId, string? title = null)
    {
        var session = new SessionEntity
        {
            ProjectId = projectId,
            Title = title ?? $"会话 {DateTime.Now:yyyy-MM-dd HH:mm}",
            State = SessionState.Idle,
            CreatedAtUtc = DateTimeOffset.UtcNow,
            UpdatedAtUtc = DateTimeOffset.UtcNow
        };

        _dataStore.Add(session);
        await _dataStore.SaveDataAsync();

        _logger.LogInformation("Created session {SessionId} for project {ProjectId}", session.Id, projectId);
        return session;
    }

    /// <summary>
    /// 删除会话及其所有消息
    /// </summary>
    public async Task<bool> DeleteSessionAsync(Guid sessionId)
    {
        var session = _dataStore.GetSession(sessionId);
        if (session == null)
        {
            _logger.LogWarning("Session {SessionId} not found for deletion", sessionId);
            return false;
        }

        // 删除会话消息
        _dataStore.RemoveSessionMessages(sessionId);

        // 删除会话
        _dataStore.Remove(session);
        await _dataStore.SaveDataAsync();

        _logger.LogInformation("Deleted session {SessionId}", sessionId);
        return true;
    }

    /// <summary>
    /// 获取项目的所有会话
    /// </summary>
    public List<SessionEntity> GetProjectSessions(Guid projectId)
    {
        return _dataStore.GetSessionsByProject(projectId);
    }

    /// <summary>
    /// 获取所有运行中的会话
    /// </summary>
    public List<SessionEntity> GetRunningSessions()
    {
        return _dataStore.GetRunningSessions();
    }

    /// <summary>
    /// 获取会话
    /// </summary>
    public SessionEntity? GetSession(Guid sessionId)
    {
        return _dataStore.GetSession(sessionId);
    }

    /// <summary>
    /// 切换项目的当前会话
    /// </summary>
    public async Task<bool> SwitchCurrentSessionAsync(Guid projectId, Guid sessionId)
    {
        var project = _dataStore.GetProjectWithProvider(projectId);
        if (project == null)
        {
            _logger.LogWarning("Project {ProjectId} not found", projectId);
            return false;
        }

        var session = _dataStore.GetSession(sessionId);
        if (session == null || session.ProjectId != projectId)
        {
            _logger.LogWarning("Session {SessionId} not found or doesn't belong to project {ProjectId}", sessionId, projectId);
            return false;
        }

        project.CurrentSessionId = sessionId;
        project.UpdatedAtUtc = DateTimeOffset.UtcNow;
        await _dataStore.SaveDataAsync();

        _logger.LogInformation("Switched project {ProjectId} current session to {SessionId}", projectId, sessionId);
        return true;
    }

    /// <summary>
    /// 更新会话状态
    /// </summary>
    public async Task UpdateSessionStateAsync(Guid sessionId, SessionState state)
    {
        var session = _dataStore.GetSession(sessionId);
        if (session == null)
        {
            _logger.LogWarning("Session {SessionId} not found for state update", sessionId);
            return;
        }

        session.State = state;
        session.UpdatedAtUtc = DateTimeOffset.UtcNow;

        if (state is SessionState.Completed or SessionState.Failed or SessionState.Cancelled)
        {
            session.CompletedAtUtc = DateTimeOffset.UtcNow;
        }

        await _dataStore.SaveDataAsync();
        _logger.LogInformation("Updated session {SessionId} state to {State}", sessionId, state);
    }

    /// <summary>
    /// 更新会话标题
    /// </summary>
    public async Task UpdateSessionTitleAsync(Guid sessionId, string title)
    {
        var session = _dataStore.GetSession(sessionId);
        if (session == null)
        {
            _logger.LogWarning("Session {SessionId} not found for title update", sessionId);
            return;
        }

        session.Title = title;
        session.UpdatedAtUtc = DateTimeOffset.UtcNow;
        await _dataStore.SaveDataAsync();
    }

    /// <summary>
    /// 同步项目会话标题（从日志文件中读取）
    /// </summary>
    public async Task SyncProjectSessionTitlesAsync(Guid projectId)
    {
        var project = _dataStore.GetProjectWithProvider(projectId);
        if (project == null) return;

        var sessions = _dataStore.GetSessionsByProject(projectId);
        if (sessions.Count == 0) return;

        bool changed = false;
        var userHome = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        if (project.ToolType == ToolType.Codex)
        {
            var historyPath = Path.Combine(userHome, ".codex", "history.jsonl");
            if (File.Exists(historyPath))
            {
                try
                {
                    // 预读取 Codex 历史记录，建立 SessionId -> Title 映射
                    var sessionTitles = new Dictionary<string, string>();
                    
                    // 使用 FileShare.ReadWrite 读取，避免锁文件
                    using var fs = new FileStream(historyPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                    using var reader = new StreamReader(fs);
                    
                    string? line;
                    while ((line = await reader.ReadLineAsync()) != null)
                    {
                        try
                        {
                            var node = System.Text.Json.Nodes.JsonNode.Parse(line);
                            if (node == null) continue;

                            var sid = node["session_id"]?.ToString();
                            var text = node["text"]?.ToString();

                            if (!string.IsNullOrEmpty(sid) && !string.IsNullOrEmpty(text))
                            {
                                // 只记录每个 session 的第一条有效文本
                                if (!sessionTitles.ContainsKey(sid))
                                {
                                    sessionTitles[sid] = text;
                                }
                            }
                        }
                        catch
                        {
                            // 忽略解析错误行
                        }
                    }

                    // 更新会话标题
                    foreach (var session in sessions)
                    {
                        // 如果标题是默认格式（包含"会话"）或者为空，尝试更新
                        // 用户要求的逻辑是"使用...text展示...而不是现在的时间"，暗示应该覆盖
                        // 这里我们假设如果标题以 "会话 " 开头，就是默认标题
                        if (string.IsNullOrEmpty(session.Title) || session.Title.StartsWith("会话 "))
                        {
                            if (sessionTitles.TryGetValue(session.Id.ToString(), out var newTitle))
                            {
                                // 截断过长的标题
                                if (newTitle.Length > 50) newTitle = newTitle.Substring(0, 47) + "...";
                                
                                session.Title = newTitle;
                                changed = true;
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to sync Codex session titles");
                }
            }
        }
        else if (project.ToolType == ToolType.ClaudeCode)
        {
            foreach (var session in sessions)
            {
                if (!string.IsNullOrEmpty(session.Title) && !session.Title.StartsWith("会话 ")) continue;

                // 尝试多个可能的路径
                // 1. ~/.claude/sessions/{id}.json
                // 2. ~/.claude/sessions/{id}/history.jsonl (猜测)
                // 用户提示：读取"对应的文件"
                
                // 假设路径为 ~/.claude/sessions/{id}.json
                var sessionFile = Path.Combine(userHome, ".claude", "sessions", $"{session.Id}.json");
                
                // 如果找不到，尝试查找包含该 ID 的文件？这太慢了。
                // 暂时只支持标准路径
                
                if (File.Exists(sessionFile))
                {
                    try
                    {
                        using var fs = new FileStream(sessionFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                        using var reader = new StreamReader(fs);

                        // 读取第一行（快照）
                        await reader.ReadLineAsync();
                        
                        // 读取第二行（用户消息）
                        var line2 = await reader.ReadLineAsync();
                        if (!string.IsNullOrEmpty(line2))
                        {
                            var node = System.Text.Json.Nodes.JsonNode.Parse(line2);
                            // 提取 message.content
                            var content = node?["message"]?["content"]?.ToString();
                            
                            if (!string.IsNullOrEmpty(content))
                            {
                                if (content.Length > 50) content = content.Substring(0, 47) + "...";
                                session.Title = content;
                                changed = true;
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "Failed to read Claude session file for {SessionId}", session.Id);
                    }
                }
            }
        }

        if (changed)
        {
            await _dataStore.SaveDataAsync();
        }
    }
}
