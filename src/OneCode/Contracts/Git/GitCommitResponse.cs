namespace OneCode.Contracts.Git;

public sealed record GitCommitResponse(
    string Hash,
    string Subject);

