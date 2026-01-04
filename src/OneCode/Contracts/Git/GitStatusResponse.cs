namespace OneCode.Contracts.Git;

public sealed record GitStatusResponse(
    string RepoRoot,
    string? Branch,
    IReadOnlyList<GitStatusEntryDto> Entries);

