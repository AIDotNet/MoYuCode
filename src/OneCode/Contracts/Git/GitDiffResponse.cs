namespace OneCode.Contracts.Git;

public sealed record GitDiffResponse(
    string File,
    string Diff,
    bool Truncated);

