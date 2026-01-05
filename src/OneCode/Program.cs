using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using OneCode.Api;
using OneCode.Data;
using OneCode.Services.A2a;
using OneCode.Services.Codex;
using OneCode.Services.Jobs;
using OneCode.Services.Shell;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.AllowAnyOrigin()
            .AllowAnyHeader()
            .AllowAnyMethod());
});

var appDataRoot = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
    "OneCode");
Directory.CreateDirectory(appDataRoot);
var dbPath = Path.Combine(appDataRoot, "onecode.sqlite");

builder.Services.AddDbContext<OneCodeDbContext>(options =>
{
    options.UseSqlite($"Data Source={dbPath}");
});

builder.Services.AddHttpClient();
builder.Services.AddMemoryCache();
builder.Services.AddSingleton<JobManager>();
builder.Services.AddSingleton<PowerShellLauncher>();
builder.Services.AddSingleton<A2aTaskManager>();
builder.Services.AddSingleton<CodexAppServerClient>();
builder.Services.AddSingleton<CodexSessionManager>();

var app = builder.Build();

app.UseCors();
app.UseWebSockets();
app.MapOneCodeApis();
app.MapA2a();
app.MapTerminal();

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<OneCodeDbContext>();
    await db.Database.MigrateAsync();
}

app.Run();
