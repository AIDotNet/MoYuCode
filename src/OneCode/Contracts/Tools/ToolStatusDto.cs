namespace OneCode.Contracts.Tools;

public sealed record ToolStatusDto(
    bool Installed,
    string? Version,
    string? ExecutablePath,
    string ConfigPath,
    bool ConfigExists,
    bool NodeInstalled,
    string? NodeVersion,
    bool NpmInstalled,
    string? NpmVersion,
    string Platform);

