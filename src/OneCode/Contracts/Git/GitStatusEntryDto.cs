namespace OneCode.Contracts.Git;

public sealed record GitStatusEntryDto(
    string Path,
    string IndexStatus,
    string WorktreeStatus,
    string? OriginalPath);

