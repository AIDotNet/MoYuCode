using OneCode.Contracts.Projects;

namespace OneCode.Contracts.Tools;

public sealed record CodexDailyTokenUsageDto(
    string Date,
    SessionTokenUsageDto TokenUsage);

