using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;

namespace OneCode.Services.Codex;

public sealed class CodexAppServerClient : IAsyncDisposable
{
    private readonly ILogger<CodexAppServerClient> _logger;

    private readonly SemaphoreSlim _startLock = new(1, 1);
    private readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private Process? _process;
    private StreamWriter? _stdin;
    private CancellationTokenSource? _shutdownCts;
    private Task? _stdoutLoop;
    private Task? _stderrLoop;

    private int _nextRequestId;
    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonElement>> _pending = new();
    private readonly ConcurrentDictionary<Guid, Channel<CodexAppServerEvent>> _subscribers = new();

    public CodexAppServerClient(ILogger<CodexAppServerClient> logger)
    {
        _logger = logger;
    }

    public async Task EnsureStartedAsync(CancellationToken cancellationToken)
    {
        if (IsProcessHealthy())
        {
            return;
        }

        await _startLock.WaitAsync(cancellationToken);
        try
        {
            if (IsProcessHealthy())
            {
                return;
            }

            await StartProcessAsync(cancellationToken);
            await InitializeAsync(cancellationToken);
        }
        finally
        {
            _startLock.Release();
        }
    }

    public async Task<JsonElement> CallAsync(string method, object? @params, CancellationToken cancellationToken)
    {
        var response = await CallRawAsync(method, @params, cancellationToken);
        if (response.TryGetProperty("error", out var error) && error.ValueKind != JsonValueKind.Null)
        {
            throw new InvalidOperationException($"codex app-server error: {error}");
        }

        if (!response.TryGetProperty("result", out var result))
        {
            throw new InvalidOperationException("codex app-server response missing `result`.");
        }

        return result;
    }

    public async Task<JsonElement> CallRawAsync(string method, object? @params, CancellationToken cancellationToken)
    {
        await EnsureStartedAsync(cancellationToken);
        return await SendRequestAsync(method, @params, cancellationToken);
    }

    public IDisposable Subscribe(out ChannelReader<CodexAppServerEvent> reader)
    {
        var channel = Channel.CreateUnbounded<CodexAppServerEvent>(
            new UnboundedChannelOptions
            {
                SingleReader = true,
                SingleWriter = false,
            });

        var id = Guid.NewGuid();
        _subscribers[id] = channel;
        reader = channel.Reader;

        return new Subscription(() => Unsubscribe(id));
    }

    private bool IsProcessHealthy()
        => _process is not null && !_process.HasExited && _stdin is not null;

    private async Task StartProcessAsync(CancellationToken cancellationToken)
    {
        await DisposeProcessAsync();

        var startInfo = CreateCodexStartInfo();

        var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true,
        };

        if (!process.Start())
        {
            throw new InvalidOperationException("Failed to start codex app-server.");
        }

        _process = process;
        _stdin = process.StandardInput;
        _shutdownCts = new CancellationTokenSource();

        _stdoutLoop = Task.Run(() => ReadStdoutLoopAsync(process, _shutdownCts.Token), CancellationToken.None);
        _stderrLoop = Task.Run(() => ReadStderrLoopAsync(process, _shutdownCts.Token), CancellationToken.None);

        process.Exited += (_, _) =>
        {
            var exitCode = process.ExitCode;
            _logger.LogWarning("codex app-server exited with code {ExitCode}.", exitCode);
            FailAllPending(new IOException($"codex app-server exited with code {exitCode}."));
            Publish(new CodexAppServerEvent.StderrLine(DateTimeOffset.UtcNow, $"[codex-exited] code={exitCode}"));
        };
    }

    private static ProcessStartInfo CreateCodexStartInfo()
    {
        var startInfo = new ProcessStartInfo
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardInputEncoding = Encoding.UTF8,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        if (OperatingSystem.IsWindows())
        {
            // `npm i -g @openai/codex` installs a `.cmd` shim under `%APPDATA%\npm`.
            // `ProcessStartInfo` cannot execute `.cmd` directly with `UseShellExecute=false`,
            // so we invoke through `cmd.exe /c`.
            var npmBin = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm");
            var codexCmd = Path.Combine(npmBin, "codex.cmd");

            startInfo.FileName = "cmd.exe";
            startInfo.ArgumentList.Add("/c");

            if (File.Exists(codexCmd))
            {
                startInfo.ArgumentList.Add(codexCmd);
            }
            else
            {
                startInfo.ArgumentList.Add("codex");
            }

            startInfo.ArgumentList.Add("app-server");

            if (Directory.Exists(npmBin))
            {
                var existingPath = startInfo.Environment.TryGetValue("PATH", out var v) ? v : null;
                existingPath ??= Environment.GetEnvironmentVariable("PATH");
                existingPath ??= string.Empty;

                if (!existingPath.Split(';', StringSplitOptions.RemoveEmptyEntries)
                        .Contains(npmBin, StringComparer.OrdinalIgnoreCase))
                {
                    startInfo.Environment["PATH"] = $"{npmBin};{existingPath}";
                }
            }

            return startInfo;
        }

        startInfo.FileName = "codex";
        startInfo.ArgumentList.Add("app-server");
        return startInfo;
    }

    private async Task InitializeAsync(CancellationToken cancellationToken)
    {
        _ = await CallAsync(
            method: "initialize",
            @params: new
            {
                clientInfo = new
                {
                    name = "onecode",
                    version = "0.0.1",
                },
            },
            cancellationToken);
    }

    private async Task<JsonElement> SendRequestAsync(string method, object? @params, CancellationToken cancellationToken)
    {
        var stdin = _stdin ?? throw new InvalidOperationException("codex app-server stdin not available.");

        var id = Interlocked.Increment(ref _nextRequestId);
        var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);

        if (!_pending.TryAdd(id, tcs))
        {
            throw new InvalidOperationException("Duplicate JSON-RPC id.");
        }

        try
        {
            var request = new JsonRpcRequest
            {
                Jsonrpc = "2.0",
                Id = id,
                Method = method,
                Params = @params,
            };

            var json = JsonSerializer.Serialize(request, _jsonOptions);
            await stdin.WriteLineAsync(json);
            await stdin.FlushAsync(cancellationToken);

            return await tcs.Task.WaitAsync(cancellationToken);
        }
        catch
        {
            _pending.TryRemove(id, out _);
            throw;
        }
    }

    private async Task ReadStdoutLoopAsync(Process process, CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested && !process.HasExited)
            {
                var line = await process.StandardOutput.ReadLineAsync().WaitAsync(cancellationToken);
                if (line is null)
                {
                    break;
                }

                HandleStdoutLine(line);
            }
        }
        catch (OperationCanceledException)
        {
            // ignore
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "codex app-server stdout loop failed.");
            Publish(new CodexAppServerEvent.StderrLine(DateTimeOffset.UtcNow, $"[stdout-loop-error] {ex.Message}"));
            FailAllPending(ex);
        }
    }

    private async Task ReadStderrLoopAsync(Process process, CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested && !process.HasExited)
            {
                var line = await process.StandardError.ReadLineAsync().WaitAsync(cancellationToken);
                if (line is null)
                {
                    break;
                }

                Publish(new CodexAppServerEvent.StderrLine(DateTimeOffset.UtcNow, line));
            }
        }
        catch (OperationCanceledException)
        {
            // ignore
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "codex app-server stderr loop failed.");
        }
    }

    private void HandleStdoutLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return;
        }

        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;

            if (root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("id", out var idProp)
                && TryGetIntId(idProp, out var id)
                && _pending.TryRemove(id, out var tcs))
            {
                tcs.TrySetResult(root.Clone());
                return;
            }

            var method = root.TryGetProperty("method", out var methodProp) && methodProp.ValueKind == JsonValueKind.String
                ? methodProp.GetString()
                : null;

            var meta = CodexAppServerMessageMeta.From(root, method);
            Publish(new CodexAppServerEvent.JsonNotification(DateTimeOffset.UtcNow, line, meta));
        }
        catch (JsonException)
        {
            Publish(new CodexAppServerEvent.StderrLine(DateTimeOffset.UtcNow, line));
        }
    }

    private void Publish(CodexAppServerEvent ev)
    {
        foreach (var channel in _subscribers.Values)
        {
            channel.Writer.TryWrite(ev);
        }
    }

    private void FailAllPending(Exception ex)
    {
        foreach (var (id, tcs) in _pending)
        {
            if (_pending.TryRemove(id, out _))
            {
                tcs.TrySetException(ex);
            }
        }
    }

    private void Unsubscribe(Guid id)
    {
        if (_subscribers.TryRemove(id, out var channel))
        {
            channel.Writer.TryComplete();
        }
    }

    private async Task DisposeProcessAsync()
    {
        try
        {
            _shutdownCts?.Cancel();
        }
        catch
        {
            // ignore
        }

        _shutdownCts?.Dispose();
        _shutdownCts = null;

        if (_process is not null)
        {
            try
            {
                if (!_process.HasExited)
                {
                    _process.Kill(entireProcessTree: true);
                }
            }
            catch
            {
                // ignore
            }

            _process.Dispose();
            _process = null;
        }

        _stdin = null;
        _stdoutLoop = null;
        _stderrLoop = null;

        FailAllPending(new IOException("codex app-server process disposed."));
    }

    public async ValueTask DisposeAsync()
    {
        await _startLock.WaitAsync();
        try
        {
            await DisposeProcessAsync();
        }
        finally
        {
            _startLock.Release();
        }
    }

    private static bool TryGetIntId(JsonElement idProp, out int id)
    {
        if (idProp.ValueKind == JsonValueKind.Number && idProp.TryGetInt32(out id))
        {
            return true;
        }

        if (idProp.ValueKind == JsonValueKind.String && int.TryParse(idProp.GetString(), out id))
        {
            return true;
        }

        id = default;
        return false;
    }

    private sealed record JsonRpcRequest
    {
        public required string Jsonrpc { get; init; }
        public required int Id { get; init; }
        public required string Method { get; init; }
        public object? Params { get; init; }
    }

    private sealed class Subscription(Action disposeAction) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 1)
            {
                return;
            }

            disposeAction();
        }
    }
}
