using System.Collections.Concurrent;
using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Extensions.Configuration;
using OneCode.Data.Entities;
using OneCode.Infrastructure;
using OneCode.Services.Codex;

namespace OneCode.Services.A2a;

public sealed class A2aTaskManager
{
    private readonly ILogger<A2aTaskManager> _logger;
    private readonly IConfiguration _configuration;
    private readonly CodexSessionManager _codexSessionManager;
    private readonly CodexAppServerClient _codexClient;

    private readonly JsonSerializerOptions _jsonOptions = new(JsonOptions.DefaultOptions);
    private readonly ConcurrentDictionary<string, A2aTaskState> _tasks = new(StringComparer.Ordinal);

    private readonly ConcurrentDictionary<string, SemaphoreSlim> _claudeSessionLocks =
        new(StringComparer.OrdinalIgnoreCase);

    private long _nextEventId;

    public A2aTaskManager(
        ILogger<A2aTaskManager> logger,
        IConfiguration configuration,
        CodexSessionManager codexSessionManager,
        CodexAppServerClient codexClient)
    {
        _logger = logger;
        _configuration = configuration;
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
                state.ToolType = request.ToolType;
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
            () => request.ToolType == ToolType.ClaudeCode
                ? RunClaudeTurnAsync(state, request)
                : RunCodexTurnAsync(state, request),
            CancellationToken.None);

        await Task.CompletedTask;
    }

    public async Task<bool> RequestCancelAsync(string taskId, CancellationToken cancellationToken)
    {
        if (!_tasks.TryGetValue(taskId, out var state))
        {
            return false;
        }

        ToolType toolType;
        Process? activeProcess;
        string? threadId;
        string? turnId;

        lock (state.Sync)
        {
            state.CancelRequested = true;
            toolType = state.ToolType;
            activeProcess = state.ActiveProcess;
            threadId = state.ThreadId;
            turnId = state.TurnId;
        }

        if (toolType == ToolType.ClaudeCode)
        {
            if (activeProcess is null)
            {
                return true;
            }

            try
            {
                if (!activeProcess.HasExited)
                {
                    activeProcess.Kill(entireProcessTree: true);
                }

                return true;
            }
            catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException
                                           or System.ComponentModel.Win32Exception)
            {
                _logger.LogWarning(ex, "Failed to kill claude process for task {TaskId}.", taskId);
                return false;
            }
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
        using var subscription = _codexClient.Subscribe(out var events);
        using var pumpCts = new CancellationTokenSource();
        var pumpTask = PumpCodexEventsAsync(state, request, events, pumpCts.Token);

        try
        {
            SetTaskState(state, "TASK_STATE_WORKING");
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
                            parts = new[] { new { text = "starting" } },
                        },
                        final: false),
                });

            AppendSystemLog(state, request, "准备启动 Codex（app-server）…");
            var thread = await _codexSessionManager.GetOrCreateThreadAsync(
                request.ContextId,
                request.Cwd,
                CancellationToken.None);

            lock (state.Sync)
            {
                state.ThreadId = thread.ThreadId;
            }

            AppendSystemLog(state, request, $"Thread 已就绪：{thread.ThreadId}");

            if (IsCancelRequested(state))
            {
                MarkFinalIfNeeded(state, request, "TASK_STATE_CANCELLED", "已取消");
                return;
            }

            AppendSystemLog(state, request, "开始生成（turn/start）…");
            var turnInputs = BuildTurnInputs(request);
            var turnStartResult = await _codexClient.CallAsync(
                method: "turn/start",
                @params: new
                {
                    threadId = thread.ThreadId,
                    approvalPolicy = "never",
                    sandboxPolicy = new { type = "dangerFullAccess" },
                    summary = "detailed",
                    model = request.Model,
                    input = turnInputs,
                },
                CancellationToken.None);

            var turnId = TryReadString(turnStartResult, "turn", "id") ?? string.Empty;

            lock (state.Sync)
            {
                state.TurnId = turnId;
            }

            AppendSystemLog(state, request, $"Turn 已开始：{turnId}");

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

            await pumpTask;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "A2A task {TaskId} failed.", request.TaskId);

            MarkFinalIfNeeded(state, request, "TASK_STATE_FAILED", ex.Message);
        }
        finally
        {
            pumpCts.Cancel();
            try
            {
                await pumpTask;
            }
            catch
            {
                // ignore
            }
        }
    }

    private async Task RunClaudeTurnAsync(A2aTaskState state, A2aTaskStartRequest request)
    {
        var sessionId = NormalizeClaudeSessionId(request.ContextId);
        var sessionLock = _claudeSessionLocks.GetOrAdd(sessionId, _ => new SemaphoreSlim(1, 1));
        await sessionLock.WaitAsync(CancellationToken.None);

        try
        {
            SetTaskState(state, "TASK_STATE_WORKING");
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
                            parts = new[] { new { text = "starting" } },
                        },
                        final: false),
                });

            AppendSystemLog(state, request, "准备启动 Claude Code…");

            var prompt = BuildClaudePrompt(request.UserText, request.UserImages);
            if (string.IsNullOrWhiteSpace(prompt))
            {
                prompt = " ";
            }

            var runResult = await RunClaudeOnceAsync(state, request, sessionId, prompt, resume: true);
            if (runResult.SessionNotFound)
            {
                AppendSystemLog(state, request, "未找到会话，创建新会话…");
                runResult = await RunClaudeOnceAsync(state, request, sessionId, prompt, resume: false);
            }

            if (runResult.Cancelled || IsCancelRequested(state))
            {
                MarkFinalIfNeeded(state, request, "TASK_STATE_CANCELLED", "已取消");
                return;
            }

            if (!string.IsNullOrWhiteSpace(runResult.FailureMessage))
            {
                MarkFinalIfNeeded(state, request, "TASK_STATE_FAILED", runResult.FailureMessage);
                return;
            }

            if (!IsFinal(state))
            {
                var full = state.AssistantText.ToString();
                MarkFinalIfNeeded(
                    state,
                    request,
                    "TASK_STATE_COMPLETED",
                    string.IsNullOrWhiteSpace(full) ? "完成（无文本输出）" : full);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "A2A task {TaskId} (Claude) failed.", request.TaskId);
            MarkFinalIfNeeded(state, request, "TASK_STATE_FAILED", ex.Message);
        }
        finally
        {
            sessionLock.Release();
        }
    }

    private sealed record ClaudeRunResult(
        bool SessionNotFound,
        bool Cancelled,
        string? FailureMessage);

    private async Task<ClaudeRunResult> RunClaudeOnceAsync(
        A2aTaskState state,
        A2aTaskStartRequest request,
        string sessionId,
        string prompt,
        bool resume)
    {
        var startInfo = CreateClaudeStartInfo(request, sessionId, prompt, resume);
        using var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true,
        };

        try
        {
            if (!process.Start())
            {
                return new ClaudeRunResult(SessionNotFound: false, Cancelled: false,
                    FailureMessage: "Failed to start claude.");
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return new ClaudeRunResult(SessionNotFound: false, Cancelled: false, FailureMessage: ex.Message);
        }

        lock (state.Sync)
        {
            state.ActiveProcess = process;
        }

        using var stderrCts = new CancellationTokenSource();
        var stderrTask = Task.Run(
            () => PumpClaudeStderrAsync(state, request, process.StandardError, stderrCts.Token),
            CancellationToken.None);

        var sawAnyJson = false;
        var sawAnyTextDelta = false;

        try
        {
            while (true)
            {
                if (IsCancelRequested(state))
                {
                    TryKillProcess(process);
                    return new ClaudeRunResult(SessionNotFound: false, Cancelled: true, FailureMessage: null);
                }

                string? line;
                try
                {
                    line = await process.StandardOutput.ReadLineAsync();
                }
                catch (Exception ex) when (ex is IOException or ObjectDisposedException)
                {
                    _logger.LogDebug(ex, "Claude stdout read failed for task {TaskId}.", request.TaskId);
                    break;
                }

                if (line is null)
                {
                    break;
                }

                var trimmed = line.Trim();
                if (trimmed.Length == 0)
                {
                    continue;
                }

                if (!sawAnyJson && LooksLikeClaudeSessionNotFound(trimmed))
                {
                    return new ClaudeRunResult(SessionNotFound: true, Cancelled: false, FailureMessage: trimmed);
                }

                try
                {
                    using var doc = JsonDocument.Parse(trimmed);
                    sawAnyJson = true;
                    HandleClaudeStreamLine(state, request, doc.RootElement, ref sawAnyTextDelta);
                    if (IsFinal(state))
                    {
                        break;
                    }
                }
                catch (JsonException)
                {
                    var preview = trimmed.Length > 4000 ? trimmed[..4000] + "…(truncated)…" : trimmed;
                    AppendSystemLog(state, request, $"[claude] {preview}");
                }
            }

            try
            {
                await process.WaitForExitAsync(CancellationToken.None);
            }
            catch
            {
                // ignore
            }

            if (IsCancelRequested(state))
            {
                return new ClaudeRunResult(SessionNotFound: false, Cancelled: true, FailureMessage: null);
            }

            if (process.ExitCode != 0 && !IsFinal(state))
            {
                return new ClaudeRunResult(
                    SessionNotFound: false,
                    Cancelled: false,
                    FailureMessage: $"claude exited with code {process.ExitCode}.");
            }

            return new ClaudeRunResult(SessionNotFound: false, Cancelled: false, FailureMessage: null);
        }
        finally
        {
            stderrCts.Cancel();
            try
            {
                await stderrTask;
            }
            catch
            {
                // ignore
            }

            lock (state.Sync)
            {
                if (ReferenceEquals(state.ActiveProcess, process))
                {
                    state.ActiveProcess = null;
                }
            }
        }
    }

    private void HandleClaudeStreamLine(
        A2aTaskState state,
        A2aTaskStartRequest request,
        JsonElement root,
        ref bool sawAnyTextDelta)
    {
        var type = TryReadString(root, "type") ?? string.Empty;

        if (string.Equals(type, "stream_event", StringComparison.OrdinalIgnoreCase))
        {
            var ev = TryGetObject(root, "event");
            var evType = TryReadString(ev, "type") ?? string.Empty;
            if (!string.Equals(evType, "content_block_delta", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            var delta = TryGetObject(ev, "delta");
            var deltaType = TryReadString(delta, "type") ?? string.Empty;

            var textDelta = string.Equals(deltaType, "text_delta", StringComparison.OrdinalIgnoreCase)
                ? TryReadString(delta, "text")
                : TryReadString(delta, "text");

            if (!string.IsNullOrWhiteSpace(textDelta))
            {
                lock (state.Sync)
                {
                    state.AssistantText.Append(textDelta);
                }

                sawAnyTextDelta = true;
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
                                parts = new[] { new { text = textDelta } },
                            },
                            final: false),
                    });
            }

            var thinkingDelta = string.Equals(deltaType, "thinking_delta", StringComparison.OrdinalIgnoreCase)
                ? TryReadString(delta, "thinking")
                : TryReadString(delta, "thinking");

            if (!string.IsNullOrWhiteSpace(thinkingDelta))
            {
                lock (state.Sync)
                {
                    state.ReasoningText.Append(thinkingDelta);
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
                            text: thinkingDelta,
                            append: true,
                            lastChunk: false),
                    });
            }

            return;
        }

        if (string.Equals(type, "assistant", StringComparison.OrdinalIgnoreCase))
        {
            if (sawAnyTextDelta)
            {
                return;
            }

            var message = TryGetObject(root, "message");
            if (message.ValueKind != JsonValueKind.Object
                || !message.TryGetProperty("content", out var content)
                || content.ValueKind != JsonValueKind.Array)
            {
                return;
            }

            foreach (var part in content.EnumerateArray())
            {
                if (part.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var partType = TryReadString(part, "type") ?? string.Empty;

                if (string.Equals(partType, "thinking", StringComparison.OrdinalIgnoreCase))
                {
                    var thinking = TryReadString(part, "thinking") ?? string.Empty;
                    if (!string.IsNullOrWhiteSpace(thinking))
                    {
                        lock (state.Sync)
                        {
                            if (state.ReasoningText.Length == 0)
                            {
                                state.ReasoningText.Append(thinking);
                            }
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
                                    text: thinking,
                                    append: false,
                                    lastChunk: true),
                            });
                    }

                    continue;
                }

                if (!string.Equals(partType, "text", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var text = TryReadString(part, "text") ?? string.Empty;
                if (string.IsNullOrWhiteSpace(text))
                {
                    continue;
                }

                lock (state.Sync)
                {
                    if (state.AssistantText.Length == 0)
                    {
                        state.AssistantText.Append(text);
                    }
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
                                parts = new[] { new { text } },
                            },
                            final: false),
                    });
            }

            return;
        }

        if (string.Equals(type, "result", StringComparison.OrdinalIgnoreCase))
        {
            var isError = root.TryGetProperty("is_error", out var isErrorProp)
                          && isErrorProp.ValueKind == JsonValueKind.True;

            var resultText = TryReadString(root, "result") ?? string.Empty;

            if (!string.IsNullOrWhiteSpace(resultText))
            {
                lock (state.Sync)
                {
                    state.AssistantText.Clear();
                    state.AssistantText.Append(resultText);
                }
            }

            if (TryBuildClaudeTokenUsageArtifact(root, out var tokenUsageObject))
            {
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
            }

            var mapped = isError ? "TASK_STATE_FAILED" : "TASK_STATE_COMPLETED";
            var messageText = string.IsNullOrWhiteSpace(resultText)
                ? isError
                    ? "任务失败"
                    : "完成（无文本输出）"
                : resultText;

            MarkFinalIfNeeded(state, request, mapped, messageText);
        }
    }

    private static bool TryBuildClaudeTokenUsageArtifact(JsonElement root, [NotNullWhen(true)] out object? tokenUsage)
    {
        tokenUsage = null;

        static object Build(int inputTokens, int cachedInputTokens, int outputTokens, int? contextWindow)
        {
            var last = new Dictionary<string, object?>
            {
                ["inputTokens"] = inputTokens,
                ["cachedInputTokens"] = cachedInputTokens,
                ["outputTokens"] = outputTokens,
                ["totalTokens"] = inputTokens + outputTokens,
            };

            var envelope = new Dictionary<string, object?>
            {
                ["last"] = last,
            };

            if (contextWindow is not null)
            {
                envelope["modelContextWindow"] = contextWindow.Value;
            }

            return envelope;
        }

        if (root.TryGetProperty("modelUsage", out var modelUsage) && modelUsage.ValueKind == JsonValueKind.Object)
        {
            foreach (var item in modelUsage.EnumerateObject())
            {
                if (item.Value.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var usage = item.Value;
                var inputTokens = TryReadInt(usage, "inputTokens") ?? 0;
                var outputTokens = TryReadInt(usage, "outputTokens") ?? 0;
                var cachedTokens = TryReadInt(usage, "cacheReadInputTokens") ?? 0;
                var contextWindow = TryReadInt(usage, "contextWindow");

                tokenUsage = Build(inputTokens, cachedTokens, outputTokens, contextWindow);
                return true;
            }
        }

        if (root.TryGetProperty("usage", out var legacyUsage) && legacyUsage.ValueKind == JsonValueKind.Object)
        {
            var inputTokens = TryReadInt(legacyUsage, "input_tokens") ?? 0;
            var outputTokens = TryReadInt(legacyUsage, "output_tokens") ?? 0;
            var cachedTokens = TryReadInt(legacyUsage, "cache_read_input_tokens") ?? 0;
            tokenUsage = Build(inputTokens, cachedTokens, outputTokens, contextWindow: null);
            return true;
        }

        return false;
    }

    private static int? TryReadInt(JsonElement element, params string[] path)
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

        if (current.ValueKind == JsonValueKind.Number && current.TryGetInt32(out var number))
        {
            return number;
        }

        if (current.ValueKind == JsonValueKind.String
            && int.TryParse(current.GetString(), out number))
        {
            return number;
        }

        return null;
    }

    private static bool LooksLikeClaudeSessionNotFound(string line)
        => line.StartsWith("No conversation found with session ID:", StringComparison.OrdinalIgnoreCase)
           || line.StartsWith("No conversation found with session ID", StringComparison.OrdinalIgnoreCase);

    private static string NormalizeClaudeSessionId(string contextId)
    {
        var trimmed = (contextId ?? string.Empty).Trim();
        if (Guid.TryParse(trimmed, out var parsed))
        {
            return parsed.ToString("D");
        }

        if (trimmed.Length == 0)
        {
            return Guid.NewGuid().ToString("D");
        }

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(trimmed));
        Span<byte> bytes = stackalloc byte[16];
        hash.AsSpan(0, 16).CopyTo(bytes);

        // v4
        bytes[6] = (byte)((bytes[6] & 0x0F) | 0x40);
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);

        return new Guid(bytes).ToString("D");
    }

    private static string? TryResolveClaudeCliJsPath()
    {
        if (!OperatingSystem.IsWindows())
        {
            return null;
        }

        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        var candidates = new[]
        {
            Path.Combine(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
            Path.Combine(localAppData, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
        };

        foreach (var candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
            catch
            {
                // ignore
            }
        }

        return null;
    }

    private ProcessStartInfo CreateClaudeStartInfo(
        A2aTaskStartRequest request,
        string sessionId,
        string prompt,
        bool resume)
    {
        var utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

        var startInfo = new ProcessStartInfo
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WorkingDirectory = request.Cwd,
            StandardOutputEncoding = utf8,
            StandardErrorEncoding = utf8,
        };

        var configuredExecutable = (_configuration["Claude:ExecutablePath"] ?? string.Empty).Trim();

        if (OperatingSystem.IsWindows())
        {
            if (!string.IsNullOrWhiteSpace(configuredExecutable))
            {
                var ext = Path.GetExtension(configuredExecutable);
                if (string.Equals(ext, ".js", StringComparison.OrdinalIgnoreCase))
                {
                    startInfo.FileName = "node";
                    startInfo.ArgumentList.Add(configuredExecutable);
                }
                else if (string.Equals(ext, ".cmd", StringComparison.OrdinalIgnoreCase)
                         || string.Equals(ext, ".bat", StringComparison.OrdinalIgnoreCase))
                {
                    startInfo.FileName = "cmd.exe";
                    startInfo.ArgumentList.Add("/c");
                    startInfo.ArgumentList.Add(configuredExecutable);
                }
                else
                {
                    startInfo.FileName = configuredExecutable;
                }
            }
            else
            {
                var cliJs = TryResolveClaudeCliJsPath();
                if (!string.IsNullOrWhiteSpace(cliJs))
                {
                    startInfo.FileName = "node";
                    startInfo.ArgumentList.Add(cliJs);
                }
                else
                {
                    // Fallback: run via `cmd.exe /c` so the `.cmd` shim can be resolved.
                    startInfo.FileName = "cmd.exe";
                    startInfo.ArgumentList.Add("/c");
                    startInfo.ArgumentList.Add("claude");
                }
            }
        }
        else
        {
            startInfo.FileName = string.IsNullOrWhiteSpace(configuredExecutable) ? "claude" : configuredExecutable;
        }

        startInfo.ArgumentList.Add("--print");
        startInfo.ArgumentList.Add("--output-format");
        startInfo.ArgumentList.Add("stream-json");
        startInfo.ArgumentList.Add("--include-partial-messages");
        startInfo.ArgumentList.Add("--dangerously-skip-permissions");
        startInfo.ArgumentList.Add("--add-dir");
        startInfo.ArgumentList.Add(request.Cwd);

        if (!string.IsNullOrWhiteSpace(request.Model))
        {
            startInfo.ArgumentList.Add("--model");
            startInfo.ArgumentList.Add(request.Model!);
        }

        if (resume)
        {
            startInfo.ArgumentList.Add("--resume");
            startInfo.ArgumentList.Add(sessionId);
        }
        else
        {
            startInfo.ArgumentList.Add("--session-id");
            startInfo.ArgumentList.Add(sessionId);
        }

        startInfo.ArgumentList.Add(prompt);

        if (!string.IsNullOrWhiteSpace(request.ProviderApiKey))
        {
            startInfo.Environment["ANTHROPIC_API_KEY"] = request.ProviderApiKey!;
        }

        if (!string.IsNullOrWhiteSpace(request.ProviderAddress))
        {
            startInfo.Environment["ANTHROPIC_BASE_URL"] = request.ProviderAddress!;
        }

        var gitBash = ResolveClaudeGitBashPath();
        if (!string.IsNullOrWhiteSpace(gitBash))
        {
            startInfo.Environment["CLAUDE_CODE_GIT_BASH_PATH"] = gitBash;
        }

        return startInfo;
    }

    private string? ResolveClaudeGitBashPath()
    {
        static string? Clean(string? raw)
        {
            var trimmed = (raw ?? string.Empty).Trim();
            if (trimmed.Length == 0)
            {
                return null;
            }

            trimmed = trimmed.Trim('"');
            return trimmed.Length == 0 ? null : trimmed;
        }

        var configured = Clean(_configuration["Claude:GitBashPath"]);
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured))
        {
            return configured;
        }

        var fromEnv = Clean(Environment.GetEnvironmentVariable("CLAUDE_CODE_GIT_BASH_PATH"));
        if (!string.IsNullOrWhiteSpace(fromEnv) && File.Exists(fromEnv))
        {
            return fromEnv;
        }

        if (!OperatingSystem.IsWindows())
        {
            return null;
        }

        var pathVar = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var entry in pathVar.Split(';',
                     StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var dir = entry.Trim().Trim('"');
            if (string.IsNullOrWhiteSpace(dir))
            {
                continue;
            }

            try
            {
                var candidate = Path.Combine(dir, "bash.exe");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
            catch
            {
                // ignore
            }
        }

        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);

        var common = new[]
        {
            Path.Combine(programFiles, "Git", "bin", "bash.exe"),
            Path.Combine(programFiles, "Git", "usr", "bin", "bash.exe"),
            Path.Combine(programFilesX86, "Git", "bin", "bash.exe"),
            Path.Combine(programFilesX86, "Git", "usr", "bin", "bash.exe"),
        };

        foreach (var candidate in common.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
            catch
            {
                // ignore
            }
        }

        return null;
    }

    private static string BuildClaudePrompt(string userText, IReadOnlyList<A2aImageInput> images)
    {
        var text = (userText ?? string.Empty).Trim();
        if (images.Count == 0)
        {
            return text;
        }

        var sb = new StringBuilder();
        if (!string.IsNullOrWhiteSpace(text))
        {
            sb.AppendLine(text);
            sb.AppendLine();
        }

        sb.AppendLine("Attached images:");
        foreach (var img in images)
        {
            var url = (img.Url ?? string.Empty).Trim();
            if (!string.IsNullOrWhiteSpace(url))
            {
                sb.Append("- ");
                sb.AppendLine(url);
            }
        }

        return sb.ToString().Trim();
    }

    private async Task PumpClaudeStderrAsync(
        A2aTaskState state,
        A2aTaskStartRequest request,
        StreamReader reader,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            string? line;
            try
            {
                line = await reader.ReadLineAsync(cancellationToken);
            }
            catch
            {
                break;
            }

            if (line is null)
            {
                break;
            }

            var text = $"{line}\n";
            lock (state.Sync)
            {
                state.ToolOutputText.Append(text);
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
                        text,
                        append: true,
                        lastChunk: false),
                });
        }
    }

    private static void TryKillProcess(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // ignore
        }
    }

    private async Task PumpCodexEventsAsync(
        A2aTaskState state,
        A2aTaskStartRequest request,
        ChannelReader<CodexAppServerEvent> events,
        CancellationToken cancellationToken)
    {
        var assistantText = state.AssistantText;
        var reasoningText = state.ReasoningText;
        var toolOutputText = state.ToolOutputText;

        await foreach (var ev in events.ReadAllAsync(cancellationToken))
        {
            if (IsFinal(state))
            {
                return;
            }

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

            string? expectedThreadId;
            string? expectedTurnId;
            lock (state.Sync)
            {
                expectedThreadId = state.ThreadId;
                expectedTurnId = state.TurnId;
            }

            if (!string.IsNullOrWhiteSpace(expectedThreadId)
                && !string.IsNullOrWhiteSpace(notification.Meta.ThreadId)
                && !string.Equals(notification.Meta.ThreadId, expectedThreadId, StringComparison.Ordinal))
            {
                continue;
            }

            if (!string.IsNullOrWhiteSpace(expectedTurnId)
                && !string.IsNullOrWhiteSpace(notification.Meta.TurnId)
                && !string.Equals(notification.Meta.TurnId, expectedTurnId, StringComparison.Ordinal))
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
                    var messageText = fullAssistant;

                    if (string.IsNullOrWhiteSpace(messageText))
                    {
                        messageText = mapped switch
                        {
                            "TASK_STATE_FAILED" => TryReadString(TryGetObject(turn, "error"), "message")
                                                   ?? "任务失败",
                            "TASK_STATE_CANCELLED" => "已取消",
                            _ => "完成（无文本输出）",
                        };
                    }

                    MarkFinalIfNeeded(state, request, mapped, messageText);
                    return;
                }
            }
        }
    }

    private static void SetTaskState(A2aTaskState state, string taskState)
    {
        lock (state.Sync)
        {
            state.State = taskState;
        }
    }

    private static bool IsFinal(A2aTaskState state)
    {
        lock (state.Sync)
        {
            return state.Final;
        }
    }

    private static bool IsCancelRequested(A2aTaskState state)
    {
        lock (state.Sync)
        {
            return state.CancelRequested;
        }
    }

    private void AppendSystemLog(A2aTaskState state, A2aTaskStartRequest request, string message)
    {
        var line = $"{DateTimeOffset.UtcNow:O} [onecode] {message}\n";
        lock (state.Sync)
        {
            state.ToolOutputText.Append(line);
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
                    text: line,
                    append: true,
                    lastChunk: false),
            });
    }

    private void MarkFinalIfNeeded(A2aTaskState state, A2aTaskStartRequest request, string mappedState,
        string messageText)
    {
        var shouldAppend = false;
        lock (state.Sync)
        {
            if (!state.Final)
            {
                state.State = mappedState;
                state.Final = true;
                shouldAppend = true;
            }
        }

        if (!shouldAppend)
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
                    state: mappedState,
                    message: new
                    {
                        role = "agent",
                        messageId = request.AgentMessageId,
                        taskId = request.TaskId,
                        contextId = request.ContextId,
                        parts = new[] { new { text = messageText } },
                    },
                    final: true),
            },
            markFinal: true);
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

    private static List<object> BuildTurnInputs(A2aTaskStartRequest request)
    {
        var inputs = new List<object>();

        var text = (request.UserText ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(text))
        {
            inputs.Add(new { type = "text", text });
        }

        var images = request.UserImages ?? Array.Empty<A2aImageInput>();
        foreach (var image in images)
        {
            if (TryResolveLocalImagePath(image, out var localPath))
            {
                inputs.Add(new { type = "localImage", path = localPath });
                continue;
            }

            var url = (image.Url ?? string.Empty).Trim();
            if (!string.IsNullOrWhiteSpace(url))
            {
                inputs.Add(new { type = "image", url });
            }
        }

        if (inputs.Count == 0)
        {
            inputs.Add(new { type = "text", text = " " });
        }

        return inputs;
    }

    private static bool TryResolveLocalImagePath(A2aImageInput image, out string path)
    {
        path = string.Empty;

        var id = (image.Id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(id))
        {
            id = TryExtractImageIdFromUrl(image.Url) ?? string.Empty;
        }

        if (string.IsNullOrWhiteSpace(id) || !Guid.TryParseExact(id, "N", out _))
        {
            return false;
        }

        var root = GetImagesRoot();
        if (!Directory.Exists(root))
        {
            return false;
        }

        var candidates = new[]
        {
            Path.Combine(root, id),
            Path.Combine(root, $"{id}.png"),
            Path.Combine(root, $"{id}.jpg"),
            Path.Combine(root, $"{id}.jpeg"),
            Path.Combine(root, $"{id}.webp"),
            Path.Combine(root, $"{id}.gif"),
        };

        foreach (var candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (File.Exists(candidate))
            {
                path = candidate;
                return true;
            }
        }

        return false;
    }

    private static string GetImagesRoot()
    {
        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(userProfile, ".one-code", "media", "images");
    }

    private static string? TryExtractImageIdFromUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            return null;
        }

        if (!Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri))
        {
            return null;
        }

        var segments = uri.AbsolutePath
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        if (segments.Length < 3)
        {
            return null;
        }

        if (!string.Equals(segments[^3], "media", StringComparison.OrdinalIgnoreCase)
            || !string.Equals(segments[^2], "images", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var id = segments[^1];
        return Guid.TryParseExact(id, "N", out _) ? id : null;
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

public sealed record A2aImageInput(
    string? Id,
    string? Url);

public sealed record A2aTaskStartRequest(
    string TaskId,
    string ContextId,
    string Cwd,
    string UserText,
    IReadOnlyList<A2aImageInput> UserImages,
    string UserMessageId,
    string AgentMessageId,
    ToolType ToolType = ToolType.Codex,
    string? Model = null,
    string? ProviderAddress = null,
    string? ProviderApiKey = null);

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
    public ToolType ToolType { get; set; } = ToolType.Codex;

    public bool Started { get; set; }
    public bool Final { get; set; }
    public string State { get; set; } = "TASK_STATE_SUBMITTED";

    public string? ThreadId { get; set; }
    public string? TurnId { get; set; }

    public bool CancelRequested { get; set; }
    public Task? RunningTask { get; set; }
    public Process? ActiveProcess { get; set; }

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
