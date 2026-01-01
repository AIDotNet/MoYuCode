namespace OneCode.Contracts.FileSystem;

public sealed record CreateEntryRequest(string ParentPath, string Name, string Kind);

