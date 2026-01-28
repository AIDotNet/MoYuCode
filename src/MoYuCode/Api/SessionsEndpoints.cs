using Microsoft.AspNetCore.Mvc;
using MoYuCode.Contracts.Sessions;
using MoYuCode.Data;
using MoYuCode.Data.Entities;
using MoYuCode.Services.Sessions;

namespace MoYuCode.Api;

public static class SessionsEndpoints
{
    public static void MapSessionsEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api");

        // POST /api/sessions - 创建会话
        group.MapPost("/sessions", CreateSession)
            .WithName("CreateSession")
            ;

        // GET /api/projects/{projectId}/managed-sessions - 获取项目会话列表（自管理会话）
        group.MapGet("/projects/{projectId:guid}/managed-sessions", GetProjectSessions)
            .WithName("GetProjectSessions")
            ;

        // GET /api/sessions/running - 获取运行中会话
        group.MapGet("/sessions/running", GetRunningSessions)
            .WithName("GetRunningSessions")
            ;

        // PUT /api/projects/{projectId}/current-session - 切换当前会话
        group.MapPut("/projects/{projectId:guid}/current-session", SwitchCurrentSession)
            .WithName("SwitchCurrentSession")
            ;

        // GET /api/sessions/{sessionId}/messages - 获取会话消息
        group.MapGet("/sessions/{sessionId:guid}/messages", GetSessionMessages)
            .WithName("GetSessionMessages")
            ;

        // DELETE /api/sessions/{sessionId} - 删除会话
        group.MapDelete("/sessions/{sessionId:guid}", DeleteSession)
            .WithName("DeleteSession")
            ;

        // GET /api/sessions/{sessionId} - 获取会话详情
        group.MapGet("/sessions/{sessionId:guid}", GetSession)
            .WithName("GetSession")
            ;

        // PATCH /api/sessions/{sessionId} - 更新会话
        group.MapPatch("/sessions/{sessionId:guid}", UpdateSession)
            .WithName("UpdateSession")
            ;
    }

    private static async Task<IResult> CreateSession(
        [FromBody] CreateSessionRequest request,
        SessionManager sessionManager)
    {
        var session = await sessionManager.CreateSessionAsync(request.ProjectId, request.Title);
        return Results.Ok(MapToDto(session));
    }

    private static async Task<IResult> GetProjectSessions(
        Guid projectId,
        SessionManager sessionManager,
        JsonDataStore dataStore)
    {
        await sessionManager.SyncProjectSessionTitlesAsync(projectId);
        var sessions = sessionManager.GetProjectSessions(projectId);
        var project = dataStore.GetProjectWithProvider(projectId);

        return Results.Ok(new SessionListResponse
        {
            Sessions = sessions.Select(s => MapToDto(s, project?.Name)).ToList()
        });
    }

    private static IResult GetRunningSessions(
        SessionManager sessionManager,
        JsonDataStore dataStore)
    {
        var sessions = sessionManager.GetRunningSessions();
        var response = new SessionListResponse
        {
            Sessions = sessions.Select(s =>
            {
                var project = dataStore.GetProjectWithProvider(s.ProjectId);
                return MapToDto(s, project?.Name);
            }).ToList()
        };

        return Results.Ok(response);
    }

    private static async Task<IResult> SwitchCurrentSession(
        Guid projectId,
        [FromBody] SwitchSessionRequest request,
        SessionManager sessionManager)
    {
        var success = await sessionManager.SwitchCurrentSessionAsync(projectId, request.SessionId);
        return Results.Ok(new SwitchSessionResponse
        {
            Success = success,
            CurrentSessionId = success ? request.SessionId : null
        });
    }

    private static IResult GetSessionMessages(
        Guid sessionId,
        [FromQuery] int skip = 0,
        [FromQuery] int take = 50,
        SessionMessageRepository? messageRepository = null)
    {
        if (messageRepository == null)
        {
            return Results.Problem("Message repository not available");
        }

        var (messages, total) = messageRepository.GetMessages(sessionId, skip, take);
        return Results.Ok(new SessionMessagesResponse
        {
            Messages = messages.Select(MapToDto).ToList(),
            Total = total
        });
    }

    private static async Task<IResult> DeleteSession(
        Guid sessionId,
        SessionManager sessionManager)
    {
        var success = await sessionManager.DeleteSessionAsync(sessionId);
        return success ? Results.Ok() : Results.NotFound();
    }

    private static IResult GetSession(
        Guid sessionId,
        SessionManager sessionManager,
        JsonDataStore dataStore)
    {
        var session = sessionManager.GetSession(sessionId);
        if (session == null)
        {
            return Results.NotFound();
        }

        var project = dataStore.GetProjectWithProvider(session.ProjectId);
        return Results.Ok(MapToDto(session, project?.Name));
    }

    private static async Task<IResult> UpdateSession(
        Guid sessionId,
        [FromBody] UpdateSessionRequest request,
        SessionManager sessionManager,
        JsonDataStore dataStore)
    {
        var session = sessionManager.GetSession(sessionId);
        if (session == null)
        {
            return Results.NotFound();
        }

        if (request.Title != null)
        {
            await sessionManager.UpdateSessionTitleAsync(sessionId, request.Title);
            session = sessionManager.GetSession(sessionId);
        }

        var project = dataStore.GetProjectWithProvider(session!.ProjectId);
        return Results.Ok(MapToDto(session, project?.Name));
    }

    private static SessionDto MapToDto(SessionEntity entity, string? projectName = null)
    {
        return new SessionDto
        {
            Id = entity.Id,
            ProjectId = entity.ProjectId,
            ProjectName = projectName,
            Title = entity.Title,
            State = entity.State.ToString().ToUpperInvariant(),
            CreatedAtUtc = entity.CreatedAtUtc,
            UpdatedAtUtc = entity.UpdatedAtUtc,
            CompletedAtUtc = entity.CompletedAtUtc,
            MessageCount = entity.MessageCount
        };
    }

    private static SessionMessageDto MapToDto(SessionMessageEntity entity)
    {
        return new SessionMessageDto
        {
            Id = entity.Id,
            Role = entity.Role.ToString().ToLowerInvariant(),
            Content = entity.Content,
            MessageType = entity.MessageType.ToString().ToLowerInvariant(),
            CreatedAtUtc = entity.CreatedAtUtc
        };
    }
}
