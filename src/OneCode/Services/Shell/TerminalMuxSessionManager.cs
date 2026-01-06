using System.Buffers;
using System.Collections;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using OneCode.Infrastructure;
using Pty.Net;

namespace OneCode.Services.Shell;

public sealed class TerminalMuxSessionManager(ILogger<TerminalMuxSessionManager> logger) : IAsyncDisposable
{
    private const int SessionIdLength = 36;
    private const int HeaderLength = SessionIdLength + 1; // "<uuid>\n"
    private static readonly SemaphoreSlim WindowsPtySpawnLock = new(1, 1);

    private readonly ConcurrentDictionary<string, Task<TerminalMuxSession>> _sessions =
        new(StringComparer.Ordinal);

    public async Task<TerminalMuxSession> GetOrCreateAsync(
        string id,
        string cwd,
        int cols,
        int rows,
        string? shell,
        CancellationToken cancellationToken)
    {
        var normalizedId = (id ?? string.Empty).Trim();
        if (normalizedId.Length != SessionIdLength)
        {
            throw new InvalidOperationException("Invalid session id.");
        }

        var normalizedCwd = (cwd ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalizedCwd))
        {
            throw new InvalidOperationException("Missing cwd.");
        }

        if (!Directory.Exists(normalizedCwd))
        {
            throw new InvalidOperationException("Directory does not exist.");
        }

        var normalizedCols = Math.Clamp(cols, 10, 400);
        var normalizedRows = Math.Clamp(rows, 5, 200);

        var task = _sessions.GetOrAdd(
            normalizedId,
            _ => CreateSessionAsync(normalizedId, normalizedCwd, normalizedCols, normalizedRows, shell, cancellationToken: CancellationToken.None));

        try
        {
            var session = await task.WaitAsync(cancellationToken);
            session.TryResize(normalizedCols, normalizedRows);
            return session;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested && !task.IsCanceled)
        {
            throw;
        }
        catch
        {
            _sessions.TryRemove(normalizedId, out _);
            throw;
        }
    }

    public bool TryGet(string id, out TerminalMuxSession session)
    {
        session = default!;
        if (!_sessions.TryGetValue(id, out var task))
        {
            return false;
        }

        if (!task.IsCompletedSuccessfully)
        {
            return false;
        }

        session = task.Result;
        return true;
    }

    public async Task CloseAsync(string id)
    {
        if (!_sessions.TryRemove(id, out var task))
        {
            return;
        }

        TerminalMuxSession? session = null;
        try
        {
            session = await task;
        }
        catch
        {
            // ignore
        }

        if (session is null)
        {
            return;
        }

        try
        {
            session.Dispose();
        }
        catch
        {
            // ignore
        }
    }

    public async ValueTask DisposeAsync()
    {
        var ids = _sessions.Keys.ToArray();
        foreach (var id in ids)
        {
            await CloseAsync(id);
        }
    }

    private async Task<TerminalMuxSession> CreateSessionAsync(
        string id,
        string cwd,
        int cols,
        int rows,
        string? shell,
        CancellationToken cancellationToken)
    {
        var (appName, args) = ResolveShell(shell);

        var headerBytes = Encoding.UTF8.GetBytes(id + "\n");
        if (headerBytes.Length != HeaderLength)
        {
            throw new InvalidOperationException("Invalid session header.");
        }

        IPtyConnection pty;
        try
        {
            pty = await SpawnPtyAsync(
                new PtyOptions
                {
                    Name = $"onecode-terminal:{id}",
                    App = appName,
                    CommandLine = args,
                    Cwd = cwd,
                    Cols = cols,
                    Rows = rows,
                    Environment = BuildEnvironment(),
                },
                cancellationToken);
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException($"Failed to start terminal: {ex.Message}", ex);
        }

        var session = new TerminalMuxSession(
            id,
            pty,
            headerBytes,
            logger,
            onExited: () => _ = Task.Run(() => CloseAsync(id)));

        session.StartPump();
        return session;
    }

    private static (string App, string[] Args) ResolveShell(string? shell)
    {
        var normalized = (shell ?? string.Empty).Trim().ToLowerInvariant();

        if (OperatingSystem.IsWindows())
        {
            return normalized switch
            {
                "cmd" or "cmd.exe" => ("cmd.exe", Array.Empty<string>()),
                "powershell" or "powershell.exe" or "" => ("powershell.exe", new[] { "-NoLogo" }),
                _ => ("powershell.exe", ["-NoLogo"]),
            };
        }

        return normalized switch
        {
            "bash" or "" => ("/bin/bash", Array.Empty<string>()),
            "sh" => ("/bin/sh", []),
            _ => ("/bin/bash", []),
        };
    }

    private static IDictionary<string, string> BuildEnvironment()
    {
        var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["TERM"] = "xterm-256color",
            ["COLORTERM"] = "truecolor",
        };

        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            if (entry.Key is not string key || entry.Value is not string value)
            {
                continue;
            }

            env.TryAdd(key, value);
        }

        return env;
    }

    private static async Task<IPtyConnection> SpawnPtyAsync(PtyOptions options, CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            return await PtyProvider.SpawnAsync(options, cancellationToken);
        }

        // Quick.PtyNet relies on native helpers that are resolved via relative paths. When running under
        // `dotnet run`, the current working directory is usually the project folder, so those helpers
        // may not be found. Temporarily switching the host CWD to the native runtime folder keeps
        // spawning stable without requiring extra files in the repo.
        var originalCwd = Directory.GetCurrentDirectory();
        var runtimeRid = Environment.Is64BitProcess ? "win-x64" : "win-x86";
        var nativeRuntimeFolder = Path.Combine(AppContext.BaseDirectory, "runtimes", runtimeRid, "native");

        await WindowsPtySpawnLock.WaitAsync(cancellationToken);
        try
        {
            if (Directory.Exists(nativeRuntimeFolder))
            {
                Directory.SetCurrentDirectory(nativeRuntimeFolder);
            }

            options.ForceWinPty = true;
            return await PtyProvider.SpawnAsync(options, cancellationToken);
        }
        finally
        {
            try
            {
                Directory.SetCurrentDirectory(originalCwd);
            }
            catch
            {
                // ignore
            }

            WindowsPtySpawnLock.Release();
        }
    }
}

public sealed class TerminalMuxSession : IDisposable
{
    private readonly ILogger _logger;
    private readonly Action _onExited;
    private readonly ConcurrentDictionary<int, TerminalMuxAttachment> _attachments = new();
    private int _nextAttachmentId;
    private int _disposed;
    private Task? _pumpTask;
    private readonly CancellationTokenSource _pumpCts = new();

    public TerminalMuxSession(
        string id,
        IPtyConnection pty,
        byte[] header,
        ILogger logger,
        Action onExited)
    {
        Id = id;
        Pty = pty;
        Header = header;
        _logger = logger;
        _onExited = onExited;

        Pty.ProcessExited += (_, e) =>
        {
            ExitCode = e.ExitCode;
            _onExited();
            _ = Task.Run(() => BroadcastExitAsync(e.ExitCode));
        };
    }

    public string Id { get; }
    public IPtyConnection Pty { get; }
    public byte[] Header { get; }
    public int? ExitCode { get; private set; }

    public void StartPump()
    {
        _pumpTask ??= Task.Run(() => PumpOutputAsync(_pumpCts.Token));
    }

    public void TryResize(int cols, int rows)
    {
        try
        {
            Pty.Resize(cols, rows);
        }
        catch
        {
            // ignore
        }
    }

    public int Attach(WebSocket webSocket, SemaphoreSlim sendLock)
    {
        var id = Interlocked.Increment(ref _nextAttachmentId);
        var attachment = new TerminalMuxAttachment(id, webSocket, sendLock);
        _attachments[id] = attachment;
        return id;
    }

    public void Detach(int attachmentId)
    {
        _attachments.TryRemove(attachmentId, out _);
    }

    public async Task<bool> TryWriteAsync(ReadOnlyMemory<byte> payload, CancellationToken cancellationToken)
    {
        if (payload.Length == 0)
        {
            return true;
        }

        try
        {
            await Pty.WriterStream.WriteAsync(payload, cancellationToken);
            await Pty.WriterStream.FlushAsync(cancellationToken);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private async Task PumpOutputAsync(CancellationToken cancellationToken)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(16 * 1024);
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                int read;
                try
                {
                    read = await Pty.ReaderStream.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch
                {
                    break;
                }

                if (read <= 0)
                {
                    break;
                }

                var attachments = _attachments.Values.ToArray();
                if (attachments.Length == 0)
                {
                    continue;
                }

                var messageSize = Header.Length + read;
                var message = ArrayPool<byte>.Shared.Rent(messageSize);
                try
                {
                    Header.CopyTo(message, 0);
                    Buffer.BlockCopy(buffer, 0, message, Header.Length, read);

                    foreach (var attachment in attachments)
                    {
                        var sent = await attachment.TrySendAsync(
                            message.AsMemory(0, messageSize),
                            WebSocketMessageType.Binary,
                            cancellationToken);

                        if (!sent)
                        {
                            _attachments.TryRemove(attachment.Id, out _);
                        }
                    }
                }
                finally
                {
                    ArrayPool<byte>.Shared.Return(message);
                }
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private async Task BroadcastExitAsync(int exitCode)
    {
        var attachments = _attachments.Values.ToArray();
        if (attachments.Length == 0)
        {
            return;
        }

        var json = JsonSerializer.Serialize(new { type = "exit", id = Id, exitCode }, JsonOptions.DefaultOptions);
        var bytes = Encoding.UTF8.GetBytes(json);

        foreach (var attachment in attachments)
        {
            await attachment.TrySendAsync(bytes, WebSocketMessageType.Text, CancellationToken.None);
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        try
        {
            _pumpCts.Cancel();
        }
        catch
        {
            // ignore
        }

        try
        {
            Pty.Kill();
        }
        catch
        {
            // ignore
        }

        try
        {
            Pty.Dispose();
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Failed to dispose PTY session {SessionId}", Id);
        }

        try
        {
            _pumpCts.Dispose();
        }
        catch
        {
            // ignore
        }
    }

    private sealed class TerminalMuxAttachment(int id, WebSocket webSocket, SemaphoreSlim sendLock)
    {
        public int Id { get; } = id;
        private WebSocket WebSocket { get; } = webSocket;
        private SemaphoreSlim SendLock { get; } = sendLock;

        public async Task<bool> TrySendAsync(
            ReadOnlyMemory<byte> payload,
            WebSocketMessageType messageType,
            CancellationToken cancellationToken)
        {
            if (WebSocket.State != WebSocketState.Open)
            {
                return false;
            }

            try
            {
                await SendLock.WaitAsync(cancellationToken);
            }
            catch
            {
                return false;
            }

            try
            {
                if (WebSocket.State != WebSocketState.Open)
                {
                    return false;
                }

                await WebSocket.SendAsync(payload, messageType, endOfMessage: true, cancellationToken);
                return true;
            }
            catch
            {
                return false;
            }
            finally
            {
                try
                {
                    SendLock.Release();
                }
                catch
                {
                    // ignore
                }
            }
        }
    }
}
