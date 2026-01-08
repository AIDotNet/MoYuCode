using System.Text.Json.Serialization;
using Microsoft.Extensions.FileProviders;
using OneCode.Api;
using OneCode.Data;
using OneCode.Services.A2a;
using OneCode.Services.Codex;
using OneCode.Services.Jobs;
using OneCode.Services.Shell;
using Serilog;
using Serilog.Events;

namespace OneCode;

public static class OneCodeApp
{
    public const string DefaultUrl = "http://0.0.0.0:9110";

    public static WebApplication Create(string[]? args, out bool usingDefaultUrl)
    {
        args ??= Array.Empty<string>();
        var builder = WebApplication.CreateBuilder(args);

        var logDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "OneCode",
            "logs");
        Directory.CreateDirectory(logDirectory);
        var errorLogPath = Path.Combine(logDirectory, "onecode-error-.log");

        builder.Host.UseSerilog((context, _, loggerConfiguration) =>
        {
            loggerConfiguration
                .ReadFrom.Configuration(context.Configuration)
                .WriteTo.File(
                    errorLogPath,
                    restrictedToMinimumLevel: LogEventLevel.Error,
                    rollingInterval: RollingInterval.Day,
                    retainedFileCountLimit: 14);
        });

        var hasUrls = !string.IsNullOrWhiteSpace(builder.Configuration["urls"])
            || !string.IsNullOrWhiteSpace(builder.Configuration["ASPNETCORE_URLS"]);
        var hasKestrelEndpoints = builder.Configuration.GetSection("Kestrel:Endpoints").GetChildren().Any();
        usingDefaultUrl = !hasUrls && !hasKestrelEndpoints;
        if (usingDefaultUrl)
        {
            builder.WebHost.UseUrls(DefaultUrl);
        }

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
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".one-code");
        Directory.CreateDirectory(appDataRoot);

        builder.Services.AddSingleton<JsonDataStore>(sp => new JsonDataStore(appDataRoot));

        builder.Services.AddHttpClient();
        builder.Services.AddMemoryCache();
        builder.Services.AddSingleton<JobManager>();
        builder.Services.AddSingleton<PowerShellLauncher>();
        builder.Services.AddSingleton<TerminalWindowLauncher>();
        builder.Services.AddSingleton<TerminalMuxSessionManager>();
        builder.Services.AddSingleton<A2aTaskManager>();
        builder.Services.AddSingleton<CodexAppServerClient>();
        builder.Services.AddSingleton<CodexSessionManager>();

        var app = builder.Build();
        try
        {

            var embeddedWebRoot = new ManifestEmbeddedFileProvider(typeof(Program).Assembly, "wwwroot");

            app.UseDefaultFiles(new DefaultFilesOptions
            {
                FileProvider = embeddedWebRoot,
            });

            app.UseStaticFiles(new StaticFileOptions
            {
                FileProvider = embeddedWebRoot,
            });

            app.MapFallback(async context =>
            {
                if (context.Request.Path.StartsWithSegments("/api")
                    || context.Request.Path.StartsWithSegments("/media")
                    || context.Request.Path.StartsWithSegments("/terminal")
                    || context.Request.Path.StartsWithSegments("/a2a")
                    || context.Request.Path.StartsWithSegments("/.well-known"))
                {
                    context.Response.StatusCode = StatusCodes.Status404NotFound;
                    return;
                }

                var requestPath = context.Request.Path.Value ?? string.Empty;
                if (Path.HasExtension(requestPath))
                {
                    context.Response.StatusCode = StatusCodes.Status404NotFound;
                    return;
                }

                var indexFile = embeddedWebRoot.GetFileInfo("index.html");
                if (!indexFile.Exists)
                {
                    context.Response.StatusCode = StatusCodes.Status404NotFound;
                    return;
                }

                context.Response.ContentType = "text/html; charset=utf-8";
                await using var stream = indexFile.CreateReadStream();
                await stream.CopyToAsync(context.Response.Body);
            });

        }
        catch (Exception)
        {
        }
        finally
        {

        }

        app.UseCors();
        app.UseSerilogRequestLogging();
        app.UseWebSockets();

        // Map all endpoints with /api prefix
        app.MapOneCodeApis();
        app.MapA2a();
        app.MapMedia();
        app.MapTerminal();
        app.MapInfo();

        if (app.Environment.IsDevelopment())
        {
            app.MapOpenApi();
        }

        if (usingDefaultUrl)
        {
            app.Logger.LogInformation("Default URL binding active: {Url}", DefaultUrl);
        }

        return app;
    }
}
