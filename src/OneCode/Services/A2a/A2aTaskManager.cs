using System.Collections.Concurrent;
using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using OneCode.Services.Codex;

namespace OneCode.Services.A2a;

public sealed class A2aTaskManager
{
    private readonly ILogger<A2aTaskManager> _logger;
    private readonly CodexSessionManager _codexSessionManager;
    private readonly CodexAppServerClient _codexClient;

    private readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web);
    private readonly ConcurrentDictionary<string, A2aTaskState> _tasks = new(StringComparer.Ordinal);
    private long _nextEventId;

    public A2aTaskManager(
        ILogger<A2aTaskManager> logger,
        CodexSessionManager codexSessionManager,
        CodexAppServerClient codexClient)
    {
        _logger = logger;
        _codexSessionManager = codexSessionManager;
        _codexClient = codexClient;
    }

    public bool TryGetSnapshot(string taskId, [NotNullWhen(true)] out A2aTaskSnapshot? snapshot)
    {
        if (!_tasks.TryGetValue(taskId, out var state))
        {
            snapshot = null;
            return false;
        }

        lock (state.Sync)
        {
            snapshot = new A2aTaskSnapshot(
                TaskId: state.TaskId,
                ContextId: state.ContextId,
                Cwd: state.Cwd,
                State: state.State,
                Final: state.Final,
                LatestEventId: state.Events.Count == 0 ? 0 : state.Events[^1].EventId,
                AssistantText: state.AssistantText.ToString(),
                ReasoningText: state.ReasoningText.ToString(),
                ToolOutputText: state.ToolOutputText.ToString(),
                DiffText: state.DiffText,
                TokenUsage: state.TokenUsage,
                CodexEvents: state.CodexEvents.ToArray(),
                ThreadId: state.ThreadId,
                TurnId: state.TurnId);
        }

        return true;
    }

    public async IAsyncEnumerable<A2aStoredEvent> StreamEventsAsync(
        string taskId,
        long? afterEventId,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        if (!_tasks.TryGetValue(taskId, out var state))
        {
            yield break;
        }

        var cursor = afterEventId.GetValueOrDefault(0);

        while (!cancellationToken.IsCancellationRequested)
        {
            A2aStoredEvent[] batch;
            TaskCompletionSource<bool> waitSignal;
            var isFinal = false;

            lock (state.Sync)
            {
                batch = state.Events
                    .Where(e => e.EventId > cursor)
                    .ToArray();

                if (batch.Length > 0)
                {
                    cursor = batch[^1].EventId;
                }

                isFinal = state.Final;
                waitSignal = state.NewEventSignal;
            }

            foreach (var item in batch)
            {
                yield return item;
            }

            if (isFinal)
            {
                yield break;
            }

            try
            {
                await waitSignal.Task.WaitAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                yield break;
            }
        }
    }

    public async Task EnsureTaskStartedAsync(
        A2aTaskStartRequest request,
        CancellationToken cancellationToken)
    {
        var state = _tasks.GetOrAdd(request.TaskId, static id => new A2aTaskState(id));

        var shouldStart = false;
        lock (state.Sync)
        {
            if (!state.Started)
            {
                shouldStart = true;
                state.Started = true;
                state.TaskId = request.TaskId;
                state.ContextId = request.ContextId;
                state.Cwd = request.Cwd;
                state.State = "TASK_STATE_SUBMITTED";
            }
        }

        if (!shouldStart)
        {
            return;
        }

        AppendResult(
            state,
            new
            {
                statusUpdate = BuildStatusUpdate(
                    taskId: request.TaskId,
                    contextId: request.ContextId,
                    state: "TASK_STATE_SUBMITTED",
                    message: new
                    {
                        role = "agent",
                        messageId = $"msg-status-{request.TaskId}",
                        taskId = request.TaskId,
                        contextId = request.ContextId,
                        parts = new[] { new { text = "submitted" } },
                    },
                    final: false),
            });

        state.RunningTask = Task.Run(
            () => RunCodexTurnAsync(state, request),
            CancellationToken.None);

        await Task.CompletedTask;
    }

    public async Task<bool> RequestCancelAsync(string taskId, CancellationToken cancellationToken)
    {
        if (!_tasks.TryGetValue(taskId, out var state))
        {
            return false;
        }

        string? threadId;
        string? turnId;

        lock (state.Sync)
        {
            state.CancelRequested = true;
            threadId = state.ThreadId;
            turnId = state.TurnId;
        }

        if (string.IsNullOrWhiteSpace(threadId) || string.IsNullOrWhiteSpace(turnId))
        {
            return true;
        }

        try
        {
            _ = await _codexClient.CallAsync(
                method: "turn/interrupt",
                @params: new
                {
                    threadId,
                    turnId,
                },
                cancellationToken);

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to interrupt codex turn for task {TaskId}.", taskId);
            return false;
        }
    }

    private async Task RunCodexTurnAsync(A2aTaskState state, A2aTaskStartRequest request)
    {
        try
        {
            var thread = await _codexSessionManager.GetOrCreateThreadAsync(
                request.ContextId,
                request.Cwd,
                CancellationToken.None);

            lock (state.Sync)
            {
                state.ThreadId = thread.ThreadId;
            }

            using var subscription = _codexClient.Subscribe(out var events);

            var turnStartResult = await _codexClient.CallAsync(
                method: "turn/start",
                @params: new
                {
                    threadId = thread.ThreadId,
                    approvalPolicy = "never",
                    sandboxPolicy = new { type = "dangerFullAccess" },
                    summary = "detailed",
                    input = new object[]
                    {
                        new { type = "text", text = request.UserText },
                    },
                },
                CancellationToken.None);

            var turnId = TryReadString(turnStartResult, "turn", "id") ?? string.Empty;

            lock (state.Sync)
            {
                state.TurnId = turnId;
            }

            AppendResult(
                state,
                new
                {
                    statusUpdate = BuildStatusUpdate(
                        taskId: request.TaskId,
                        contextId: request.ContextId,
                        state: "TASK_STATE_WORKING",
                        message: new
                        {
                            role = "agent",
                            messageId = $"msg-status-{request.TaskId}",
                            taskId = request.TaskId,
                            contextId = request.ContextId,
                            parts = new[] { new { text = "working" } },
                        },
                        final: false),
                });

            if (ShouldInterruptAfterStart(state))
            {
                _ = await _codexClient.CallAsync(
                    method: "turn/interrupt",
                    @params: new
                    {
                        threadId = thread.ThreadId,
                        turnId,
                    },
                    CancellationToken.None);
            }

            var assistantText = state.AssistantText;
            var reasoningText = state.ReasoningText;
            var toolOutputText = state.ToolOutputText;

            while (await events.WaitToReadAsync(CancellationToken.None))
            {
                while (events.TryRead(out var ev))
                {
                    if (ev is CodexAppServerEvent.StderrLine stderr)
                    {
                        var text = $"{stderr.ReceivedAtUtc:O} {stderr.Text}\n";
                        lock (state.Sync)
                        {
                            toolOutputText.Append(text);
                        }

                        AppendResult(
                            state,
                            new
                            {
                                artifactUpdate = BuildTextArtifactUpdate(
                                    taskId: request.TaskId,
                                    contextId: request.ContextId,
                                    artifactId: "stderr",
                                    name: "stderr",
                                    text,
                                    append: true,
                                    lastChunk: false),
                            });

                        continue;
                    }

                    if (ev is not CodexAppServerEvent.JsonNotification notification)
                    {
                        continue;
                    }

                    if (!string.Equals(notification.Meta.ThreadId, thread.ThreadId, StringComparison.Ordinal))
                    {
                        continue;
                    }

                    if (!string.IsNullOrWhiteSpace(turnId)
                        && !string.IsNullOrWhiteSpace(notification.Meta.TurnId)
                        && !string.Equals(notification.Meta.TurnId, turnId, StringComparison.Ordinal))
                    {
                        continue;
                    }

                    using var msgDoc = JsonDocument.Parse(notification.RawJson);
                    var msgRoot = msgDoc.RootElement;
                    var msgMethod = TryReadString(msgRoot, "method");
                    var msgParams = TryGetObject(msgRoot, "params");

                    lock (state.Sync)
                    {
                        state.CodexEvents.Add(new A2aCodexEvent(notification.ReceivedAtUtc, msgMethod, notification.RawJson));
                    }

                    AppendResult(
                        state,
                        new
                        {
                            artifactUpdate = new
                            {
                                taskId = request.TaskId,
                                contextId = request.ContextId,
                                append = true,
                                lastChunk = false,
                                artifact = new
                                {
                                    artifactId = $"artifact-events-{request.TaskId}",
                                    name = "codex-events",
                                    parts = new object[]
                                    {
                                        new
                                        {
                                            data = new
                                            {
                                                receivedAtUtc = notification.ReceivedAtUtc,
                                                method = msgMethod,
                                                raw = notification.RawJson,
                                            },
                                        },
                                    },
                                },
                            },
                        });

                    switch (msgMethod)
                    {
                        case "item/agentMessage/delta":
                        {
                            var delta = TryReadString(msgParams, "delta") ?? string.Empty;
                            lock (state.Sync)
                            {
                                assistantText.Append(delta);
                            }

                            AppendResult(
                                state,
                                new
                                {
                                    statusUpdate = BuildStatusUpdate(
                                        taskId: request.TaskId,
                                        contextId: request.ContextId,
                                        state: "TASK_STATE_WORKING",
                                        message: new
                                        {
                                            role = "agent",
                                            messageId = request.AgentMessageId,
                                            taskId = request.TaskId,
                                            contextId = request.ContextId,
                                            parts = new[] { new { text = delta } },
                                        },
                                        final: false),
                                });

                            break;
                        }

                        case "item/reasoning/summaryTextDelta":
                        case "item/reasoning/textDelta":
                        {
                            var delta = TryReadString(msgParams, "delta") ?? string.Empty;
                            lock (state.Sync)
                            {
                                reasoningText.Append(delta);
                            }

                            AppendResult(
                                state,
                                new
                                {
                                    artifactUpdate = BuildTextArtifactUpdate(
                                        taskId: request.TaskId,
                                        contextId: request.ContextId,
                                        artifactId: $"artifact-reasoning-{request.TaskId}",
                                        name: "reasoning",
                                        text: delta,
                                        append: true,
                                        lastChunk: false),
                                });

                            break;
                        }

                        case "item/commandExecution/outputDelta":
                        {
                            var delta = TryReadString(msgParams, "delta") ?? string.Empty;
                            lock (state.Sync)
                            {
                                toolOutputText.Append(delta);
                            }

                            AppendResult(
                                state,
                                new
                                {
                                    artifactUpdate = BuildTextArtifactUpdate(
                                        taskId: request.TaskId,
                                        contextId: request.ContextId,
                                        artifactId: $"artifact-tool-{request.TaskId}",
                                        name: "tool-output",
                                        text: delta,
                                        append: true,
                                        lastChunk: false),
                                });

                            break;
                        }

                        case "turn/diff/updated":
                        {
                            var diff = TryReadString(msgParams, "diff") ?? string.Empty;
                            lock (state.Sync)
                            {
                                state.DiffText = diff;
                            }

                            AppendResult(
                                state,
                                new
                                {
                                    artifactUpdate = BuildTextArtifactUpdate(
                                        taskId: request.TaskId,
                                        contextId: request.ContextId,
                                        artifactId: $"artifact-diff-{request.TaskId}",
                                        name: "diff",
                                        text: diff,
                                        append: false,
                                        lastChunk: true),
                                });

                            break;
                        }

                        case "thread/tokenUsage/updated":
                        {
                            var tokenUsage = TryGetObject(msgParams, "tokenUsage");

                            object? tokenUsageObject = null;
                            if (tokenUsage.ValueKind != JsonValueKind.Undefined)
                            {
                                tokenUsageObject = JsonSerializer.Deserialize<object>(tokenUsage.GetRawText(), _jsonOptions);
                            }

                            lock (state.Sync)
                            {
                                state.TokenUsage = tokenUsageObject;
                            }

                            AppendResult(
                                state,
                                new
                                {
                                    artifactUpdate = new
                                    {
                                        taskId = request.TaskId,
                                        contextId = request.ContextId,
                                        append = false,
                                        lastChunk = true,
                                        artifact = new
                                        {
                                            artifactId = $"artifact-token-usage-{request.TaskId}",
                                            name = "token-usage",
                                            parts = new object[]
                                            {
                                                new
                                                {
                                                    data = tokenUsageObject,
                                                },
                                            },
                                        },
                                    },
                                });

                            break;
                        }

                        case "turn/completed":
                        {
                            var turn = TryGetObject(msgParams, "turn");
                            var status = TryReadString(turn, "status") ?? "completed";
                            var mapped = status switch
                            {
                                "failed" => "TASK_STATE_FAILED",
                                "interrupted" => "TASK_STATE_CANCELLED",
                                _ => "TASK_STATE_COMPLETED",
                            };

                            var fullAssistant = assistantText.ToString();
                            lock (state.Sync)
                            {
                                state.State = mapped;
                                state.Final = true;
                            }

                            AppendResult(
                                state,
                                new
                                {
                                    statusUpdate = BuildStatusUpdate(
                                        taskId: request.TaskId,
                                        contextId: request.ContextId,
                                        state: mapped,
                                        message: new
                                        {
                                            role = "agent",
                                            messageId = request.AgentMessageId,
                                            taskId = request.TaskId,
                                            contextId = request.ContextId,
                                            parts = new[] { new { text = fullAssistant } },
                                        },
                                        final: true),
                                },
                                markFinal: true);

                            return;
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "A2A task {TaskId} failed.", request.TaskId);

            lock (state.Sync)
            {
                state.State = "TASK_STATE_FAILED";
                state.Final = true;
            }

            AppendResult(
                state,
                new
                {
                    statusUpdate = BuildStatusUpdate(
                        taskId: request.TaskId,
                        contextId: request.ContextId,
                        state: "TASK_STATE_FAILED",
                        message: new
                        {
                            role = "agent",
                            messageId = request.AgentMessageId,
                            taskId = request.TaskId,
                            contextId = request.ContextId,
                            parts = new[] { new { text = ex.Message } },
                        },
                        final: true),
                },
                markFinal: true);
        }
    }

    private bool ShouldInterruptAfterStart(A2aTaskState state)
    {
        lock (state.Sync)
        {
            if (!state.CancelRequested)
            {
                return false;
            }

            if (state.Final)
            {
                return false;
            }

            return !string.IsNullOrWhiteSpace(state.ThreadId) && !string.IsNullOrWhiteSpace(state.TurnId);
        }
    }

    private void AppendResult(A2aTaskState state, object resultObject, bool markFinal = false)
    {
        var resultJson = JsonSerializer.Serialize(resultObject, _jsonOptions);
        var eventId = Interlocked.Increment(ref _nextEventId);

        TaskCompletionSource<bool> toSignal;
        lock (state.Sync)
        {
            state.Events.Add(new A2aStoredEvent(eventId, resultJson));
            toSignal = state.NewEventSignal;
            state.NewEventSignal = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

            if (markFinal)
            {
                state.Final = true;
            }
        }

        toSignal.TrySetResult(true);
    }

    private static object BuildStatusUpdate(
        string taskId,
        string contextId,
        string state,
        object? message,
        bool final)
    {
        return new
        {
            taskId,
            contextId,
            status = new
            {
                state,
                timestamp = DateTimeOffset.UtcNow.ToString("O"),
                message,
            },
            final,
        };
    }

    private static object BuildTextArtifactUpdate(
        string taskId,
        string contextId,
        string artifactId,
        string name,
        string text,
        bool append,
        bool lastChunk)
    {
        return new
        {
            taskId,
            contextId,
            append,
            lastChunk,
            artifact = new
            {
                artifactId,
                name,
                parts = new object[]
                {
                    new { text },
                },
            },
        };
    }

    private static string? TryReadString(JsonElement element, params string[] path)
    {
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
}

public readonly record struct A2aStoredEvent(long EventId, string ResultJson);

public sealed record A2aTaskStartRequest(
    string TaskId,
    string ContextId,
    string Cwd,
    string UserText,
    string UserMessageId,
    string AgentMessageId);

public sealed record A2aCodexEvent(DateTimeOffset ReceivedAtUtc, string? Method, string RawJson);

public sealed record A2aTaskSnapshot(
    string TaskId,
    string ContextId,
    string Cwd,
    string State,
    bool Final,
    long LatestEventId,
    string AssistantText,
    string ReasoningText,
    string ToolOutputText,
    string DiffText,
    object? TokenUsage,
    IReadOnlyList<A2aCodexEvent> CodexEvents,
    string? ThreadId,
    string? TurnId);

internal sealed class A2aTaskState
{
    public A2aTaskState(string taskId)
    {
        TaskId = taskId;
    }

    public object Sync { get; } = new();

    public string TaskId { get; set; }
    public string ContextId { get; set; } = "default";
    public string Cwd { get; set; } = string.Empty;

    public bool Started { get; set; }
    public bool Final { get; set; }
    public string State { get; set; } = "TASK_STATE_SUBMITTED";

    public string? ThreadId { get; set; }
    public string? TurnId { get; set; }

    public bool CancelRequested { get; set; }
    public Task? RunningTask { get; set; }

    public StringBuilder AssistantText { get; } = new();
    public StringBuilder ReasoningText { get; } = new();
    public StringBuilder ToolOutputText { get; } = new();
    public string DiffText { get; set; } = string.Empty;
    public object? TokenUsage { get; set; }

    public List<A2aStoredEvent> Events { get; } = new();
    public List<A2aCodexEvent> CodexEvents { get; } = new();

    public TaskCompletionSource<bool> NewEventSignal { get; set; }
        = new(TaskCreationOptions.RunContinuationsAsynchronously);
}
