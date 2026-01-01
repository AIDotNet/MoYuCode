using System.Text;
using System.Text.Json;
using OneCode.Services.A2a;

namespace OneCode.Api;

public static class A2aEndpoints
{
    public static void MapA2a(this WebApplication app)
    {
        app.MapGet("/.well-known/agent.json", (HttpContext httpContext) =>
        {
            return Results.Json(BuildAgentCard(httpContext));
        });

        // Optional compatibility: some clients prepend the A2A base path.
        app.MapGet("/a2a/.well-known/agent.json", (HttpContext httpContext) =>
        {
            return Results.Json(BuildAgentCard(httpContext));
        });

        app.MapPost("/a2a", HandleJsonRpcAsync);
    }

    private static object BuildAgentCard(HttpContext httpContext)
    {
        var baseUrl = $"{httpContext.Request.Scheme}://{httpContext.Request.Host}";
        var a2aUrl = $"{baseUrl}/a2a";

        return new
        {
            name = "OneCode Codex Agent",
            description = "Codex-backed agent (codex app-server) with full event streaming.",
            version = "0.0.1",
            capabilities = new
            {
                extensions = Array.Empty<object>(),
                pushNotifications = false,
                stateTransitionHistory = true,
                streaming = true,
            },
            url = a2aUrl,
            provider = new
            {
                organization = "OneCode",
                url = baseUrl,
            },
            security = (object?)null,
            securitySchemes = (object?)null,
            defaultInputModes = new[] { "text/plain" },
            defaultOutputModes = new[] { "text/plain", "application/json" },
            skills = new[]
            {
                new
                {
                    id = "codex-chat",
                    name = "Codex Chat",
                    description = "General coding assistant with streamed messages, reasoning, tool output, diffs, and raw events.",
                    tags = new[] { "coding", "chat" },
                    inputModes = new[] { "text/plain" },
                    outputModes = new[] { "text/plain", "application/json" },
                },
            },
            supportsAuthenticatedExtendedCard = false,
        };
    }

    private static async Task<IResult> HandleJsonRpcAsync(
        HttpContext httpContext,
        A2aTaskManager a2aTaskManager,
        CancellationToken cancellationToken)
    {
        using var doc = await JsonDocument.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
        var root = doc.RootElement;

        var method = ReadString(root, "method");
        if (string.IsNullOrWhiteSpace(method))
        {
            return Results.BadRequest();
        }

        var requestId = root.TryGetProperty("id", out var idElement) ? idElement.Clone() : default;
        var hasRequestId = root.TryGetProperty("id", out _);
        var @params = root.TryGetProperty("params", out var paramsElement) ? paramsElement : default;

        var normalizedMethod = method.Replace(".", "/", StringComparison.Ordinal);
        var methodKey = normalizedMethod.ToLowerInvariant();

        if (methodKey is "tasks/sendsubscribe" or "message/stream")
        {
            await HandleSendSubscribeAsync(
                httpContext,
                requestId,
                hasRequestId,
                @params,
                a2aTaskManager,
                cancellationToken);
            return Results.Empty;
        }

        if (methodKey is "tasks/resubscribe")
        {
            await HandleResubscribeAsync(
                httpContext,
                requestId,
                hasRequestId,
                @params,
                a2aTaskManager,
                cancellationToken);
            return Results.Empty;
        }

        if (methodKey is "tasks/get")
        {
            return HandleGetTask(
                requestId,
                hasRequestId,
                @params,
                a2aTaskManager);
        }

        if (methodKey is "tasks/cancel")
        {
            return await HandleCancelTaskAsync(
                requestId,
                hasRequestId,
                @params,
                a2aTaskManager,
                cancellationToken);
        }

        return Results.Json(BuildJsonRpcError(requestId, hasRequestId, code: -32601, message: $"Unsupported method: {method}"));
    }

    private static async Task HandleSendSubscribeAsync(
        HttpContext httpContext,
        JsonElement requestId,
        bool hasRequestId,
        JsonElement @params,
        A2aTaskManager a2aTaskManager,
        CancellationToken cancellationToken)
    {
        var response = httpContext.Response;
        response.Headers.CacheControl = "no-cache";
        response.Headers.Connection = "keep-alive";
        response.Headers.Append("X-Accel-Buffering", "no");
        response.ContentType = "text/event-stream";

        await using var writer = new StreamWriter(response.Body, Encoding.UTF8, leaveOpen: true);
        var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web);

        async Task<bool> TrySendErrorAsync(int code, string message, object? data = null)
        {
            var payload = BuildJsonRpcError(requestId, hasRequestId, code, message, data);
            return await TrySendSseAsync(writer, JsonSerializer.Serialize(payload, jsonOptions), eventId: null, cancellationToken);
        }

        var cwd = ReadString(@params, "cwd")
            ?? ReadString(@params, "workspacePath")
            ?? ReadString(@params, "rootPath");

        if (string.IsNullOrWhiteSpace(cwd))
        {
            await TrySendErrorAsync(code: -32602, message: "Missing params.cwd");
            return;
        }

        var message = TryGetObject(@params, "message");
        var userText = ExtractTextFromMessage(message);
        if (string.IsNullOrWhiteSpace(userText))
        {
            await TrySendErrorAsync(code: -32602, message: "Missing user text in params.message.parts");
            return;
        }

        var contextId = ReadString(@params, "contextId")
            ?? ReadString(message, "contextId")
            ?? Guid.NewGuid().ToString("N");

        var taskId = ReadString(@params, "taskId")
            ?? ReadString(@params, "id")
            ?? ReadString(message, "taskId")
            ?? Guid.NewGuid().ToString("N");

        var userMessageId = ReadString(message, "messageId") ?? $"msg-user-{taskId}";
        var agentMessageId = $"msg-agent-{taskId}";

        await a2aTaskManager.EnsureTaskStartedAsync(
            new A2aTaskStartRequest(
                TaskId: taskId,
                ContextId: contextId,
                Cwd: cwd,
                UserText: userText,
                UserMessageId: userMessageId,
                AgentMessageId: agentMessageId),
            cancellationToken);

        await StreamTaskEventsAsync(
            writer,
            requestId,
            hasRequestId,
            taskId,
            afterEventId: null,
            a2aTaskManager,
            cancellationToken);
    }

    private static async Task HandleResubscribeAsync(
        HttpContext httpContext,
        JsonElement requestId,
        bool hasRequestId,
        JsonElement @params,
        A2aTaskManager a2aTaskManager,
        CancellationToken cancellationToken)
    {
        var response = httpContext.Response;
        response.Headers.CacheControl = "no-cache";
        response.Headers.Connection = "keep-alive";
        response.Headers.Append("X-Accel-Buffering", "no");
        response.ContentType = "text/event-stream";

        await using var writer = new StreamWriter(response.Body, Encoding.UTF8, leaveOpen: true);
        var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web);

        async Task<bool> TrySendErrorAsync(int code, string message, object? data = null)
        {
            var payload = BuildJsonRpcError(requestId, hasRequestId, code, message, data);
            return await TrySendSseAsync(writer, JsonSerializer.Serialize(payload, jsonOptions), eventId: null, cancellationToken);
        }

        var taskId = ReadString(@params, "taskId")
            ?? ReadString(@params, "id");

        if (string.IsNullOrWhiteSpace(taskId))
        {
            await TrySendErrorAsync(code: -32602, message: "Missing params.taskId");
            return;
        }

        if (!a2aTaskManager.TryGetSnapshot(taskId, out var snapshot))
        {
            await TrySendErrorAsync(code: -32602, message: "Task not found.");
            return;
        }

        var afterEventId = ReadEventCursor(httpContext, @params);

        await StreamTaskEventsAsync(
            writer,
            requestId,
            hasRequestId,
            taskId,
            afterEventId,
            a2aTaskManager,
            cancellationToken);
    }

    private static IResult HandleGetTask(
        JsonElement requestId,
        bool hasRequestId,
        JsonElement @params,
        A2aTaskManager a2aTaskManager)
    {
        var taskId = ReadString(@params, "id")
            ?? ReadString(@params, "taskId");

        if (string.IsNullOrWhiteSpace(taskId))
        {
            return Results.Json(BuildJsonRpcError(requestId, hasRequestId, code: -32602, message: "Missing params.id"));
        }

        if (!a2aTaskManager.TryGetSnapshot(taskId, out var snapshot))
        {
            return Results.Json(BuildJsonRpcError(requestId, hasRequestId, code: -32602, message: "Task not found."));
        }

        var artifacts = new List<object>();

        if (!string.IsNullOrWhiteSpace(snapshot.ReasoningText))
        {
            artifacts.Add(new
            {
                artifactId = $"artifact-reasoning-{snapshot.TaskId}",
                name = "reasoning",
                parts = new object[] { new { text = snapshot.ReasoningText } },
            });
        }

        if (!string.IsNullOrWhiteSpace(snapshot.ToolOutputText))
        {
            artifacts.Add(new
            {
                artifactId = $"artifact-tool-{snapshot.TaskId}",
                name = "tool-output",
                parts = new object[] { new { text = snapshot.ToolOutputText } },
            });
        }

        if (!string.IsNullOrWhiteSpace(snapshot.DiffText))
        {
            artifacts.Add(new
            {
                artifactId = $"artifact-diff-{snapshot.TaskId}",
                name = "diff",
                parts = new object[] { new { text = snapshot.DiffText } },
            });
        }

        if (snapshot.TokenUsage is not null)
        {
            artifacts.Add(new
            {
                artifactId = $"artifact-token-usage-{snapshot.TaskId}",
                name = "token-usage",
                parts = new object[] { new { data = snapshot.TokenUsage } },
            });
        }

        if (snapshot.CodexEvents.Count > 0)
        {
            artifacts.Add(new
            {
                artifactId = $"artifact-events-{snapshot.TaskId}",
                name = "codex-events",
                parts = snapshot.CodexEvents
                    .Select(e => (object)new
                    {
                        data = new
                        {
                            receivedAtUtc = e.ReceivedAtUtc,
                            method = e.Method,
                            raw = e.RawJson,
                        },
                    })
                    .ToArray(),
            });
        }

        object? idValue = hasRequestId ? requestId : null;

        return Results.Json(new
        {
            jsonrpc = "2.0",
            id = idValue,
            result = new
            {
                task = new
                {
                    id = snapshot.TaskId,
                    contextId = snapshot.ContextId,
                    cwd = snapshot.Cwd,
                    status = new
                    {
                        state = snapshot.State,
                    },
                    final = snapshot.Final,
                    latestEventId = snapshot.LatestEventId,
                    threadId = snapshot.ThreadId,
                    turnId = snapshot.TurnId,
                    artifacts,
                    messages = new object[]
                    {
                        new
                        {
                            role = "agent",
                            messageId = $"msg-agent-{snapshot.TaskId}",
                            taskId = snapshot.TaskId,
                            contextId = snapshot.ContextId,
                            parts = new[] { new { text = snapshot.AssistantText } },
                        },
                    },
                },
            },
        });
    }

    private static async Task<IResult> HandleCancelTaskAsync(
        JsonElement requestId,
        bool hasRequestId,
        JsonElement @params,
        A2aTaskManager a2aTaskManager,
        CancellationToken cancellationToken)
    {
        var taskId = ReadString(@params, "id")
            ?? ReadString(@params, "taskId");

        if (string.IsNullOrWhiteSpace(taskId))
        {
            return Results.Json(BuildJsonRpcError(requestId, hasRequestId, code: -32602, message: "Missing params.id"));
        }

        if (!a2aTaskManager.TryGetSnapshot(taskId, out _))
        {
            return Results.Json(BuildJsonRpcError(requestId, hasRequestId, code: -32602, message: "Task not found."));
        }

        var ok = await a2aTaskManager.RequestCancelAsync(taskId, cancellationToken);
        object? idValue = hasRequestId ? requestId : null;

        return Results.Json(new
        {
            jsonrpc = "2.0",
            id = idValue,
            result = new
            {
                success = ok,
            },
        });
    }

    private static async Task StreamTaskEventsAsync(
        StreamWriter writer,
        JsonElement requestId,
        bool hasRequestId,
        string taskId,
        long? afterEventId,
        A2aTaskManager a2aTaskManager,
        CancellationToken cancellationToken)
    {
        var idRaw = hasRequestId ? requestId.GetRawText() : "null";

        await foreach (var ev in a2aTaskManager.StreamEventsAsync(taskId, afterEventId, cancellationToken))
        {
            var envelopeJson = BuildJsonRpcResultEnvelopeJson(idRaw, ev.ResultJson);
            var ok = await TrySendSseAsync(writer, envelopeJson, ev.EventId, cancellationToken);
            if (!ok)
            {
                return;
            }
        }
    }

    private static string BuildJsonRpcResultEnvelopeJson(string idRawJson, string resultJson)
        => $"{{\"jsonrpc\":\"2.0\",\"id\":{idRawJson},\"result\":{resultJson}}}";

    private static object BuildJsonRpcError(JsonElement requestId, bool hasRequestId, int code, string message, object? data = null)
    {
        object? idValue = hasRequestId ? requestId : null;
        return new
        {
            jsonrpc = "2.0",
            id = idValue,
            error = new
            {
                code,
                message,
                data,
            },
        };
    }

    private static long? ReadEventCursor(HttpContext httpContext, JsonElement @params)
    {
        if (@params.ValueKind == JsonValueKind.Object)
        {
            var cursorStr = ReadString(@params, "cursor") ?? ReadString(@params, "afterEventId");
            if (!string.IsNullOrWhiteSpace(cursorStr) && long.TryParse(cursorStr, out var parsed))
            {
                return parsed;
            }

            if (@params.TryGetProperty("afterEventId", out var afterId)
                && afterId.ValueKind == JsonValueKind.Number
                && afterId.TryGetInt64(out var number))
            {
                return number;
            }
        }

        var headerValue = httpContext.Request.Headers["Last-Event-ID"].ToString();
        if (!string.IsNullOrWhiteSpace(headerValue) && long.TryParse(headerValue, out var headerId))
        {
            return headerId;
        }

        return null;
    }

    private static string? ReadString(JsonElement element, params string[] path)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var current = element;
        foreach (var segment in path)
        {
            if (current.ValueKind != JsonValueKind.Object
                || !current.TryGetProperty(segment, out current))
            {
                return null;
            }
        }

        return current.ValueKind == JsonValueKind.String ? current.GetString() : null;
    }

    private static JsonElement TryGetObject(JsonElement element, string name)
    {
        if (element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.Object)
        {
            return value;
        }

        return default;
    }

    private static string? ExtractTextFromMessage(JsonElement message)
    {
        if (message.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (!message.TryGetProperty("parts", out var parts) || parts.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var builder = new StringBuilder();
        foreach (var part in parts.EnumerateArray())
        {
            if (part.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            if (part.TryGetProperty("text", out var textProp) && textProp.ValueKind == JsonValueKind.String)
            {
                builder.Append(textProp.GetString());
                continue;
            }

            if (part.TryGetProperty("kind", out var kindProp)
                && kindProp.ValueKind == JsonValueKind.String
                && string.Equals(kindProp.GetString(), "text", StringComparison.OrdinalIgnoreCase)
                && part.TryGetProperty("text", out var kindTextProp)
                && kindTextProp.ValueKind == JsonValueKind.String)
            {
                builder.Append(kindTextProp.GetString());
            }
        }

        return builder.Length > 0 ? builder.ToString() : null;
    }

    private static async Task<bool> TrySendSseAsync(
        StreamWriter writer,
        string data,
        long? eventId,
        CancellationToken cancellationToken)
    {
        try
        {
            if (eventId is not null)
            {
                await writer.WriteAsync($"id: {eventId.Value}\n");
            }

            var normalized = (data ?? string.Empty)
                .Replace("\r\n", "\n", StringComparison.Ordinal)
                .Replace('\r', '\n');

            foreach (var line in normalized.Split('\n'))
            {
                await writer.WriteAsync($"data: {line}\n");
            }

            await writer.WriteAsync("\n");
            await writer.FlushAsync(cancellationToken);
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
        catch (IOException)
        {
            return false;
        }
    }
}

