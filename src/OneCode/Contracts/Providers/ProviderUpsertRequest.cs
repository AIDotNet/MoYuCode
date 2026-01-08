using OneCode.Data.Entities;

namespace OneCode.Contracts.Providers;

public sealed record ProviderUpsertRequest(
    string Name,
    string Address,
    string? Logo,
    string ApiKey,
    ProviderRequestType RequestType,
    string? AzureApiVersion);

public sealed record ProviderModelUpdateRequest(string Model);

