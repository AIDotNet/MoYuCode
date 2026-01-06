using System.Collections;
using System.Buffers;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using OneCode.Infrastructure;
using OneCode.Services.Shell;
using Pty.Net;

namespace OneCode.Api;

public static class TerminalEndpoints
{
    private const int MuxSessionIdLength = 36;
    private const int MuxHeaderLength = MuxSessionIdLength + 1; // "<uuid>\\n"
    private static readonly SemaphoreSlim WindowsPtySpawnLock = new(1, 1);

    public static void MapTerminal(this WebApplication app)
    {
        var api = app.MapGroup("/api");
        api.Map("/terminal/ws", HandleTerminalWebSocketAsync);
        api.Map("/terminal/mux", HandleTerminalMuxWebSocketAsync);
    }

    private static async Task HandleTerminalWebSocketAsync(HttpContext httpContext)
    {
        if (!httpContext.WebSockets.IsWebSocketRequest)
        {
            httpContext.Response.StatusCode = StatusCodes.Status400BadRequest;
            await httpContext.Response.WriteAsync("Expected WebSocket request.");
            return;
        }

        var cwd = httpContext.Request.Query["cwd"].ToString();
        if (string.IsNullOrWhiteSpace(cwd))
        {
            httpContext.Response.StatusCode = StatusCodes.Status400BadRequest;
            await httpContext.Response.WriteAsync("Missing query parameter: cwd");
            return;
        }

        cwd = cwd.Trim();
        if (!Directory.Exists(cwd))
        {
            httpContext.Response.StatusCode = StatusCodes.Status404NotFound;
            await httpContext.Response.WriteAsync("Directory does not exist.");
            return;
        }

        var cols = ParseInt(httpContext.Request.Query["cols"].ToString(), fallback: 80, min: 10, max: 400);
        var rows = ParseInt(httpContext.Request.Query["rows"].ToString(), fallback: 24, min: 5, max: 200);
        var shell = httpContext.Request.Query["shell"].ToString();

        var (appName, args) = ResolveShell(shell);

        IPtyConnection pty;
        try
        {
            pty = await SpawnPtyAsync(
                new PtyOptions
                {
                    Name = "onecode-terminal",
                    App = appName,
                    CommandLine = args,
                    Cwd = cwd,
                    Cols = cols,
                    Rows = rows,
                    Environment = BuildEnvironment(),
                },
                httpContext.RequestAborted);
        }
        catch (Exception ex)
        {
            httpContext.Response.StatusCode = StatusCodes.Status500InternalServerError;
            await httpContext.Response.WriteAsync($"Failed to start terminal: {ex.Message}");
            return;
        }

        using (pty)
        {
            using var webSocket = await httpContext.WebSockets.AcceptWebSocketAsync();

            var exitTcs = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
            pty.ProcessExited += (_, e) => exitTcs.TrySetResult(e.ExitCode);

            var pumpOutputTask = PumpPtyOutputAsync(webSocket, pty.ReaderStream, httpContext.RequestAborted);
            var pumpInputTask = PumpWebSocketInputAsync(webSocket, pty, httpContext.RequestAborted);
            var exitedTask = exitTcs.Task;

            var finished = await Task.WhenAny(pumpOutputTask, pumpInputTask, exitedTask);

            if (finished == exitedTask)
            {
                await TrySendJsonAsync(webSocket, new { type = "exit", exitCode = exitedTask.Result }, CancellationToken.None);
            }

            try
            {
                pty.Kill();
            }
            catch
            {
                // ignore
            }

            await Task.WhenAll(Suppress(pumpOutputTask), Suppress(pumpInputTask));

            try
            {
                await webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closed", CancellationToken.None);
            }
            catch
            {
                // ignore
            }
        }
    }

    private static async Task HandleTerminalMuxWebSocketAsync(HttpContext httpContext)
    {
        if (!httpContext.WebSockets.IsWebSocketRequest)
        {
            httpContext.Response.StatusCode = StatusCodes.Status400BadRequest;
            await httpContext.Response.WriteAsync("Expected WebSocket request.");
            return;
        }

        using var webSocket = await httpContext.WebSockets.AcceptWebSocketAsync();

        var sessionManager = httpContext.RequestServices.GetRequiredService<TerminalMuxSessionManager>();
        var sendLock = new SemaphoreSlim(1, 1);
        var attachmentIds = new Dictionary<string, int>(StringComparer.Ordinal);

        var buffer = new byte[16 * 1024];
        var textBuffer = new ArrayBufferWriter<byte>(8 * 1024);
        var binaryBuffer = new ArrayBufferWriter<byte>(8 * 1024);

        async Task SendJsonAsync(object payload, CancellationToken cancellationToken)
        {
            if (webSocket.State != WebSocketState.Open)
            {
                return;
            }

            var json = JsonSerializer.Serialize(payload);
            var bytes = Encoding.UTF8.GetBytes(json);
            await sendLock.WaitAsync(cancellationToken);
            try
            {
                if (webSocket.State == WebSocketState.Open)
                {
                    await webSocket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, cancellationToken);
                }
            }
            finally
            {
                sendLock.Release();
            }
        }

        async Task SendErrorAsync(string? id, string message, CancellationToken cancellationToken)
        {
            await SendJsonAsync(new { type = "error", id, message }, cancellationToken);
        }

        void DetachSession(string id)
        {
            if (!attachmentIds.Remove(id, out var attachmentId))
            {
                return;
            }

            if (!sessionManager.TryGet(id, out var session))
            {
                return;
            }

            session.Detach(attachmentId);
        }

        async Task<bool> TryHandleBinaryInputAsync(ReadOnlyMemory<byte> message, CancellationToken cancellationToken)
        {
            if (message.Length < MuxHeaderLength)
            {
                return false;
            }

            if (message.Span[MuxSessionIdLength] != (byte)'\n')
            {
                return false;
            }

            var id = Encoding.UTF8.GetString(message.Span[..MuxSessionIdLength]);
            if (!sessionManager.TryGet(id, out var session))
            {
                return false;
            }

            var payload = message[(MuxHeaderLength)..];
            if (payload.Length == 0)
            {
                return true;
            }

            return await session.TryWriteAsync(payload, cancellationToken);
        }

        async Task HandleTextMessageAsync(string json, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(json))
            {
                return;
            }

            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                if (!root.TryGetProperty("type", out var typeProp) || typeProp.ValueKind != JsonValueKind.String)
                {
                    return;
                }

                var type = typeProp.GetString();
                if (string.IsNullOrWhiteSpace(type))
                {
                    return;
                }

                var id = root.TryGetProperty("id", out var idProp) && idProp.ValueKind == JsonValueKind.String
                    ? idProp.GetString()
                    : null;

                id = (id ?? string.Empty).Trim();
                if (string.IsNullOrWhiteSpace(id))
                {
                    await SendErrorAsync(null, "Missing session id.", cancellationToken);
                    return;
                }

                if (id.Length != MuxSessionIdLength)
                {
                    await SendErrorAsync(id, "Invalid session id.", cancellationToken);
                    return;
                }

                switch (type.Trim().ToLowerInvariant())
                {
                    case "open":
                    {
                        var cwd = root.TryGetProperty("cwd", out var cwdProp) && cwdProp.ValueKind == JsonValueKind.String
                            ? cwdProp.GetString()
                            : null;
                        cwd = (cwd ?? string.Empty).Trim();
                        if (string.IsNullOrWhiteSpace(cwd))
                        {
                            await SendErrorAsync(id, "Missing cwd.", cancellationToken);
                            return;
                        }

                        if (!Directory.Exists(cwd))
                        {
                            await SendErrorAsync(id, "Directory does not exist.", cancellationToken);
                            return;
                        }

                        var cols = root.TryGetProperty("cols", out var colsProp) && colsProp.ValueKind == JsonValueKind.Number
                            ? Math.Clamp(colsProp.GetInt32(), 10, 400)
                            : 80;
                        var rows = root.TryGetProperty("rows", out var rowsProp) && rowsProp.ValueKind == JsonValueKind.Number
                            ? Math.Clamp(rowsProp.GetInt32(), 5, 200)
                            : 24;

                        var shell = root.TryGetProperty("shell", out var shellProp) && shellProp.ValueKind == JsonValueKind.String
                            ? shellProp.GetString()
                            : null;

                        DetachSession(id);

                        TerminalMuxSession session;
                        try
                        {
                            session = await sessionManager.GetOrCreateAsync(
                                id: id,
                                cwd: cwd,
                                cols: cols,
                                rows: rows,
                                shell: shell,
                                cancellationToken: httpContext.RequestAborted);
                        }
                        catch (InvalidOperationException ex)
                        {
                            await SendErrorAsync(id, ex.Message, cancellationToken);
                            return;
                        }

                        var attachmentId = session.Attach(webSocket, sendLock);
                        attachmentIds[id] = attachmentId;
                        return;
                    }

                    case "resize":
                    {
                        if (!sessionManager.TryGet(id, out var session))
                        {
                            return;
                        }

                        if (!root.TryGetProperty("cols", out var colsProp) || colsProp.ValueKind != JsonValueKind.Number)
                        {
                            return;
                        }

                        if (!root.TryGetProperty("rows", out var rowsProp) || rowsProp.ValueKind != JsonValueKind.Number)
                        {
                            return;
                        }

                        var cols = Math.Clamp(colsProp.GetInt32(), 10, 400);
                        var rows = Math.Clamp(rowsProp.GetInt32(), 5, 200);
                        session.TryResize(cols, rows);

                        return;
                    }

                    case "detach":
                    {
                        DetachSession(id);
                        return;
                    }

                    case "close":
                    {
                        DetachSession(id);
                        await sessionManager.CloseAsync(id);
                        return;
                    }

                    default:
                        return;
                }
            }
            catch (JsonException)
            {
                // ignore
            }
        }

        try
        {
            while (!httpContext.RequestAborted.IsCancellationRequested && webSocket.State == WebSocketState.Open)
            {
                WebSocketReceiveResult result;
                try
                {
                    result = await webSocket.ReceiveAsync(buffer, httpContext.RequestAborted);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch
                {
                    break;
                }

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    break;
                }

                if (result.MessageType == WebSocketMessageType.Text)
                {
                    textBuffer.Write(buffer.AsSpan(0, result.Count));
                    if (!result.EndOfMessage)
                    {
                        continue;
                    }

                    var json = Encoding.UTF8.GetString(textBuffer.WrittenSpan);
                    textBuffer.Clear();
                    await HandleTextMessageAsync(json, httpContext.RequestAborted);
                    continue;
                }

                if (result.MessageType == WebSocketMessageType.Binary)
                {
                    binaryBuffer.Write(buffer.AsSpan(0, result.Count));
                    if (!result.EndOfMessage)
                    {
                        continue;
                    }

                    var data = binaryBuffer.WrittenMemory;
                    await TryHandleBinaryInputAsync(data, httpContext.RequestAborted);
                    binaryBuffer.Clear();
                }
            }
        }
        finally
        {
            foreach (var (id, attachmentId) in attachmentIds)
            {
                if (sessionManager.TryGet(id, out var session))
                {
                    session.Detach(attachmentId);
                }
            }
        }

        try
        {
            await webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closed", CancellationToken.None);
        }
        catch
        {
            // ignore
        }
    }

    private static async Task PumpPtyOutputAsync(WebSocket webSocket, Stream reader, CancellationToken cancellationToken)
    {
        var buffer = new byte[16 * 1024];
        while (!cancellationToken.IsCancellationRequested && webSocket.State == WebSocketState.Open)
        {
            int read;
            try
            {
                read = await reader.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken);
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

            try
            {
                await webSocket.SendAsync(
                    buffer.AsMemory(0, read),
                    WebSocketMessageType.Binary,
                    endOfMessage: true,
                    cancellationToken);
            }
            catch
            {
                break;
            }
        }
    }

    private static async Task PumpPtyOutputMuxAsync(
        WebSocket webSocket,
        SemaphoreSlim sendLock,
        Stream reader,
        byte[] header,
        CancellationToken cancellationToken)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(16 * 1024);
        try
        {
            while (!cancellationToken.IsCancellationRequested && webSocket.State == WebSocketState.Open)
            {
                int read;
                try
                {
                    read = await reader.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken);
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

                var messageSize = header.Length + read;
                var message = ArrayPool<byte>.Shared.Rent(messageSize);
                try
                {
                    header.CopyTo(message, 0);
                    Buffer.BlockCopy(buffer, 0, message, header.Length, read);

                    await sendLock.WaitAsync(cancellationToken);
                    try
                    {
                        if (webSocket.State != WebSocketState.Open)
                        {
                            break;
                        }

                        await webSocket.SendAsync(
                            message.AsMemory(0, messageSize),
                            WebSocketMessageType.Binary,
                            endOfMessage: true,
                            cancellationToken);
                    }
                    finally
                    {
                        sendLock.Release();
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

    private static async Task PumpWebSocketInputAsync(WebSocket webSocket, IPtyConnection pty, CancellationToken cancellationToken)
    {
        var buffer = new byte[16 * 1024];
        var textBuffer = new ArrayBufferWriter<byte>(8 * 1024);

        while (!cancellationToken.IsCancellationRequested && webSocket.State == WebSocketState.Open)
        {
            WebSocketReceiveResult result;
            try
            {
                result = await webSocket.ReceiveAsync(buffer, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch
            {
                break;
            }

            if (result.MessageType == WebSocketMessageType.Close)
            {
                break;
            }

            if (result.MessageType == WebSocketMessageType.Binary)
            {
                try
                {
                    await pty.WriterStream.WriteAsync(buffer.AsMemory(0, result.Count), cancellationToken);
                    await pty.WriterStream.FlushAsync(cancellationToken);
                }
                catch
                {
                    break;
                }

                continue;
            }

            // Text: resize messages, otherwise treated as input
            textBuffer.Write(buffer.AsSpan(0, result.Count));
            if (!result.EndOfMessage)
            {
                continue;
            }

            var text = Encoding.UTF8.GetString(textBuffer.WrittenSpan);
            textBuffer.Clear();

            if (TryHandleResize(text, pty))
            {
                continue;
            }

            if (!string.IsNullOrEmpty(text))
            {
                try
                {
                    var bytes = Encoding.UTF8.GetBytes(text);
                    await pty.WriterStream.WriteAsync(bytes, cancellationToken);
                    await pty.WriterStream.FlushAsync(cancellationToken);
                }
                catch
                {
                    break;
                }
            }
        }
    }

    private static bool TryHandleResize(string text, IPtyConnection pty)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        text = text.Trim();
        if (!text.StartsWith('{'))
        {
            return false;
        }

        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (!root.TryGetProperty("type", out var typeElement))
            {
                return false;
            }

            var type = typeElement.GetString();
            if (!string.Equals(type, "resize", StringComparison.Ordinal))
            {
                return false;
            }

            if (!root.TryGetProperty("cols", out var colsElement) || colsElement.ValueKind != JsonValueKind.Number)
            {
                return false;
            }

            if (!root.TryGetProperty("rows", out var rowsElement) || rowsElement.ValueKind != JsonValueKind.Number)
            {
                return false;
            }

            var cols = Math.Clamp(colsElement.GetInt32(), 10, 400);
            var rows = Math.Clamp(rowsElement.GetInt32(), 5, 200);
            pty.Resize(cols, rows);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static async Task TrySendJsonAsync(WebSocket webSocket, object payload, CancellationToken cancellationToken)
    {
        if (webSocket.State != WebSocketState.Open)
        {
            return;
        }

        try
        {
            var json = JsonSerializer.Serialize(payload,JsonOptions.DefaultOptions);
            var bytes = Encoding.UTF8.GetBytes(json);
            await webSocket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, cancellationToken);
        }
        catch
        {
            // ignore
        }
    }

    private static async Task Suppress(Task task)
    {
        try
        {
            await task;
        }
        catch
        {
            // ignore
        }
    }

    private static int ParseInt(string? raw, int fallback, int min, int max)
    {
        if (!int.TryParse(raw, out var value))
        {
            return fallback;
        }

        return Math.Clamp(value, min, max);
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
                _ => ("powershell.exe", new[] { "-NoLogo" }),
            };
        }

        return normalized switch
        {
            "bash" or "" => ("/bin/bash", Array.Empty<string>()),
            "sh" => ("/bin/sh", Array.Empty<string>()),
            _ => ("/bin/bash", Array.Empty<string>()),
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
