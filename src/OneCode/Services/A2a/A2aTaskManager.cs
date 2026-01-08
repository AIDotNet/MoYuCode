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

    public bool TrySubmitAskUserQuestion(
        string taskId,
        string toolUseId,
        IReadOnlyDictionary<string, string> answers,
        [NotNullWhen(false)] out string? error)
    {
        error = null;

        if (string.IsNullOrWhiteSpace(taskId))
        {
            error = "Missing taskId.";
            return false;
        }

        if (string.IsNullOrWhiteSpace(toolUseId))
        {
            error = "Missing toolUseId.";
            return false;
        }

        if (!_tasks.TryGetValue(taskId, out var state))
        {
            error = "Task not found.";
            return false;
        }

        StreamWriter? writer;
        lock (state.Sync)
        {
            if (state.ToolType != ToolType.ClaudeCode)
            {
                error = "Task is not a Claude Code task.";
                return false;
            }

            writer = state.ClaudeInput;
        }

        if (writer is null)
        {
            error = "Claude input stream is not available.";
            return false;
        }

        var formatted = answers.Count == 0
            ? "User has answered your questions. You can now continue with the user's answers in mind."
            : $"User has answered your questions: {string.Join(", ", answers.Select(kvp => $"\"{kvp.Key}\"=\"{kvp.Value}\""))}. You can now continue with the user's answers in mind.";

        var toolResult = new Dictionary<string, object?>
        {
            ["type"] = "tool_result",
            ["tool_use_id"] = toolUseId,
            ["content"] = formatted,
            ["is_error"] = false,
        };

        var message = new Dictionary<string, object?>
        {
            ["type"] = "user",
            ["message"] = new Dictionary<string, object?>
            {
                ["role"] = "user",
                ["content"] = new object[] { toolResult },
            },
        };

        try
        {
            writer.WriteLine(JsonSerializer.Serialize(message, _jsonOptions));
            writer.Flush();
            return true;
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException)
        {
            error = ex.Message;
            return false;
        }
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

        AppendSystemLog(
            state,
            request,
            request.ToolType == ToolType.ClaudeCode ? "工具类型：Claude Code" : "工具类型：Codex");

        _logger.LogInformation(
            "A2A task submitted. TaskId={TaskId} ToolType={ToolType} ContextId={ContextId} Cwd={Cwd}",
            request.TaskId,
            request.ToolType,
            request.ContextId,
            request.Cwd);

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

        _logger.LogInformation(
            "A2A task cancel requested. TaskId={TaskId} ToolType={ToolType}",
            taskId,
            toolType);

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

                _logger.LogInformation("A2A task cancelled. TaskId={TaskId}", taskId);
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

            _logger.LogInformation("A2A task interruption requested. TaskId={TaskId}", taskId);
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
            _logger.LogInformation(
                "A2A task starting Codex turn. TaskId={TaskId} ContextId={ContextId} Cwd={Cwd} Model={Model}",
                request.TaskId,
                request.ContextId,
                request.Cwd,
                request.Model);

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
            if (request.ProviderId.HasValue && !string.IsNullOrWhiteSpace(request.ProviderApiKey))
            {
                await _codexClient.EnsureProviderKeyAsync(
                    request.ProviderId.Value,
                    request.ProviderApiKey!,
                    CancellationToken.None);
            }
            var modelProvider = GetCodexModelProvider(request);
            if (!string.IsNullOrWhiteSpace(modelProvider))
            {
                await UpsertCodexModelProviderAsync(modelProvider, request, CancellationToken.None);
            }

            var thread = await _codexSessionManager.GetOrCreateThreadAsync(
                request.ContextId,
                request.Cwd,
                modelProvider,
                CancellationToken.None);

            lock (state.Sync)
            {
                state.ThreadId = thread.ThreadId;
            }

            _logger.LogInformation(
                "A2A task Codex thread ready. TaskId={TaskId} ThreadId={ThreadId}",
                request.TaskId,
                thread.ThreadId);

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

            _logger.LogInformation(
                "A2A task Codex turn started. TaskId={TaskId} TurnId={TurnId}",
                request.TaskId,
                turnId);

            AppendSystemLog(state, request, $"Turn 已开始：{turnId}");

            if (ShouldInterruptAfterStart(state))
            {
                _logger.LogInformation(
                    "A2A task Codex turn interrupted after start. TaskId={TaskId} TurnId={TurnId}",
                    request.TaskId,
                    turnId);
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

    private static string? GetCodexModelProvider(A2aTaskStartRequest request)
    {
        if (!request.ProviderId.HasValue)
        {
            return null;
        }

        var baseKey = $"onecode-{request.ProviderId.Value:N}";
        if (!request.ProviderRequestType.HasValue)
        {
            return baseKey;
        }

        var suffix = request.ProviderRequestType.Value.ToString();
        if (string.IsNullOrWhiteSpace(suffix))
        {
            return baseKey;
        }

        return $"{baseKey}-{suffix.ToLowerInvariant()}";
    }

    private async Task UpsertCodexModelProviderAsync(
        string modelProvider,
        A2aTaskStartRequest request,
        CancellationToken cancellationToken)
    {
        if (request.ToolType != ToolType.Codex)
        {
            return;
        }

        if (!request.ProviderId.HasValue)
        {
            return;
        }

        if (request.ProviderRequestType is null)
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(request.ProviderAddress))
        {
            return;
        }

        var envKeyName = $"ONECODE_API_KEY_{request.ProviderId.Value:N}";

        var edits = new List<object>
        {
            new
            {
                keyPath = $"model_providers.{modelProvider}.name",
                mergeStrategy = "replace",
                value = "OneCode",
            },
            new
            {
                keyPath = $"model_providers.{modelProvider}.base_url",
                mergeStrategy = "replace",
                value = request.ProviderAddress.Trim(),
            },
        };

        switch (request.ProviderRequestType.Value)
        {
            case ProviderRequestType.OpenAI:
                edits.Add(new
                {
                    keyPath = $"model_providers.{modelProvider}.wire_api",
                    mergeStrategy = "replace",
                    value = "chat",
                });
                edits.Add(new
                {
                    keyPath = $"model_providers.{modelProvider}.env_key",
                    mergeStrategy = "replace",
                    value = envKeyName,
                });
                break;

            case ProviderRequestType.OpenAIResponses:
                edits.Add(new
                {
                    keyPath = $"model_providers.{modelProvider}.wire_api",
                    mergeStrategy = "replace",
                    value = "responses",
                });
                edits.Add(new
                {
                    keyPath = $"model_providers.{modelProvider}.env_key",
                    mergeStrategy = "replace",
                    value = envKeyName,
                });
                break;

            case ProviderRequestType.AzureOpenAI:
            {
                var apiVersion = string.IsNullOrWhiteSpace(request.ProviderAzureApiVersion)
                    ? "2025-04-01-preview"
                    : request.ProviderAzureApiVersion.Trim();

                edits.Add(new
                {
                    keyPath = $"model_providers.{modelProvider}.wire_api",
                    mergeStrategy = "replace",
                    value = "responses",
                });
                edits.Add(new
                {
                    keyPath = $"model_providers.{modelProvider}.env_http_headers",
                    mergeStrategy = "replace",
                    value = new Dictionary<string, string>(StringComparer.Ordinal)
                    {
                        ["api-key"] = envKeyName,
                    },
                });
                edits.Add(new
                {
                    keyPath = $"model_providers.{modelProvider}.query_params",
                    mergeStrategy = "replace",
                    value = new Dictionary<string, string>(StringComparer.Ordinal)
                    {
                        ["api-version"] = apiVersion,
                    },
                });
                break;
            }

            case ProviderRequestType.Anthropic:
            default:
                return;
        }

        await _codexClient.CallAsync(
            method: "config/batchWrite",
            @params: new
            {
                edits,
            },
            cancellationToken);
    }

    private async Task RunClaudeTurnAsync(A2aTaskState state, A2aTaskStartRequest request)
    {
        var sessionId = NormalizeClaudeSessionId(request.ContextId);
        var sessionLock = _claudeSessionLocks.GetOrAdd(sessionId, _ => new SemaphoreSlim(1, 1));
        await sessionLock.WaitAsync(CancellationToken.None);

        try
        {
            _logger.LogInformation(
                "A2A task starting Claude turn. TaskId={TaskId} ContextId={ContextId} SessionId={SessionId} Cwd={Cwd}",
                request.TaskId,
                request.ContextId,
                sessionId,
                request.Cwd);

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
                _logger.LogInformation(
                    "A2A task Claude session not found. TaskId={TaskId} SessionId={SessionId}",
                    request.TaskId,
                    sessionId);
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
        _logger.LogInformation(
            "A2A task launching Claude Code. TaskId={TaskId} SessionId={SessionId} Resume={Resume}",
            request.TaskId,
            sessionId,
            resume);

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

        process.StandardInput.AutoFlush = true;
        lock (state.Sync)
        {
            state.ClaudeInput = process.StandardInput;
        }

        var userMessage = new Dictionary<string, object?>
        {
            ["type"] = "user",
            ["message"] = new Dictionary<string, object?>
            {
                ["role"] = "user",
                ["content"] = prompt,
            },
        };

        try
        {
            await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(userMessage, _jsonOptions));
            await process.StandardInput.FlushAsync();
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException)
        {
            return new ClaudeRunResult(SessionNotFound: false, Cancelled: false, FailureMessage: ex.Message);
        }

        string? lastStderrLine = null;
        string? sessionNotFoundLineFromStderr = null;

        void OnStderrLine(string line)
        {
            Interlocked.Exchange(ref lastStderrLine, line);

            var trimmed = line.Trim();
            if (trimmed.Length == 0)
            {
                return;
            }

            if (LooksLikeClaudeSessionNotFound(trimmed))
            {
                Interlocked.CompareExchange(ref sessionNotFoundLineFromStderr, trimmed, comparand: null);
            }
        }

        using var stderrCts = new CancellationTokenSource();
        var stderrTask = Task.Run(
            () => PumpClaudeStderrAsync(state, request, process.StandardError, OnStderrLine, stderrCts.Token),
            CancellationToken.None);

        var sawAnyTextDelta = false;
        var toolStreamState = new ClaudeToolStreamState();

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

                if (LooksLikeClaudeSessionNotFound(trimmed))
                {
                    if (resume)
                    {
                        return new ClaudeRunResult(SessionNotFound: true, Cancelled: false, FailureMessage: trimmed);
                    }

                    return new ClaudeRunResult(SessionNotFound: false, Cancelled: false, FailureMessage: trimmed);
                }

                try
                {
                    using var doc = JsonDocument.Parse(trimmed);
                    HandleClaudeStreamLine(state, request, doc.RootElement, toolStreamState, ref sawAnyTextDelta);
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

            lock (state.Sync)
            {
                if (ReferenceEquals(state.ClaudeInput, process.StandardInput))
                {
                    state.ClaudeInput = null;
                }
            }

            try
            {
                process.StandardInput.Close();
            }
            catch
            {
                // ignore
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

            var stderrSessionNotFound = Volatile.Read(ref sessionNotFoundLineFromStderr);
            if (!string.IsNullOrWhiteSpace(stderrSessionNotFound) && !IsFinal(state))
            {
                if (resume)
                {
                    return new ClaudeRunResult(
                        SessionNotFound: true,
                        Cancelled: false,
                        FailureMessage: stderrSessionNotFound);
                }

                return new ClaudeRunResult(
                    SessionNotFound: false,
                    Cancelled: false,
                    FailureMessage: stderrSessionNotFound);
            }

            if (process.ExitCode != 0 && !IsFinal(state))
            {
                var stderrLast = Volatile.Read(ref lastStderrLine);
                var trimmedStderrLast = (stderrLast ?? string.Empty).Trim();
                var suffix = string.IsNullOrWhiteSpace(trimmedStderrLast) ? string.Empty : $" Last stderr: {trimmedStderrLast}";

                return new ClaudeRunResult(
                    SessionNotFound: false,
                    Cancelled: false,
                    FailureMessage: $"claude exited with code {process.ExitCode}.{suffix}");
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

                if (ReferenceEquals(state.ClaudeInput, process.StandardInput))
                {
                    state.ClaudeInput = null;
                }
            }
        }
    }

    private sealed record ClaudeToolUseBlock(string ToolUseId, string? ToolName);

    private sealed class ClaudeToolStreamState
    {
        public Dictionary<int, ClaudeToolUseBlock> ToolUseByIndex { get; } = new();
        public Dictionary<string, StringBuilder> ToolInputByToolUseId { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, int> ToolInputSentLengthByToolUseId { get; } = new(StringComparer.Ordinal);
    }

    private void HandleClaudeStreamLine(
        A2aTaskState state,
        A2aTaskStartRequest request,
        JsonElement root,
        ClaudeToolStreamState toolStreamState,
        ref bool sawAnyTextDelta)
    {
        void AppendClaudeToolEvent(
            string kind,
            string toolUseId,
            string? toolName,
            string? input,
            string? output,
            bool? isError = null)
        {
            if (string.IsNullOrWhiteSpace(toolUseId))
            {
                return;
            }

            var payload = new Dictionary<string, object?>
            {
                ["kind"] = kind,
                ["toolUseId"] = toolUseId,
                ["toolName"] = toolName,
                ["input"] = input,
                ["output"] = output,
                ["isError"] = isError,
                ["createdAtUtc"] = DateTimeOffset.UtcNow.ToString("O"),
            };

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
                            artifactId = $"artifact-claude-tools-{request.TaskId}",
                            name = "claude-tools",
                            parts = new object[]
                            {
                                new
                                {
                                    data = payload,
                                },
                            },
                        },
                    },
                });
        }

        static string? ReadToolContentAsText(JsonElement value)
        {
            if (value.ValueKind == JsonValueKind.Undefined || value.ValueKind == JsonValueKind.Null)
            {
                return null;
            }

            if (value.ValueKind == JsonValueKind.String)
            {
                return value.GetString();
            }

            try
            {
                return JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web)
                {
                    WriteIndented = true,
                });
            }
            catch
            {
                return value.ToString();
            }
        }

        var type = TryReadString(root, "type") ?? string.Empty;

        if (string.Equals(type, "stream_event", StringComparison.OrdinalIgnoreCase))
        {
            var ev = TryGetObject(root, "event");
            var evType = TryReadString(ev, "type") ?? string.Empty;
            var contentBlockIndex = TryReadInt(ev, "index") ?? TryReadInt(ev, "content_block_index");

            if (string.Equals(evType, "content_block_start", StringComparison.OrdinalIgnoreCase))
            {
                var block = TryGetObject(ev, "content_block");
                var blockType = TryReadString(block, "type") ?? string.Empty;

                if (string.Equals(blockType, "tool_use", StringComparison.OrdinalIgnoreCase))
                {
                    var toolUseId = TryReadString(block, "id") ?? string.Empty;
                    var toolName = TryReadString(block, "name");

                    if (contentBlockIndex is not null && !string.IsNullOrWhiteSpace(toolUseId))
                    {
                        toolStreamState.ToolUseByIndex[contentBlockIndex.Value] = new ClaudeToolUseBlock(toolUseId, toolName);
                    }

                    string? input = null;
                    if (block.TryGetProperty("input", out var inputProp))
                    {
                        var isEmptyObject = inputProp.ValueKind == JsonValueKind.Object
                            && !inputProp.EnumerateObject().MoveNext();
                        if (!isEmptyObject)
                        {
                            input = ReadToolContentAsText(inputProp);
                        }
                    }

                    if (!string.IsNullOrWhiteSpace(input) && !string.IsNullOrWhiteSpace(toolUseId))
                    {
                        toolStreamState.ToolInputByToolUseId[toolUseId] = new StringBuilder(input);
                    }

                    AppendClaudeToolEvent(kind: "tool_use", toolUseId, toolName, input, output: null);
                }
                else if (string.Equals(blockType, "tool_result", StringComparison.OrdinalIgnoreCase))
                {
                    var toolUseId = TryReadString(block, "tool_use_id") ?? string.Empty;
                    var output = block.TryGetProperty("content", out var outputProp) ? ReadToolContentAsText(outputProp) : null;
                    var isError = block.TryGetProperty("is_error", out var isErrorProp)
                                  && isErrorProp.ValueKind == JsonValueKind.True;

                    AppendClaudeToolEvent(kind: "tool_result", toolUseId, toolName: null, input: null, output, isError);
                }

                return;
            }

            if (string.Equals(evType, "content_block_delta", StringComparison.OrdinalIgnoreCase))
            {
                var delta = TryGetObject(ev, "delta");
                var deltaType = TryReadString(delta, "type") ?? string.Empty;

                if (string.Equals(deltaType, "input_json_delta", StringComparison.OrdinalIgnoreCase))
                {
                    if (contentBlockIndex is null)
                    {
                        return;
                    }

                    if (!toolStreamState.ToolUseByIndex.TryGetValue(contentBlockIndex.Value, out var toolBlock))
                    {
                        return;
                    }

                    var partialJson = TryReadString(delta, "partial_json")
                        ?? TryReadString(delta, "partialJson")
                        ?? TryReadString(delta, "json")
                        ?? TryReadString(delta, "delta");

                    if (string.IsNullOrWhiteSpace(partialJson))
                    {
                        return;
                    }

                    if (!toolStreamState.ToolInputByToolUseId.TryGetValue(toolBlock.ToolUseId, out var builder))
                    {
                        builder = new StringBuilder();
                        toolStreamState.ToolInputByToolUseId[toolBlock.ToolUseId] = builder;
                    }

                    builder.Append(partialJson);

                    // Stream partial tool args to the UI so it can parse incremental JSON (e.g. Edit old/new strings).
                    var length = builder.Length;
                    if (!toolStreamState.ToolInputSentLengthByToolUseId.TryGetValue(toolBlock.ToolUseId, out var lastSent))
                    {
                        lastSent = 0;
                    }

                    // Throttle to reduce UI churn: emit at most every 256 chars.
                    if (length - lastSent >= 256)
                    {
                        toolStreamState.ToolInputSentLengthByToolUseId[toolBlock.ToolUseId] = length;
                        AppendClaudeToolEvent(
                            kind: "tool_use",
                            toolUseId: toolBlock.ToolUseId,
                            toolName: toolBlock.ToolName,
                            input: builder.ToString(),
                            output: null);
                    }

                    return;
                }

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

            if (string.Equals(evType, "content_block_stop", StringComparison.OrdinalIgnoreCase))
            {
                if (contentBlockIndex is null)
                {
                    return;
                }

                if (!toolStreamState.ToolUseByIndex.TryGetValue(contentBlockIndex.Value, out var toolBlock))
                {
                    return;
                }

                if (!toolStreamState.ToolInputByToolUseId.TryGetValue(toolBlock.ToolUseId, out var builder))
                {
                    toolStreamState.ToolUseByIndex.Remove(contentBlockIndex.Value);
                    return;
                }

                var input = builder.ToString();
                if (!string.IsNullOrWhiteSpace(input))
                {
                    // Always emit the final args at stop, even if throttled earlier.
                    AppendClaudeToolEvent(
                        kind: "tool_use",
                        toolUseId: toolBlock.ToolUseId,
                        toolName: toolBlock.ToolName,
                        input: input,
                        output: null);
                }

                toolStreamState.ToolUseByIndex.Remove(contentBlockIndex.Value);
                toolStreamState.ToolInputByToolUseId.Remove(toolBlock.ToolUseId);
                toolStreamState.ToolInputSentLengthByToolUseId.Remove(toolBlock.ToolUseId);
                return;
            }

            return;
        }

        if (string.Equals(type, "assistant", StringComparison.OrdinalIgnoreCase))
        {
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

                if (string.Equals(partType, "tool_use", StringComparison.OrdinalIgnoreCase))
                {
                    var toolUseId = TryReadString(part, "id") ?? string.Empty;
                    var toolName = TryReadString(part, "name");
                    var input = part.TryGetProperty("input", out var inputProp) ? ReadToolContentAsText(inputProp) : null;
                    AppendClaudeToolEvent(kind: "tool_use", toolUseId, toolName, input, output: null);
                    continue;
                }

                if (string.Equals(partType, "tool_result", StringComparison.OrdinalIgnoreCase))
                {
                    var toolUseId = TryReadString(part, "tool_use_id") ?? string.Empty;
                    var output = part.TryGetProperty("content", out var outputProp) ? ReadToolContentAsText(outputProp) : null;
                    var isError = part.TryGetProperty("is_error", out var isErrorProp)
                                  && isErrorProp.ValueKind == JsonValueKind.True;
                    AppendClaudeToolEvent(kind: "tool_result", toolUseId, toolName: null, input: null, output, isError);
                    continue;
                }

                if (!string.Equals(partType, "text", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (sawAnyTextDelta)
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

        if (string.Equals(type, "user", StringComparison.OrdinalIgnoreCase))
        {
            var message = TryGetObject(root, "message");
            if (message.ValueKind != JsonValueKind.Object
                || !message.TryGetProperty("content", out var content)
                || content.ValueKind != JsonValueKind.Array)
            {
                return;
            }

            string? toolUseResultJson = null;
            if (root.TryGetProperty("tool_use_result", out var toolUseResultProp))
            {
                toolUseResultJson = ReadToolContentAsText(toolUseResultProp);
            }

            foreach (var part in content.EnumerateArray())
            {
                if (part.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var partType = TryReadString(part, "type") ?? string.Empty;
                if (!string.Equals(partType, "tool_result", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var toolUseId = TryReadString(part, "tool_use_id") ?? string.Empty;
                if (string.IsNullOrWhiteSpace(toolUseId))
                {
                    continue;
                }

                var output = part.TryGetProperty("content", out var outputProp) ? ReadToolContentAsText(outputProp) : null;
                var isError = part.TryGetProperty("is_error", out var isErrorProp)
                              && isErrorProp.ValueKind == JsonValueKind.True;

                string? mergedOutput = output;
                if (!string.IsNullOrWhiteSpace(toolUseResultJson))
                {
                    mergedOutput = string.IsNullOrWhiteSpace(mergedOutput)
                        ? toolUseResultJson
                        : $"{mergedOutput}\n\n{toolUseResultJson}";
                }

                AppendClaudeToolEvent(kind: "tool_result", toolUseId, toolName: null, input: null, mergedOutput, isError);
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
            RedirectStandardInput = true,
            CreateNoWindow = true,
            WorkingDirectory = request.Cwd,
            StandardOutputEncoding = utf8,
            StandardErrorEncoding = utf8,
            StandardInputEncoding = utf8,
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

        startInfo.ArgumentList.Add("--verbose");
        startInfo.ArgumentList.Add("--print");
        startInfo.ArgumentList.Add("--output-format");
        startInfo.ArgumentList.Add("stream-json");
        startInfo.ArgumentList.Add("--input-format");
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

        static bool IsWslBashShim(string candidate)
        {
            if (string.IsNullOrWhiteSpace(candidate))
            {
                return false;
            }

            try
            {
                var full = Path.GetFullPath(candidate);
                var systemBash = Path.Combine(Environment.SystemDirectory, "bash.exe");

                if (string.Equals(full, systemBash, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }

                var windowsApps = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Microsoft",
                    "WindowsApps");

                return full.StartsWith(windowsApps, StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        static int ScoreBashCandidate(string candidate)
        {
            var normalized = candidate.Replace('/', '\\');

            if (normalized.Contains("\\Git\\bin\\bash.exe", StringComparison.OrdinalIgnoreCase))
            {
                return 100;
            }

            if (normalized.Contains("\\Git\\usr\\bin\\bash.exe", StringComparison.OrdinalIgnoreCase))
            {
                return 90;
            }

            if (normalized.Contains("\\Git\\", StringComparison.OrdinalIgnoreCase))
            {
                return 80;
            }

            return 0;
        }

        static string PreferGitBinOverUsrBin(string candidate)
        {
            try
            {
                var full = Path.GetFullPath(candidate);
                var normalized = full.Replace('/', '\\');

                if (!normalized.EndsWith("\\Git\\usr\\bin\\bash.exe", StringComparison.OrdinalIgnoreCase))
                {
                    return full;
                }

                var usrBinDir = Path.GetDirectoryName(full);
                if (string.IsNullOrWhiteSpace(usrBinDir))
                {
                    return full;
                }

                var usrDir = Path.GetDirectoryName(usrBinDir);
                if (string.IsNullOrWhiteSpace(usrDir))
                {
                    return full;
                }

                var gitRoot = Path.GetDirectoryName(usrDir);
                if (string.IsNullOrWhiteSpace(gitRoot))
                {
                    return full;
                }

                var gitBin = Path.Combine(gitRoot, "bin", "bash.exe");
                return File.Exists(gitBin) ? gitBin : full;
            }
            catch
            {
                return candidate;
            }
        }

        var discovered = new List<string>();

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
                    if (!IsWslBashShim(candidate))
                    {
                        discovered.Add(candidate);
                    }
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
                    if (!IsWslBashShim(candidate))
                    {
                        discovered.Add(candidate);
                    }
                }
            }
            catch
            {
                // ignore
            }
        }

        var best = discovered
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(PreferGitBinOverUsrBin)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderByDescending(ScoreBashCandidate)
            .ThenBy(s => s, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();

        return string.IsNullOrWhiteSpace(best) ? null : best;
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
        Action<string>? onLine,
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

            try
            {
                onLine?.Invoke(line);
            }
            catch
            {
                // ignore
            }

            var trimmed = line.Trim();
            if (trimmed.Length == 0)
            {
                continue;
            }

            if (trimmed.StartsWith("@[", StringComparison.Ordinal)
                && trimmed.EndsWith("]", StringComparison.Ordinal)
                && trimmed.Contains("image", StringComparison.OrdinalIgnoreCase))
            {
                continue;
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
        var seenToolOutputs = new HashSet<string>(StringComparer.Ordinal);

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

            string? ReadTextFromContent(JsonElement item)
            {
                if (item.ValueKind != JsonValueKind.Object
                    || !item.TryGetProperty("content", out var content)
                    || content.ValueKind != JsonValueKind.Array)
                {
                    return null;
                }

                var builder = new StringBuilder();
                foreach (var part in content.EnumerateArray())
                {
                    if (part.ValueKind != JsonValueKind.Object)
                    {
                        continue;
                    }

                    var partType = TryReadString(part, "type") ?? string.Empty;
                    if (!string.Equals(partType, "text", StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    var partText = TryReadString(part, "text") ?? string.Empty;
                    builder.Append(partText);
                }

                var text = builder.ToString();
                return string.IsNullOrWhiteSpace(text) ? null : text;
            }

            void MergeAgentMessage(string? message)
            {
                if (string.IsNullOrWhiteSpace(message))
                {
                    return;
                }

                string? delta = null;
                lock (state.Sync)
                {
                    var current = assistantText.ToString();
                    if (string.IsNullOrEmpty(current))
                    {
                        assistantText.Append(message);
                        delta = message;
                    }
                    else if (message.StartsWith(current, StringComparison.Ordinal))
                    {
                        delta = message[current.Length..];
                        if (!string.IsNullOrEmpty(delta))
                        {
                            assistantText.Append(delta);
                        }
                    }
                    else if (!string.Equals(current, message, StringComparison.Ordinal))
                    {
                        assistantText.Clear();
                        assistantText.Append(message);
                    }
                }

                if (string.IsNullOrEmpty(delta))
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
            }

            string? ReadToolOutputFromResult(JsonElement result)
            {
                if (result.ValueKind != JsonValueKind.Object)
                {
                    return null;
                }

                var normalized = result;
                if (normalized.TryGetProperty("Ok", out var okValue) && okValue.ValueKind == JsonValueKind.Object)
                {
                    normalized = okValue;
                }
                else if (normalized.TryGetProperty("ok", out var okLower) && okLower.ValueKind == JsonValueKind.Object)
                {
                    normalized = okLower;
                }
                else if (normalized.TryGetProperty("Err", out var errValue) && errValue.ValueKind == JsonValueKind.Object)
                {
                    normalized = errValue;
                }
                else if (normalized.TryGetProperty("error", out var errorValue) && errorValue.ValueKind == JsonValueKind.Object)
                {
                    normalized = errorValue;
                }

                var text = ReadTextFromContent(normalized);
                if (string.IsNullOrWhiteSpace(text))
                {
                    return null;
                }

                var trimmed = text.Trim();
                if (string.IsNullOrWhiteSpace(trimmed))
                {
                    return null;
                }

                try
                {
                    using var doc = JsonDocument.Parse(trimmed);
                    var root = doc.RootElement;
                    if (root.ValueKind == JsonValueKind.Object)
                    {
                        var stdout = TryReadString(root, "stdout") ?? string.Empty;
                        var stderr = TryReadString(root, "stderr") ?? string.Empty;

                        if (!string.IsNullOrWhiteSpace(stdout) || !string.IsNullOrWhiteSpace(stderr))
                        {
                            if (!string.IsNullOrWhiteSpace(stdout) && !string.IsNullOrWhiteSpace(stderr))
                            {
                                return $"{stdout}\n{stderr}";
                            }

                            if (!string.IsNullOrWhiteSpace(stdout))
                            {
                                return stdout;
                            }

                            return stderr;
                        }
                    }
                }
                catch (JsonException)
                {
                    // Fall back to raw text.
                }

                return text;
            }

            void AppendToolOutput(string output)
            {
                if (string.IsNullOrWhiteSpace(output))
                {
                    return;
                }

                var normalized = output
                    .Replace("\r\n", "\n", StringComparison.Ordinal)
                    .Replace('\r', '\n');
                if (!normalized.EndsWith('\n'))
                {
                    normalized += "\n";
                }

                lock (state.Sync)
                {
                    toolOutputText.Append(normalized);
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
                            text: normalized,
                            append: true,
                            lastChunk: false),
                    });
            }

            void AppendToolOutputFromResult(string? callId, JsonElement result)
            {
                var output = ReadToolOutputFromResult(result);
                if (string.IsNullOrWhiteSpace(output))
                {
                    return;
                }

                var prefix = output.Length <= 256 ? output : output[..256];
                var dedupeKey = string.IsNullOrWhiteSpace(callId)
                    ? $"text:{output.Length}:{prefix}"
                    : $"call:{callId}:{output.Length}:{prefix}";

                if (!seenToolOutputs.Add(dedupeKey))
                {
                    return;
                }

                AppendToolOutput(output);
            }

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

                case "codex/event/agent_message":
                {
                    var message = TryReadString(msgParams, "msg", "message")
                        ?? TryReadString(msgParams, "msg", "text");
                    MergeAgentMessage(message);
                    break;
                }

                case "codex/event/task_complete":
                {
                    var message = TryReadString(msgParams, "msg", "last_agent_message")
                        ?? TryReadString(msgParams, "msg", "lastAgentMessage");
                    MergeAgentMessage(message);
                    break;
                }

                case "codex/event/mcp_tool_call_end":
                {
                    var msg = TryGetObject(msgParams, "msg");
                    var callId = TryReadString(msg, "call_id")
                        ?? TryReadString(msg, "callId")
                        ?? TryReadString(msg, "id");
                    var result = TryGetObject(msg, "result");
                    AppendToolOutputFromResult(callId, result);
                    break;
                }

                case "item/completed":
                {
                    var item = TryGetObject(msgParams, "item");
                    var itemType = TryReadString(item, "type") ?? string.Empty;
                    if (string.Equals(itemType, "mcpToolCall", StringComparison.OrdinalIgnoreCase))
                    {
                        var callId = TryReadString(item, "id");
                        var result = TryGetObject(item, "result");
                        AppendToolOutputFromResult(callId, result);
                        break;
                    }

                    if (string.Equals(itemType, "agentMessage", StringComparison.OrdinalIgnoreCase))
                    {
                        var message = TryReadString(item, "text") ?? ReadTextFromContent(item);
                        MergeAgentMessage(message);
                    }

                    break;
                }

                case "codex/event/item_completed":
                {
                    var item = TryGetObject(msgParams, "msg");
                    item = TryGetObject(item, "item");
                    var itemType = TryReadString(item, "type") ?? string.Empty;
                    if (string.Equals(itemType, "agentMessage", StringComparison.OrdinalIgnoreCase))
                    {
                        var message = TryReadString(item, "text") ?? ReadTextFromContent(item);
                        MergeAgentMessage(message);
                    }
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

        var preview = messageText.ReplaceLineEndings(" ");
        if (preview.Length > 200)
        {
            preview = preview[..200] + "...";
        }

        _logger.LogInformation(
            "A2A task finalized. TaskId={TaskId} State={State} MessagePreview={MessagePreview}",
            request.TaskId,
            mappedState,
            preview);

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
    Guid? ProviderId = null,
    ProviderRequestType? ProviderRequestType = null,
    string? ProviderAzureApiVersion = null,
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
    public StreamWriter? ClaudeInput { get; set; }

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
