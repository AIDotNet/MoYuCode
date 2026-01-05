using System.Collections;
using System.Buffers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Pty.Net;

namespace OneCode.Api;

public static class TerminalEndpoints
{
    public static void MapTerminal(this WebApplication app)
    {
        app.Map("/terminal/ws", HandleTerminalWebSocketAsync);
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

        using var webSocket = await httpContext.WebSockets.AcceptWebSocketAsync();
        using var pty = await PtyProvider.SpawnAsync(
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
            var json = JsonSerializer.Serialize(payload);
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

            if (!env.ContainsKey(key))
            {
                env[key] = value;
            }
        }

        return env;
    }
}
