namespace OneCode.Contracts.Projects;

public sealed record ProjectSessionDto(
    string Id,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset LastEventAtUtc,
    long DurationMs,
    SessionEventCountsDto EventCounts,
    SessionTokenUsageDto TokenUsage,
    IReadOnlyList<SessionTimelineBucketDto> Timeline,
    IReadOnlyList<SessionTraceSpanDto> Trace);

public sealed record SessionEventCountsDto(
    int Message,
    int FunctionCall,
    int AgentReasoning,
    int TokenCount,
    int Other);

public sealed record SessionTokenUsageDto(
    long InputTokens,
    long CachedInputTokens,
    long OutputTokens,
    long ReasoningOutputTokens);

public sealed record SessionTimelineBucketDto(
    int Message,
    int FunctionCall,
    int AgentReasoning,
    int TokenCount,
    int Other);

public sealed record SessionTraceSpanDto(
    string Kind,
    long DurationMs,
    long TokenCount,
    int EventCount);
