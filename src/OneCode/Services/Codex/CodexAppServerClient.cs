using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Microsoft.Extensions.Configuration;
using OneCode.Data;
using OneCode.Data.Entities;

namespace OneCode.Services.Codex;

public sealed class CodexAppServerClient : IAsyncDisposable
{
    private readonly ILogger<CodexAppServerClient> _logger;
    private readonly IConfiguration _configuration;
    private readonly JsonDataStore _store;
    private static readonly TimeSpan DefaultRequestTimeout = TimeSpan.FromMinutes(2);

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
    private volatile bool _initialized;

    private int _nextRequestId;
    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonElement>> _pending = new();
    private readonly ConcurrentDictionary<Guid, Channel<CodexAppServerEvent>> _subscribers = new();
    private readonly ConcurrentDictionary<Guid, string> _providerKeyFingerprints = new();

    public CodexAppServerClient(
        ILogger<CodexAppServerClient> logger,
        IConfiguration configuration,
        JsonDataStore store)
    {
        _logger = logger;
        _configuration = configuration;
        _store = store;
    }

    public async Task EnsureStartedAsync(CancellationToken cancellationToken)
    {
        if (IsProcessReady())
        {
            return;
        }

        await _startLock.WaitAsync(cancellationToken);
        try
        {
            if (IsProcessReady())
            {
                return;
            }

            if (!IsProcessHealthy())
            {
                await StartProcessAsync(cancellationToken);
            }

            if (!_initialized)
            {
                await InitializeAsync(cancellationToken);
                _initialized = true;
            }
        }
        finally
        {
            _startLock.Release();
        }
    }

    public async Task EnsureProviderKeyAsync(Guid providerId, string apiKey, CancellationToken cancellationToken)
    {
        var normalizedKey = apiKey.Trim();
        if (providerId == Guid.Empty || normalizedKey.Length == 0)
        {
            return;
        }

        var fingerprint = ComputeKeyFingerprint(normalizedKey);
        if (_providerKeyFingerprints.TryGetValue(providerId, out var existing)
            && string.Equals(existing, fingerprint, StringComparison.Ordinal))
        {
            return;
        }

        if (!IsProcessReady())
        {
            await EnsureStartedAsync(cancellationToken);
        }

        if (_providerKeyFingerprints.TryGetValue(providerId, out existing)
            && string.Equals(existing, fingerprint, StringComparison.Ordinal))
        {
            return;
        }

        await _startLock.WaitAsync(cancellationToken);
        try
        {
            if (_providerKeyFingerprints.TryGetValue(providerId, out existing)
                && string.Equals(existing, fingerprint, StringComparison.Ordinal))
            {
                return;
            }

            if (!IsProcessHealthy())
            {
                await StartProcessAsync(cancellationToken);
                await InitializeAsync(cancellationToken);
                _initialized = true;
                return;
            }

            _logger.LogInformation("Restarting codex app-server to refresh provider API keys.");
            await RestartProcessAsync(cancellationToken);
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

    private bool IsProcessReady()
        => IsProcessHealthy() && _initialized;

    private async Task StartProcessAsync(CancellationToken cancellationToken)
    {
        await DisposeProcessAsync();

        var startInfo = CreateCodexStartInfo();
        _logger.LogInformation(
            "Starting codex app-server: {FileName} {Args}",
            startInfo.FileName,
            string.Join(' ', startInfo.ArgumentList));

        var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true,
        };

        try
        {
            if (!process.Start())
            {
                throw new InvalidOperationException("Failed to start codex app-server.");
            }
        }
        catch (Win32Exception ex)
        {
            throw new InvalidOperationException(
                $"Failed to start codex app-server (FileName: {startInfo.FileName}). " +
                "Ensure Codex CLI is installed and on PATH (e.g. `npm install -g @openai/codex`), " +
                "or set `Codex:ExecutablePath` in appsettings / environment variables.",
                ex);
        }

        _process = process;
        _stdin = process.StandardInput;
        _initialized = false;
        // codex app-server expects LF-delimited JSON on stdin, even on Windows.
        // Using the default CRLF from StreamWriter.WriteLine can cause parse failures.
        _stdin.NewLine = "\n";
        _shutdownCts = new CancellationTokenSource();

        _stdoutLoop = Task.Run(() => ReadStdoutLoopAsync(process, _shutdownCts.Token), CancellationToken.None);
        _stderrLoop = Task.Run(() => ReadStderrLoopAsync(process, _shutdownCts.Token), CancellationToken.None);

        process.Exited += (_, _) =>
        {
            var exitCode = process.ExitCode;
            _logger.LogWarning("codex app-server exited with code {ExitCode}.", exitCode);
            FailAllPending(new IOException($"codex app-server exited with code {exitCode}."));
            Publish(new CodexAppServerEvent.StderrLine(DateTimeOffset.UtcNow, $"[codex-exited] code={exitCode}"));
            _initialized = false;
        };
    }

    private ProcessStartInfo CreateCodexStartInfo()
    {
        var utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        var startInfo = new ProcessStartInfo
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardInputEncoding = utf8,
            StandardOutputEncoding = utf8,
            StandardErrorEncoding = utf8,
        };

        var configuredExecutable = (_configuration["Codex:ExecutablePath"] ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(configuredExecutable))
        {
            ConfigureCodexStartInfo(startInfo, configuredExecutable);
            AddOneCodeProviderApiKeys(startInfo);
            return startInfo;
        }

        if (OperatingSystem.IsWindows())
        {
            // Prefer launching the bundled native binary directly.
            // The `.cmd` shim + `cmd.exe /c` layer can interfere with stdio when
            // the parent process uses redirected pipes.
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

            var npmBin = Path.Combine(appData, "npm");
            var fallbackNpmBin = Path.Combine(localAppData, "npm");
            if (!Directory.Exists(npmBin) && Directory.Exists(fallbackNpmBin))
            {
                npmBin = fallbackNpmBin;
            }

            var codexExe = ResolveWindowsVendorCodexExe(npmBin);
            if (!File.Exists(codexExe) && Directory.Exists(fallbackNpmBin))
            {
                var altCodexExe = ResolveWindowsVendorCodexExe(fallbackNpmBin);
                if (File.Exists(altCodexExe))
                {
                    npmBin = fallbackNpmBin;
                    codexExe = altCodexExe;
                }
            }

            if (File.Exists(codexExe))
            {
                startInfo.FileName = codexExe;
                startInfo.ArgumentList.Add("app-server");
                AddOneCodeProviderApiKeys(startInfo);
                return startInfo;
            }

            // Fallback: `npm i -g @openai/codex` installs a `.cmd` shim under `%APPDATA%\npm`.
            // `ProcessStartInfo` cannot execute `.cmd` directly with `UseShellExecute=false`,
            // so we invoke through `cmd.exe /c`.
            var codexCmd = Path.Combine(npmBin, "codex.cmd");

            startInfo.FileName = "cmd.exe";
            startInfo.ArgumentList.Add("/c");
            startInfo.ArgumentList.Add(File.Exists(codexCmd) ? codexCmd : "codex");
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

            AddOneCodeProviderApiKeys(startInfo);
            return startInfo;
        }

        startInfo.FileName = "codex";
        startInfo.ArgumentList.Add("app-server");
        AddOneCodeProviderApiKeys(startInfo);
        return startInfo;
    }

    private void AddOneCodeProviderApiKeys(ProcessStartInfo startInfo)
    {
        try
        {
            var fingerprints = new Dictionary<Guid, string>();
            foreach (var provider in _store.Providers)
            {
                if (provider.RequestType == ProviderRequestType.Anthropic)
                {
                    continue;
                }

                var key = (provider.ApiKey ?? string.Empty).Trim();
                if (string.IsNullOrWhiteSpace(key))
                {
                    continue;
                }

                var envName = $"ONECODE_API_KEY_{provider.Id:N}";
                startInfo.Environment[envName] = key;
                fingerprints[provider.Id] = ComputeKeyFingerprint(key);
            }

            _providerKeyFingerprints.Clear();
            foreach (var (providerId, fingerprint) in fingerprints)
            {
                _providerKeyFingerprints[providerId] = fingerprint;
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to add provider API keys to codex app-server environment.");
        }
    }

    private static void ConfigureCodexStartInfo(ProcessStartInfo startInfo, string configuredExecutable)
    {
        startInfo.ArgumentList.Clear();

        if (OperatingSystem.IsWindows())
        {
            var ext = Path.GetExtension(configuredExecutable);
            var isCmdShim = string.Equals(ext, ".cmd", StringComparison.OrdinalIgnoreCase)
                || string.Equals(ext, ".bat", StringComparison.OrdinalIgnoreCase);

            if (isCmdShim || !Path.IsPathRooted(configuredExecutable))
            {
                startInfo.FileName = "cmd.exe";
                startInfo.ArgumentList.Add("/c");
                startInfo.ArgumentList.Add(configuredExecutable);
                startInfo.ArgumentList.Add("app-server");

                var parent = Path.IsPathRooted(configuredExecutable)
                    ? Path.GetDirectoryName(configuredExecutable)
                    : null;
                if (!string.IsNullOrWhiteSpace(parent))
                {
                    EnsurePathContains(startInfo, parent);
                }

                return;
            }
        }

        startInfo.FileName = configuredExecutable;
        startInfo.ArgumentList.Add("app-server");
    }

    private static void EnsurePathContains(ProcessStartInfo startInfo, string directory)
    {
        if (!Directory.Exists(directory))
        {
            return;
        }

        var existingPath = startInfo.Environment.TryGetValue("PATH", out var v) ? v : null;
        existingPath ??= Environment.GetEnvironmentVariable("PATH");
        existingPath ??= string.Empty;

        if (existingPath.Split(';', StringSplitOptions.RemoveEmptyEntries)
                .Contains(directory, StringComparer.OrdinalIgnoreCase))
        {
            return;
        }

        startInfo.Environment["PATH"] = $"{directory};{existingPath}";
    }

    private static string ResolveWindowsVendorCodexExe(string npmBin)
    {
        var vendorTriple = GetWindowsVendorTriple();

        var candidate = Path.Combine(
            npmBin,
            "node_modules",
            "@openai",
            "codex",
            "vendor",
            vendorTriple,
            "codex",
            "codex.exe");

        if (File.Exists(candidate))
        {
            return candidate;
        }

        if (!string.Equals(vendorTriple, "x86_64-pc-windows-msvc", StringComparison.OrdinalIgnoreCase))
        {
            var x64Candidate = Path.Combine(
                npmBin,
                "node_modules",
                "@openai",
                "codex",
                "vendor",
                "x86_64-pc-windows-msvc",
                "codex",
                "codex.exe");

            if (File.Exists(x64Candidate))
            {
                return x64Candidate;
            }
        }

        if (!string.Equals(vendorTriple, "aarch64-pc-windows-msvc", StringComparison.OrdinalIgnoreCase))
        {
            var armCandidate = Path.Combine(
                npmBin,
                "node_modules",
                "@openai",
                "codex",
                "vendor",
                "aarch64-pc-windows-msvc",
                "codex",
                "codex.exe");

            if (File.Exists(armCandidate))
            {
                return armCandidate;
            }
        }

        return candidate;
    }

    private static string GetWindowsVendorTriple()
    {
        if (!OperatingSystem.IsWindows())
        {
            return "x86_64-pc-windows-msvc";
        }

        return RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.Arm64 => "aarch64-pc-windows-msvc",
            _ => "x86_64-pc-windows-msvc",
        };
    }

    private async Task InitializeAsync(CancellationToken cancellationToken)
    {
        var response = await SendRequestAsync(
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

        if (response.TryGetProperty("error", out var error) && error.ValueKind != JsonValueKind.Null)
        {
            throw new InvalidOperationException($"codex app-server error: {error}");
        }

        if (!response.TryGetProperty("result", out _))
        {
            throw new InvalidOperationException("codex app-server response missing `result`.");
        }
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
                Id = id,
                Method = method,
                Params = @params,
            };

            var json = JsonSerializer.Serialize(request, _jsonOptions);
            _logger.LogDebug("codex -> {Method} (id={Id})", method, id);
            await stdin.WriteLineAsync(json);
            await stdin.FlushAsync(cancellationToken);

            try
            {
                return await tcs.Task.WaitAsync(DefaultRequestTimeout, cancellationToken);
            }
            catch (TimeoutException ex)
            {
                throw new TimeoutException($"codex app-server request timed out: {method} (id={id})", ex);
            }
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

                _logger.LogWarning("codex[stderr] {Line}", line);
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
                _logger.LogDebug("codex <- response (id={Id})", id);
                tcs.TrySetResult(root.Clone());
                return;
            }

            var method = root.TryGetProperty("method", out var methodProp) && methodProp.ValueKind == JsonValueKind.String
                ? methodProp.GetString()
                : null;

            var meta = CodexAppServerMessageMeta.From(root, method);
            if (!string.IsNullOrWhiteSpace(method))
            {
                _logger.LogDebug(
                    "codex <- notification {Method} (threadId={ThreadId} turnId={TurnId})",
                    method,
                    meta.ThreadId,
                    meta.TurnId);
            }
            Publish(new CodexAppServerEvent.JsonNotification(DateTimeOffset.UtcNow, line, meta));
        }
        catch (JsonException)
        {
            _logger.LogWarning("codex stdout non-JSON: {Line}", line);
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

        _initialized = false;
        _stdin = null;
        _stdoutLoop = null;
        _stderrLoop = null;
        _providerKeyFingerprints.Clear();

        FailAllPending(new IOException("codex app-server process disposed."));
    }

    private async Task RestartProcessAsync(CancellationToken cancellationToken)
    {
        await DisposeProcessAsync();
        await StartProcessAsync(cancellationToken);
        await InitializeAsync(cancellationToken);
        _initialized = true;
    }

    private static string ComputeKeyFingerprint(string apiKey)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(apiKey));
        return Convert.ToHexString(bytes);
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
