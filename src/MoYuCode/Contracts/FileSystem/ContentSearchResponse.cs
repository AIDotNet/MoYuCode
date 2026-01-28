namespace MoYuCode.Contracts.FileSystem;

public record ContentSearchMatch(
    string FilePath,
    int LineNumber,
    string LineContent,
    int MatchStart,
    int MatchEnd
);

public record ContentSearchResponse(
    string Query,
    bool IsRegex,
    bool CaseSensitive,
    IReadOnlyList<ContentSearchMatch> Matches,
    int TotalMatches,
    bool Truncated
);
