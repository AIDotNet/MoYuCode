namespace OneCode.Contracts.Git;

public sealed record GitCommitRequest(
    string Path,
    string Message);

