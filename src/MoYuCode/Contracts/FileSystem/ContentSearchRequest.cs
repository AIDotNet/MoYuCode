namespace MoYuCode.Contracts.FileSystem;

public record ContentSearchRequest(
    string Path,
    string Query,
    bool IsRegex = false,
    bool CaseSensitive = false,
    int MaxResults = 500
);
