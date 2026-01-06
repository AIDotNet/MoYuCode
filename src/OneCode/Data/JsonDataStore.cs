using System.Collections.Concurrent;
using System.Text.Json;
using OneCode.Data.Entities;

namespace OneCode.Data;

public sealed class JsonDataStore : IDisposable
{
    private readonly string _dataDirectory;
    private readonly JsonSerializerOptions _jsonOptions;
    private readonly ConcurrentDictionary<Guid, ProjectEntity> _projects;
    private readonly ConcurrentDictionary<Guid, ProviderEntity> _providers;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private bool _disposed;

    public JsonDataStore(string dataDirectory)
    {
        _dataDirectory = dataDirectory ?? throw new ArgumentNullException(nameof(dataDirectory));
        Directory.CreateDirectory(_dataDirectory);

        _jsonOptions = new JsonSerializerOptions
        {
            WriteIndented = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
        };

        _projects = new ConcurrentDictionary<Guid, ProjectEntity>();
        _providers = new ConcurrentDictionary<Guid, ProviderEntity>();

        // Load data on initialization
        LoadDataAsync().GetAwaiter().GetResult();
    }

    public IQueryable<ProjectEntity> Projects => _projects.Values.AsQueryable();

    public IQueryable<ProviderEntity> Providers => _providers.Values.AsQueryable();

    public async Task LoadDataAsync()
    {
        await _lock.WaitAsync();
        try
        {
            // Load providers
            var providersFile = Path.Combine(_dataDirectory, "providers.json");
            if (File.Exists(providersFile))
            {
                var json = await File.ReadAllTextAsync(providersFile);
                var providersList = JsonSerializer.Deserialize<List<ProviderEntity>>(json, _jsonOptions);
                if (providersList != null)
                {
                    _providers.Clear();
                    foreach (var provider in providersList)
                    {
                        _providers[provider.Id] = provider;
                    }
                }
            }

            // Load projects
            var projectsFile = Path.Combine(_dataDirectory, "projects.json");
            if (File.Exists(projectsFile))
            {
                var json = await File.ReadAllTextAsync(projectsFile);
                var projectsList = JsonSerializer.Deserialize<List<ProjectEntity>>(json, _jsonOptions);
                if (projectsList != null)
                {
                    _projects.Clear();
                    foreach (var project in projectsList)
                    {
                        // Resolve provider reference
                        if (project.ProviderId.HasValue && _providers.TryGetValue(project.ProviderId.Value, out var provider))
                        {
                            project.Provider = provider;
                        }
                        _projects[project.Id] = project;
                    }
                }
            }
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task SaveDataAsync()
    {
        await _lock.WaitAsync();
        try
        {
            // Save providers
            var providersFile = Path.Combine(_dataDirectory, "providers.json");
            var providersList = _providers.Values.OrderBy(p => p.Name).ToList();
            var providersJson = JsonSerializer.Serialize(providersList, _jsonOptions);
            await File.WriteAllTextAsync(providersFile, providersJson);

            // Save projects
            var projectsFile = Path.Combine(_dataDirectory, "projects.json");
            var projectsList = _projects.Values.OrderBy(p => p.Name).ToList();
            var projectsJson = JsonSerializer.Serialize(projectsList, _jsonOptions);
            await File.WriteAllTextAsync(projectsFile, projectsJson);
        }
        finally
        {
            _lock.Release();
        }
    }

    public void Add(ProjectEntity project)
    {
        if (project == null) throw new ArgumentNullException(nameof(project));
        _projects[project.Id] = project;
    }

    public void Add(ProviderEntity provider)
    {
        if (provider == null) throw new ArgumentNullException(nameof(provider));
        _providers[provider.Id] = provider;
    }

    public void Remove(ProjectEntity project)
    {
        if (project == null) throw new ArgumentNullException(nameof(project));
        _projects.TryRemove(project.Id, out _);
    }

    public void Remove(ProviderEntity provider)
    {
        if (provider == null) throw new ArgumentNullException(nameof(provider));
        _providers.TryRemove(provider.Id, out _);
    }

    public ProjectEntity? GetProjectWithProvider(Guid id)
    {
        if (_projects.TryGetValue(id, out var project))
        {
            // Load provider reference
            if (project.ProviderId.HasValue && _providers.TryGetValue(project.ProviderId.Value, out var provider))
            {
                project.Provider = provider;
            }
            return project;
        }
        return null;
    }

    public bool ProviderExists(Guid id)
    {
        return _providers.ContainsKey(id);
    }

    public void Dispose()
    {
        if (_disposed) return;

        SaveDataAsync().GetAwaiter().GetResult();
        _lock.Dispose();
        _disposed = true;
    }
}
