using System.Text.Json;

namespace OneCode.Services.Codex;

public abstract record CodexAppServerEvent(DateTimeOffset ReceivedAtUtc)
{
    public sealed record JsonNotification(
        DateTimeOffset ReceivedAtUtc,
        string RawJson,
        CodexAppServerMessageMeta Meta)
        : CodexAppServerEvent(ReceivedAtUtc);

    public sealed record StderrLine(DateTimeOffset ReceivedAtUtc, string Text)
        : CodexAppServerEvent(ReceivedAtUtc);
}

public sealed record CodexAppServerMessageMeta(
    string? Method,
    string? ThreadId,
    string? TurnId)
{
    public static CodexAppServerMessageMeta From(JsonElement root, string? method)
    {
        var threadId = TryReadString(root, "params", "threadId")
            ?? TryReadString(root, "params", "thread", "id");

        var turnId = TryReadString(root, "params", "turnId")
            ?? TryReadString(root, "params", "turn", "id");

        return new CodexAppServerMessageMeta(method, threadId, turnId);
    }

    private static string? TryReadString(JsonElement root, params string[] path)
    {
        var current = root;
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
}

