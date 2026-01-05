using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using OneCode.Contracts.FileSystem;
using OneCode.Contracts.Git;
using OneCode.Contracts.Jobs;
using OneCode.Contracts.Projects;
using OneCode.Contracts.Providers;
using OneCode.Contracts.Tools;
using OneCode.Data;
using OneCode.Data.Entities;
using OneCode.Services.Jobs;
using OneCode.Services.Shell;

namespace OneCode.Api;

public static class ApiEndpoints
{
    public static void MapOneCodeApis(this WebApplication app)
    {
        var api = app.MapGroup("/api")
            .AddEndpointFilter<ApiResponseEndpointFilter>();

        MapTools(api);
        MapJobs(api);
        MapFileSystem(api);
        MapGit(api);
        MapProviders(api);
        MapProjects(api);
    }

    private static void MapGit(RouteGroupBuilder api)
    {
        var git = api.MapGroup("/git");

        git.MapGet("/status", async (string path, CancellationToken cancellationToken) =>
        {
            var repoRoot = await ResolveGitRootAsync(path, cancellationToken);
            var branch = await TryGetGitBranchAsync(repoRoot, cancellationToken);
            var output = await RunGitAsync(repoRoot, ["status", "--porcelain"], cancellationToken);

            var entries = new List<GitStatusEntryDto>();
            foreach (var line in output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
            {
                if (line.Length < 3)
                {
                    continue;
                }

                var indexStatus = line[0].ToString();
                var worktreeStatus = line[1].ToString();
                var rest = line[2..].Trim();

                string? originalPath = null;
                var filePath = rest;

                var arrowIndex = rest.IndexOf(" -> ", StringComparison.Ordinal);
                if (arrowIndex > 0)
                {
                    originalPath = rest[..arrowIndex];
                    filePath = rest[(arrowIndex + 4)..];
                }

                entries.Add(new GitStatusEntryDto(
                    Path: filePath,
                    IndexStatus: indexStatus,
                    WorktreeStatus: worktreeStatus,
                    OriginalPath: originalPath));
            }

            return new GitStatusResponse(
                RepoRoot: repoRoot,
                Branch: branch,
                Entries: entries);
        });

        git.MapGet("/log", async (
            string path,
            CancellationToken cancellationToken,
            int maxCount = 200) =>
        {
            var repoRoot = await ResolveGitRootAsync(path, cancellationToken);
            var branch = await TryGetGitBranchAsync(repoRoot, cancellationToken);

            var normalizedMax = Math.Clamp(maxCount, 1, 500);

            var output = await TryRunGitAsync(
                repoRoot,
                ["log", "--graph", "--decorate", "--oneline", "--all", "--no-color", "--max-count", normalizedMax.ToString()],
                cancellationToken);

            var lines = string.IsNullOrWhiteSpace(output)
                ? Array.Empty<string>()
                : output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

            return new GitLogResponse(
                RepoRoot: repoRoot,
                Branch: branch,
                Lines: lines);
        });

        git.MapGet("/diff", async (string path, string file, CancellationToken cancellationToken) =>
        {
            if (string.IsNullOrWhiteSpace(file))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Missing query parameter: file");
            }

            var repoRoot = await ResolveGitRootAsync(path, cancellationToken);
            var relative = file.Trim();

            var truncated = false;

            var tracked = await IsTrackedFileAsync(repoRoot, relative, cancellationToken);
            string diff;

            if (!tracked)
            {
                diff = BuildUntrackedDiff(repoRoot, relative, out truncated);
            }
            else
            {
                diff = await TryRunGitAsync(repoRoot, ["diff", "--no-color", "HEAD", "--", relative], cancellationToken)
                    ?? await TryRunGitAsync(repoRoot, ["diff", "--no-color", "--", relative], cancellationToken)
                    ?? string.Empty;

                diff = diff.TrimEnd();
                if (diff.Length > 400_000)
                {
                    truncated = true;
                    diff = diff[..400_000] + "\n…(truncated)…";
                }
            }

            return new GitDiffResponse(
                File: relative,
                Diff: diff,
                Truncated: truncated);
        });

        git.MapPost("/commit", async ([FromBody] GitCommitRequest request, CancellationToken cancellationToken) =>
        {
            if (string.IsNullOrWhiteSpace(request.Path))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Path is required.");
            }

            if (string.IsNullOrWhiteSpace(request.Message))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Message is required.");
            }

            var repoRoot = await ResolveGitRootAsync(request.Path, cancellationToken);
            await RunGitAsync(repoRoot, ["add", "-A"], cancellationToken);

            var message = request.Message.Trim();
            await RunGitAsync(repoRoot, ["commit", "-m", message], cancellationToken);

            var hash = (await RunGitAsync(repoRoot, ["rev-parse", "HEAD"], cancellationToken)).Trim();
            var subject = (await RunGitAsync(repoRoot, ["log", "-1", "--pretty=%s"], cancellationToken)).Trim();

            return new GitCommitResponse(Hash: hash, Subject: subject);
        });
    }

    private static async Task<string> ResolveGitRootAsync(string path, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ApiHttpException(StatusCodes.Status400BadRequest, "Missing query parameter: path");
        }

        var normalizedPath = path.Trim();
        if (!Directory.Exists(normalizedPath))
        {
            throw new ApiHttpException(StatusCodes.Status400BadRequest, "Directory does not exist.");
        }

        var root = (await TryRunGitAsync(
            normalizedPath,
            ["rev-parse", "--show-toplevel"],
            cancellationToken))?.Trim();

        if (string.IsNullOrWhiteSpace(root))
        {
            throw new ApiHttpException(StatusCodes.Status400BadRequest, "Not a git repository.");
        }

        return root;
    }

    private static async Task<string?> TryGetGitBranchAsync(string repoRoot, CancellationToken cancellationToken)
    {
        var branch = await TryRunGitAsync(
            repoRoot,
            ["symbolic-ref", "--short", "HEAD"],
            cancellationToken);

        return string.IsNullOrWhiteSpace(branch) ? null : branch.Trim();
    }

    private static async Task<bool> IsTrackedFileAsync(
        string repoRoot,
        string relativePath,
        CancellationToken cancellationToken)
    {
        var result = await RunProcessAsync(
            fileName: "git",
            workingDirectory: repoRoot,
            arguments: ["ls-files", "--error-unmatch", "--", relativePath],
            cancellationToken);

        return result.ExitCode == 0;
    }

    private static string BuildUntrackedDiff(string repoRoot, string relativePath, out bool truncated)
    {
        truncated = false;
        var absolute = Path.Combine(repoRoot, relativePath);
        if (!File.Exists(absolute))
        {
            return string.Empty;
        }

        const int maxBytes = 200_000;

        byte[] buffer;
        long sizeBytes;
        try
        {
            var fileInfo = new FileInfo(absolute);
            sizeBytes = fileInfo.Length;
            var readSize = (int)Math.Min(maxBytes, Math.Max(0, sizeBytes));
            buffer = readSize == 0 ? Array.Empty<byte>() : new byte[readSize];

            if (buffer.Length > 0)
            {
                using var stream = new FileStream(
                    absolute,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite);

                var offset = 0;
                while (offset < buffer.Length)
                {
                    var read = stream.Read(buffer, offset, buffer.Length - offset);
                    if (read <= 0)
                    {
                        break;
                    }

                    offset += read;
                }

                if (offset != buffer.Length)
                {
                    buffer = buffer[..offset];
                }
            }
        }
        catch
        {
            return string.Empty;
        }

        truncated = sizeBytes > maxBytes;

        static bool LooksBinary(ReadOnlySpan<byte> bytes)
        {
            if (bytes.Length == 0)
            {
                return false;
            }

            var suspicious = 0;
            foreach (var b in bytes)
            {
                if (b == 0)
                {
                    return true;
                }

                if (b < 0x09 || (b > 0x0D && b < 0x20))
                {
                    suspicious++;
                }
            }

            return suspicious > bytes.Length / 10;
        }

        if (LooksBinary(buffer))
        {
            return $"diff --git a/{relativePath} b/{relativePath}\nnew file mode 100644\nBinary files /dev/null and b/{relativePath} differ";
        }

        var content = Encoding.UTF8.GetString(buffer);
        var sb = new StringBuilder();
        sb.AppendLine($"diff --git a/{relativePath} b/{relativePath}");
        sb.AppendLine("new file mode 100644");
        sb.AppendLine("index 0000000..e69de29");
        sb.AppendLine("--- /dev/null");
        sb.AppendLine($"+++ b/{relativePath}");
        sb.AppendLine("@@ -0,0 +1 @@");

        foreach (var line in content.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n'))
        {
            sb.Append('+');
            sb.AppendLine(line);
        }

        if (truncated)
        {
            sb.AppendLine("+…(truncated)…");
        }

        return sb.ToString().TrimEnd();
    }

    private static async Task<string> RunGitAsync(
        string repoRoot,
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken)
    {
        var result = await RunProcessAsync(
            fileName: "git",
            workingDirectory: repoRoot,
            arguments: arguments,
            cancellationToken);

        if (result.ExitCode == 0)
        {
            return result.Stdout.TrimEnd();
        }

        var msg = string.IsNullOrWhiteSpace(result.Stderr)
            ? result.Stdout
            : result.Stderr;

        msg = string.IsNullOrWhiteSpace(msg) ? "Git command failed." : msg.Trim();
        throw new ApiHttpException(StatusCodes.Status400BadRequest, msg);
    }

    private static async Task<string?> TryRunGitAsync(
        string repoRoot,
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken)
    {
        var result = await RunProcessAsync(
            fileName: "git",
            workingDirectory: repoRoot,
            arguments: arguments,
            cancellationToken);

        if (result.ExitCode != 0)
        {
            return null;
        }

        return result.Stdout.TrimEnd();
    }

    private static async Task<(int ExitCode, string Stdout, string Stderr)> RunProcessAsync(
        string fileName,
        string workingDirectory,
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken)
    {
        try
        {
            using var process = new Process();
            process.StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };

            foreach (var arg in arguments)
            {
                process.StartInfo.ArgumentList.Add(arg);
            }

            process.Start();

            var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
            var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken);

            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            return (process.ExitCode, stdout, stderr);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            throw new ApiHttpException(StatusCodes.Status500InternalServerError, "Failed to run git.");
        }
    }

    private static void MapTools(RouteGroupBuilder api)
    {
        var tools = api.MapGroup("/tools");

        tools.MapGet("/codex/status", async (CancellationToken cancellationToken) =>
        {
            var configPath = GetCodexConfigPath();
            return await GetToolStatusAsync(
                toolName: "codex",
                versionArgs: "--version",
                configPath: configPath,
                parseVersion: ParseCodexVersion,
                cancellationToken);
        });

        tools.MapGet("/claude/status", async (CancellationToken cancellationToken) =>
        {
            var configPath = GetClaudeSettingsPath();
            return await GetToolStatusAsync(
                toolName: "claude",
                versionArgs: "--version",
                configPath: configPath,
                parseVersion: ParseClaudeVersion,
                cancellationToken);
        });

        tools.MapPost("/codex/install", (JobManager jobManager, HttpContext httpContext) =>
        {
            var job = jobManager.StartProcessJob(
                kind: "install:codex",
                fileName: "npm",
                arguments: "install -g @openai/codex");
            httpContext.Response.StatusCode = StatusCodes.Status202Accepted;
            return job;
        });

        tools.MapPost("/claude/install", (JobManager jobManager, HttpContext httpContext) =>
        {
            var job = jobManager.StartProcessJob(
                kind: "install:claude",
                fileName: "npm",
                arguments: "install -g @anthropic-ai/claude-code");
            httpContext.Response.StatusCode = StatusCodes.Status202Accepted;
            return job;
        });

        tools.MapGet("/codex/token-usage", async (
            IMemoryCache cache,
            CancellationToken cancellationToken,
            bool forceRefresh = false) =>
        {
            return await GetCodexTotalTokenUsageAsync(cache, forceRefresh, cancellationToken);
        });

        tools.MapGet("/codex/token-usage/daily", async (
            IMemoryCache cache,
            CancellationToken cancellationToken,
            int days = 7,
            bool forceRefresh = false) =>
        {
            var normalizedDays = Math.Clamp(days, 1, 30);
            return await GetCodexDailyTokenUsageAsync(cache, forceRefresh, normalizedDays, cancellationToken);
        });

        tools.MapGet("/claude/token-usage", async (
            IMemoryCache cache,
            CancellationToken cancellationToken,
            bool forceRefresh = false) =>
        {
            return await GetClaudeTotalTokenUsageAsync(cache, forceRefresh, cancellationToken);
        });

        tools.MapGet("/claude/token-usage/daily", async (
            IMemoryCache cache,
            CancellationToken cancellationToken,
            int days = 7,
            bool forceRefresh = false) =>
        {
            var normalizedDays = Math.Clamp(days, 1, 30);
            return await GetClaudeDailyTokenUsageAsync(cache, forceRefresh, normalizedDays, cancellationToken);
        });
    }

    private static void MapJobs(RouteGroupBuilder api)
    {
        var jobs = api.MapGroup("/jobs");

        jobs.MapGet("/{id:guid}", (Guid id, JobManager jobManager) =>
        {
            if (!jobManager.TryGetJob(id, out var job))
            {
                throw new ApiHttpException(StatusCodes.Status404NotFound, "Job not found.");
            }

            return job;
        });
    }

    private static void MapFileSystem(RouteGroupBuilder api)
    {
        var fs = api.MapGroup("/fs");

        fs.MapGet("/drives", () =>
        {
            var drives = DriveInfo.GetDrives()
                .Where(d => d.IsReady)
                .Select(d => new DriveDto(d.Name, d.RootDirectory.FullName, d.DriveType.ToString()))
                .ToList();

            return (IReadOnlyList<DriveDto>)drives;
        });

        fs.MapGet("/list", (string path) =>
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Missing query parameter: path");
            }

            if (!Directory.Exists(path))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Directory does not exist.");
            }

            var directoryInfo = new DirectoryInfo(path);

            List<DirectoryEntryDto> directories;
            try
            {
                directories = directoryInfo.EnumerateDirectories()
                    .Where(d => (d.Attributes & FileAttributes.Hidden) == 0)
                    .OrderBy(d => d.Name, StringComparer.OrdinalIgnoreCase)
                    .Select(d => new DirectoryEntryDto(d.Name, d.FullName))
                    .ToList();
            }
            catch (UnauthorizedAccessException)
            {
                throw new ApiHttpException(StatusCodes.Status403Forbidden, "Forbidden.");
            }

            string? parent = null;
            try
            {
                parent = directoryInfo.Parent?.FullName;
            }
            catch
            {
                // ignore
            }

            return new ListDirectoriesResponse(directoryInfo.FullName, parent, directories);
        });

        fs.MapGet("/entries", (string path) =>
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Missing query parameter: path");
            }

            if (!Directory.Exists(path))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Directory does not exist.");
            }

            var directoryInfo = new DirectoryInfo(path);

            List<DirectoryEntryDto> directories;
            List<FileEntryDto> files;
            try
            {
                directories = directoryInfo.EnumerateDirectories()
                    .Where(d => (d.Attributes & FileAttributes.Hidden) == 0)
                    .OrderBy(d => d.Name, StringComparer.OrdinalIgnoreCase)
                    .Select(d => new DirectoryEntryDto(d.Name, d.FullName))
                    .ToList();

                files = directoryInfo.EnumerateFiles()
                    .Where(f => (f.Attributes & FileAttributes.Hidden) == 0)
                    .OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
                    .Select(f => new FileEntryDto(f.Name, f.FullName))
                    .ToList();
            }
            catch (UnauthorizedAccessException)
            {
                throw new ApiHttpException(StatusCodes.Status403Forbidden, "Forbidden.");
            }

            string? parent = null;
            try
            {
                parent = directoryInfo.Parent?.FullName;
            }
            catch
            {
                // ignore
            }

            return new ListEntriesResponse(directoryInfo.FullName, parent, directories, files);
        });

        fs.MapGet("/has-git", async (string path, CancellationToken cancellationToken) =>
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Missing query parameter: path");
            }

            var normalizedPath = path.Trim();
            if (!Directory.Exists(normalizedPath))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Directory does not exist.");
            }

            try
            {
                _ = await ResolveGitRootAsync(normalizedPath, cancellationToken);
                return true;
            }
            catch
            {
                // Fall back to a cheap .git check for non-git environments.
            }

            var candidate = Path.Combine(normalizedPath, ".git");
            return Directory.Exists(candidate) || File.Exists(candidate);
        });

        fs.MapGet("/file", (string path) =>
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Missing query parameter: path");
            }

            var normalizedPath = path.Trim();
            if (!File.Exists(normalizedPath))
            {
                throw new ApiHttpException(StatusCodes.Status404NotFound, "Entry not found.");
            }

            const int maxBytes = 200_000;

            try
            {
                var fileInfo = new FileInfo(normalizedPath);
                var sizeBytes = fileInfo.Length;
                var readSize = (int)Math.Min(maxBytes, Math.Max(0, sizeBytes));
                var buffer = readSize == 0 ? Array.Empty<byte>() : new byte[readSize];

                if (buffer.Length > 0)
                {
                    using var stream = new FileStream(
                        normalizedPath,
                        FileMode.Open,
                        FileAccess.Read,
                        FileShare.ReadWrite);

                    var offset = 0;
                    while (offset < buffer.Length)
                    {
                        var read = stream.Read(buffer, offset, buffer.Length - offset);
                        if (read <= 0)
                        {
                            break;
                        }

                        offset += read;
                    }

                    if (offset != buffer.Length)
                    {
                        buffer = buffer[..offset];
                    }
                }

                static bool LooksBinary(ReadOnlySpan<byte> bytes)
                {
                    if (bytes.Length == 0)
                    {
                        return false;
                    }

                    var suspicious = 0;
                    foreach (var b in bytes)
                    {
                        if (b == 0)
                        {
                            return true;
                        }

                        if (b < 0x09 || (b > 0x0D && b < 0x20))
                        {
                            suspicious++;
                        }
                    }

                    return suspicious > bytes.Length / 10;
                }

                var isBinary = LooksBinary(buffer);
                var content = isBinary ? string.Empty : Encoding.UTF8.GetString(buffer);

                return new ReadFileResponse(
                    Path: normalizedPath,
                    Content: content,
                    Truncated: sizeBytes > maxBytes,
                    IsBinary: isBinary,
                    SizeBytes: sizeBytes);
            }
            catch (UnauthorizedAccessException)
            {
                throw new ApiHttpException(StatusCodes.Status403Forbidden, "Forbidden.");
            }
            catch (Exception ex) when (ex is IOException or NotSupportedException)
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Unable to read file.");
            }
        });

        fs.MapPut("/file", ([FromBody] WriteFileRequest request) =>
        {
            if (string.IsNullOrWhiteSpace(request.Path))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Path is required.");
            }

            var normalizedPath = request.Path.Trim();
            var content = request.Content ?? string.Empty;

            const int maxChars = 1_000_000;
            if (content.Length > maxChars)
            {
                throw new ApiHttpException(StatusCodes.Status413PayloadTooLarge, "File too large.");
            }

            var parent = Path.GetDirectoryName(normalizedPath);
            if (!string.IsNullOrWhiteSpace(parent) && !Directory.Exists(parent))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Directory does not exist.");
            }

            try
            {
                File.WriteAllText(
                    normalizedPath,
                    content,
                    new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            }
            catch (UnauthorizedAccessException)
            {
                throw new ApiHttpException(StatusCodes.Status403Forbidden, "Forbidden.");
            }
            catch (Exception ex) when (ex is IOException or NotSupportedException or ArgumentException)
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Unable to write file.");
            }
        });

        fs.MapDelete("/entry", (string path) =>
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Missing query parameter: path");
            }

            var normalizedPath = path.Trim();

            if (File.Exists(normalizedPath))
            {
                try
                {
                    File.Delete(normalizedPath);
                    return;
                }
                catch (UnauthorizedAccessException)
                {
                    throw new ApiHttpException(StatusCodes.Status403Forbidden, "Forbidden.");
                }
                catch (Exception ex) when (ex is IOException or NotSupportedException)
                {
                    throw new ApiHttpException(StatusCodes.Status400BadRequest, "Unable to delete file.");
                }
            }

            if (Directory.Exists(normalizedPath))
            {
                try
                {
                    var directoryInfo = new DirectoryInfo(normalizedPath);
                    if (directoryInfo.Parent is null)
                    {
                        throw new ApiHttpException(StatusCodes.Status400BadRequest, "Refusing to delete filesystem root.");
                    }

                    Directory.Delete(directoryInfo.FullName, recursive: true);
                    return;
                }
                catch (ApiHttpException)
                {
                    throw;
                }
                catch (UnauthorizedAccessException)
                {
                    throw new ApiHttpException(StatusCodes.Status403Forbidden, "Forbidden.");
                }
                catch (Exception ex) when (ex is IOException or NotSupportedException)
                {
                    throw new ApiHttpException(StatusCodes.Status400BadRequest, "Unable to delete directory.");
                }
            }

            throw new ApiHttpException(StatusCodes.Status404NotFound, "Entry not found.");
        });

        fs.MapPost("/rename", ([FromBody] RenameEntryRequest request) =>
        {
            if (string.IsNullOrWhiteSpace(request.Path) || string.IsNullOrWhiteSpace(request.NewName))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Path and NewName are required.");
            }

            var sourcePath = request.Path.Trim();
            var newName = request.NewName.Trim();

            if (newName is "." or "..")
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Invalid new name.");
            }

            if (newName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Invalid new name.");
            }

            var isFile = File.Exists(sourcePath);
            var isDirectory = !isFile && Directory.Exists(sourcePath);
            if (!isFile && !isDirectory)
            {
                throw new ApiHttpException(StatusCodes.Status404NotFound, "Entry not found.");
            }

            var parentDirectory = Path.GetDirectoryName(sourcePath);
            if (string.IsNullOrWhiteSpace(parentDirectory))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Unable to resolve parent directory.");
            }

            var destinationPath = Path.Combine(parentDirectory, newName);
            if (string.Equals(sourcePath, destinationPath, StringComparison.OrdinalIgnoreCase))
            {
                return new RenameEntryResponse(sourcePath, destinationPath);
            }

            if (File.Exists(destinationPath) || Directory.Exists(destinationPath))
            {
                throw new ApiHttpException(StatusCodes.Status409Conflict, "Destination already exists.");
            }

            try
            {
                if (isFile)
                {
                    File.Move(sourcePath, destinationPath);
                }
                else
                {
                    var directoryInfo = new DirectoryInfo(sourcePath);
                    if (directoryInfo.Parent is null)
                    {
                        throw new ApiHttpException(StatusCodes.Status400BadRequest, "Refusing to rename filesystem root.");
                    }

                    Directory.Move(directoryInfo.FullName, destinationPath);
                }
            }
            catch (ApiHttpException)
            {
                throw;
            }
            catch (UnauthorizedAccessException)
            {
                throw new ApiHttpException(StatusCodes.Status403Forbidden, "Forbidden.");
            }
            catch (Exception ex) when (ex is IOException or NotSupportedException)
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Unable to rename entry.");
            }

            return new RenameEntryResponse(sourcePath, destinationPath);
        });

        fs.MapPost("/create", ([FromBody] CreateEntryRequest request) =>
        {
            if (string.IsNullOrWhiteSpace(request.ParentPath)
                || string.IsNullOrWhiteSpace(request.Name)
                || string.IsNullOrWhiteSpace(request.Kind))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "ParentPath, Name and Kind are required.");
            }

            var parentPath = request.ParentPath.Trim();
            var name = request.Name.Trim();
            var kind = request.Kind.Trim();

            if (!Directory.Exists(parentPath))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Parent directory does not exist.");
            }

            if (name is "." or "..")
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Invalid name.");
            }

            if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Invalid name.");
            }

            if (name.Contains(Path.DirectorySeparatorChar) || name.Contains(Path.AltDirectorySeparatorChar))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Invalid name.");
            }

            var fullPath = Path.Combine(parentPath, name);

            if (File.Exists(fullPath) || Directory.Exists(fullPath))
            {
                throw new ApiHttpException(StatusCodes.Status409Conflict, "Destination already exists.");
            }

            try
            {
                if (kind.Equals("directory", StringComparison.OrdinalIgnoreCase))
                {
                    Directory.CreateDirectory(fullPath);
                    return new CreateEntryResponse(fullPath);
                }

                if (kind.Equals("file", StringComparison.OrdinalIgnoreCase))
                {
                    using (new FileStream(fullPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                    }

                    return new CreateEntryResponse(fullPath);
                }
            }
            catch (UnauthorizedAccessException)
            {
                throw new ApiHttpException(StatusCodes.Status403Forbidden, "Forbidden.");
            }
            catch (Exception ex) when (ex is IOException or NotSupportedException)
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Unable to create entry.");
            }

            throw new ApiHttpException(StatusCodes.Status400BadRequest, "Invalid kind.");
        });

        fs.MapPost("/reveal", (string path) =>
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Missing query parameter: path");
            }

            var normalizedPath = path.Trim();

            var isFile = File.Exists(normalizedPath);
            var isDirectory = !isFile && Directory.Exists(normalizedPath);
            if (!isFile && !isDirectory)
            {
                throw new ApiHttpException(StatusCodes.Status404NotFound, "Entry not found.");
            }

            try
            {
                if (OperatingSystem.IsWindows())
                {
                    var arguments = isFile
                        ? $"/select,\"{normalizedPath}\""
                        : $"\"{normalizedPath}\"";

                    var startInfo = new ProcessStartInfo
                    {
                        FileName = "explorer.exe",
                        Arguments = arguments,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                    };

                    Process.Start(startInfo);
                    return;
                }

                var opener = OperatingSystem.IsMacOS() ? "open" : "xdg-open";
                var unixStartInfo = new ProcessStartInfo
                {
                    FileName = opener,
                    Arguments = $"\"{normalizedPath}\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };

                Process.Start(unixStartInfo);
            }
            catch
            {
                throw new ApiHttpException(StatusCodes.Status500InternalServerError, "Failed to open in file explorer.");
            }
        });

        fs.MapPost("/terminal", (string path, PowerShellLauncher powerShellLauncher) =>
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Missing query parameter: path");
            }

            var normalizedPath = path.Trim();

            string? workingDirectory = null;
            if (Directory.Exists(normalizedPath))
            {
                workingDirectory = normalizedPath;
            }
            else if (File.Exists(normalizedPath))
            {
                workingDirectory = Path.GetDirectoryName(normalizedPath);
            }

            if (string.IsNullOrWhiteSpace(workingDirectory) || !Directory.Exists(workingDirectory))
            {
                throw new ApiHttpException(StatusCodes.Status404NotFound, "Entry not found.");
            }

            var directoryInfo = new DirectoryInfo(workingDirectory);
            powerShellLauncher.LaunchNewWindow(
                workingDirectory: directoryInfo.FullName,
                windowTitle: $"OneCode - Terminal - {directoryInfo.Name}",
                command: string.Empty,
                environment: null);
        });
    }

    private static void MapProviders(RouteGroupBuilder api)
    {
        var providers = api.MapGroup("/providers");

        providers.MapGet("", async (OneCodeDbContext db, CancellationToken cancellationToken) =>
        {
            var list = await db.Providers
                .OrderBy(x => x.Name)
                .ToListAsync(cancellationToken);

            return (IReadOnlyList<ProviderDto>)list.Select(ToDto).ToList();
        });

        providers.MapGet("/{id:guid}", async (Guid id, OneCodeDbContext db, CancellationToken cancellationToken) =>
        {
            var entity = await db.Providers.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
            if (entity is null)
            {
                throw new ApiHttpException(StatusCodes.Status404NotFound, "Provider not found.");
            }

            return ToDto(entity);
        });

        providers.MapPost("", async ([FromBody] ProviderUpsertRequest request, OneCodeDbContext db, HttpContext httpContext, CancellationToken cancellationToken) =>
        {
            if (string.IsNullOrWhiteSpace(request.Name) || string.IsNullOrWhiteSpace(request.Address))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Name and Address are required.");
            }

            if (string.IsNullOrWhiteSpace(request.ApiKey))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "ApiKey is required.");
            }

            var entity = new ProviderEntity
            {
                Id = Guid.NewGuid(),
                Name = request.Name.Trim(),
                Address = request.Address.Trim(),
                Logo = string.IsNullOrWhiteSpace(request.Logo) ? null : request.Logo.Trim(),
                ApiKey = request.ApiKey,
                RequestType = request.RequestType,
                AzureApiVersion = string.IsNullOrWhiteSpace(request.AzureApiVersion) ? null : request.AzureApiVersion.Trim(),
                Models = new List<string>(),
                CreatedAtUtc = DateTimeOffset.UtcNow,
                UpdatedAtUtc = DateTimeOffset.UtcNow,
            };

            db.Providers.Add(entity);
            await db.SaveChangesAsync(cancellationToken);

            httpContext.Response.StatusCode = StatusCodes.Status201Created;
            return ToDto(entity);
        });

        providers.MapPut("/{id:guid}", async (Guid id, [FromBody] ProviderUpsertRequest request, OneCodeDbContext db, CancellationToken cancellationToken) =>
        {
            var entity = await db.Providers.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
            if (entity is null)
            {
                throw new ApiHttpException(StatusCodes.Status404NotFound, "Provider not found.");
            }

            if (string.IsNullOrWhiteSpace(request.Name) || string.IsNullOrWhiteSpace(request.Address))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Name and Address are required.");
            }

            entity.Name = request.Name.Trim();
            entity.Address = request.Address.Trim();
            entity.Logo = string.IsNullOrWhiteSpace(request.Logo) ? null : request.Logo.Trim();
            entity.RequestType = request.RequestType;
            entity.AzureApiVersion = string.IsNullOrWhiteSpace(request.AzureApiVersion) ? null : request.AzureApiVersion.Trim();
            entity.UpdatedAtUtc = DateTimeOffset.UtcNow;

            if (!string.IsNullOrWhiteSpace(request.ApiKey))
            {
                entity.ApiKey = request.ApiKey;
            }

            await db.SaveChangesAsync(cancellationToken);
            return ToDto(entity);
        });

        providers.MapDelete("/{id:guid}", async (Guid id, OneCodeDbContext db, CancellationToken cancellationToken) =>
        {
            var entity = await db.Providers.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
            if (entity is null)
            {
                throw new ApiHttpException(StatusCodes.Status404NotFound, "Provider not found.");
            }

            db.Providers.Remove(entity);
            await db.SaveChangesAsync(cancellationToken);
            return true;
        });

        providers.MapPost("/{id:guid}/refresh-models", async (Guid id, OneCodeDbContext db, IHttpClientFactory httpClientFactory, CancellationToken cancellationToken) =>
        {
            var entity = await db.Providers.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
            if (entity is null)
            {
                throw new ApiHttpException(StatusCodes.Status404NotFound, "Provider not found.");
            }

            var models = await FetchModelsAsync(httpClientFactory, entity, cancellationToken);
            entity.Models = models.Distinct(StringComparer.Ordinal).OrderBy(x => x, StringComparer.Ordinal).ToList();
            entity.ModelsRefreshedAtUtc = DateTimeOffset.UtcNow;
            entity.UpdatedAtUtc = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(cancellationToken);

            return ToDto(entity);
        });
    }

    private static void MapProjects(RouteGroupBuilder api)
    {
        var projects = api.MapGroup("/projects");

        projects.MapGet("", async (ToolType toolType, OneCodeDbContext db, CancellationToken cancellationToken) =>
        {
            var list = await db.Projects
                .Include(x => x.Provider)
                .Where(x => x.ToolType == toolType)
                .OrderBy(x => x.Name)
                .ToListAsync(cancellationToken);

            return (IReadOnlyList<ProjectDto>)list.Select(ToDto).ToList();
        });

        projects.MapGet("/{id:guid}", async (Guid id, OneCodeDbContext db, CancellationToken cancellationToken) =>
        {
            var project = await db.Projects
                .Include(x => x.Provider)
                .FirstOrDefaultAsync(x => x.Id == id, cancellationToken);

            if (project is null)
            {
                throw new ApiHttpException(StatusCodes.Status404NotFound, "Project not found.");
            }

            return ToDto(project);
        });

        projects.MapPost("", async (
            [FromBody] ProjectUpsertRequest request,
            OneCodeDbContext db,
            HttpContext httpContext,
            CancellationToken cancellationToken) =>
        {
            if (string.IsNullOrWhiteSpace(request.Name))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Name is required.");
            }

            if (string.IsNullOrWhiteSpace(request.WorkspacePath))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "WorkspacePath is required.");
            }

            if (!Directory.Exists(request.WorkspacePath))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "WorkspacePath does not exist.");
            }

            if (request.ProviderId.HasValue)
            {
                var providerExists = await db.Providers.AnyAsync(x => x.Id == request.ProviderId, cancellationToken);
                if (!providerExists)
                {
                    throw new ApiHttpException(StatusCodes.Status400BadRequest, "ProviderId does not exist.");
                }
            }

            var entity = new ProjectEntity
            {
                Id = Guid.NewGuid(),
                ToolType = request.ToolType,
                Name = request.Name.Trim(),
                WorkspacePath = request.WorkspacePath.Trim(),
                ProviderId = request.ProviderId,
                Model = string.IsNullOrWhiteSpace(request.Model) ? null : request.Model.Trim(),
                CreatedAtUtc = DateTimeOffset.UtcNow,
                UpdatedAtUtc = DateTimeOffset.UtcNow,
            };

            db.Projects.Add(entity);
            try
            {
                await db.SaveChangesAsync(cancellationToken);
            }
            catch (DbUpdateException)
            {
                throw new ApiHttpException(StatusCodes.Status409Conflict, "Project name already exists for this tool type.");
            }

            await db.Entry(entity).Reference(x => x.Provider).LoadAsync(cancellationToken);
            httpContext.Response.StatusCode = StatusCodes.Status201Created;
            return ToDto(entity);
        });

        projects.MapPut("/{id:guid}", async (
            Guid id,
            [FromBody] ProjectUpsertRequest request,
            OneCodeDbContext db,
            CancellationToken cancellationToken) =>
        {
            var entity = await db.Projects.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
            if (entity is null)
            {
                throw new ApiHttpException(StatusCodes.Status404NotFound, "Project not found.");
            }

            if (string.IsNullOrWhiteSpace(request.Name))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "Name is required.");
            }

            if (string.IsNullOrWhiteSpace(request.WorkspacePath))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "WorkspacePath is required.");
            }

            if (!Directory.Exists(request.WorkspacePath))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "WorkspacePath does not exist.");
            }

            if (request.ProviderId.HasValue)
            {
                var providerExists = await db.Providers.AnyAsync(x => x.Id == request.ProviderId, cancellationToken);
                if (!providerExists)
                {
                    throw new ApiHttpException(StatusCodes.Status400BadRequest, "ProviderId does not exist.");
                }
            }

            entity.ToolType = request.ToolType;
            entity.Name = request.Name.Trim();
            entity.WorkspacePath = request.WorkspacePath.Trim();
            entity.ProviderId = request.ProviderId;
            entity.Model = string.IsNullOrWhiteSpace(request.Model) ? null : request.Model.Trim();
            entity.UpdatedAtUtc = DateTimeOffset.UtcNow;

            try
            {
                await db.SaveChangesAsync(cancellationToken);
            }
            catch (DbUpdateException)
            {
                throw new ApiHttpException(StatusCodes.Status409Conflict, "Project name already exists for this tool type.");
            }

            await db.Entry(entity).Reference(x => x.Provider).LoadAsync(cancellationToken);
            return ToDto(entity);
        });

        projects.MapDelete("/{id:guid}", async (Guid id, OneCodeDbContext db, CancellationToken cancellationToken) =>
        {
            var entity = await db.Projects.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
            if (entity is null)
            {
                throw new ApiHttpException(StatusCodes.Status404NotFound, "Project not found.");
            }

            db.Projects.Remove(entity);
            await db.SaveChangesAsync(cancellationToken);
            return true;
        });

        projects.MapPost("/{id:guid}/start", async (
            Guid id,
            OneCodeDbContext db,
            PowerShellLauncher powerShellLauncher,
            CancellationToken cancellationToken) =>
        {
            var project = await db.Projects
                .Include(x => x.Provider)
                .FirstOrDefaultAsync(x => x.Id == id, cancellationToken);

            if (project is null)
            {
                throw new ApiHttpException(StatusCodes.Status404NotFound, "Project not found.");
            }

            if (!Directory.Exists(project.WorkspacePath))
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, "WorkspacePath does not exist.");
            }

            (string Command, IReadOnlyDictionary<string, string>? Env) launch;
            try
            {
                launch = project.ToolType switch
                {
                    ToolType.Codex => BuildCodexLaunch(project),
                    ToolType.ClaudeCode => BuildClaudeLaunch(project),
                    _ => throw new ArgumentOutOfRangeException(),
                };
            }
            catch (InvalidOperationException ex)
            {
                throw new ApiHttpException(StatusCodes.Status400BadRequest, ex.Message);
            }

            powerShellLauncher.LaunchNewWindow(
                workingDirectory: project.WorkspacePath,
                windowTitle: $"OneCode - {project.ToolType} - {project.Name}",
                command: launch.Command,
                environment: launch.Env);

            project.LastStartedAtUtc = DateTimeOffset.UtcNow;
            project.UpdatedAtUtc = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(cancellationToken);
            return true;
        });

        projects.MapGet("/{id:guid}/sessions", async (
            Guid id,
            OneCodeDbContext db,
            CancellationToken cancellationToken) =>
        {
            var project = await db.Projects.FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
            if (project is null)
            {
                throw new ApiHttpException(StatusCodes.Status404NotFound, "Project not found.");
            }

            if (project.ToolType == ToolType.Codex)
            {
                var sessionsRoot = Path.Combine(GetCodexHomePath(), "sessions");
                if (!Directory.Exists(sessionsRoot))
                {
                    return Array.Empty<ProjectSessionDto>();
                }

                var results = new List<ProjectSessionDto>();
                foreach (var filePath in Directory.EnumerateFiles(sessionsRoot, "*.jsonl", SearchOption.AllDirectories))
                {
                    cancellationToken.ThrowIfCancellationRequested();

                    var meta = await TryReadCodexSessionMetaAsync(filePath, cancellationToken);
                    if (meta is null)
                    {
                        continue;
                    }

                    if (!IsSameOrDescendantPath(project.WorkspacePath, meta.Cwd))
                    {
                        continue;
                    }

                    var session = await TryBuildCodexSessionSummaryAsync(filePath, meta, cancellationToken);
                    if (session is not null)
                    {
                        results.Add(session);
                    }
                }

                return results
                    .OrderByDescending(x => x.CreatedAtUtc)
                    .ToArray();
            }

            if (project.ToolType == ToolType.ClaudeCode)
            {
                var claudeProjectsRoot = GetClaudeProjectsPath();
                if (!Directory.Exists(claudeProjectsRoot))
                {
                    return Array.Empty<ProjectSessionDto>();
                }

                var sessionsById = new Dictionary<string, (ClaudeSessionMeta Meta, List<string> Files)>(StringComparer.Ordinal);

                foreach (var filePath in Directory.EnumerateFiles(claudeProjectsRoot, "*.jsonl", SearchOption.AllDirectories))
                {
                    cancellationToken.ThrowIfCancellationRequested();

                    var meta = await TryReadClaudeSessionMetaAsync(filePath, cancellationToken);
                    if (meta is null)
                    {
                        continue;
                    }

                    if (!IsSameOrDescendantPath(project.WorkspacePath, meta.Cwd))
                    {
                        continue;
                    }

                    if (sessionsById.TryGetValue(meta.Id, out var existing))
                    {
                        existing.Files.Add(filePath);
                        var bestMeta = existing.Meta.CreatedAtUtc <= meta.CreatedAtUtc ? existing.Meta : meta;
                        sessionsById[meta.Id] = (bestMeta, existing.Files);
                        continue;
                    }

                    sessionsById[meta.Id] = (meta, new List<string> { filePath });
                }

                var results = new List<ProjectSessionDto>();
                foreach (var entry in sessionsById.Values)
                {
                    cancellationToken.ThrowIfCancellationRequested();

                    var session = await TryBuildClaudeSessionSummaryAsync(entry.Files, entry.Meta, cancellationToken);
                    if (session is not null)
                    {
                        results.Add(session);
                    }
                }

                return results
                    .OrderByDescending(x => x.CreatedAtUtc)
                    .ToArray();
            }

            throw new ApiHttpException(StatusCodes.Status400BadRequest, "Only Codex and Claude Code sessions are supported.");
        });

        projects.MapGet("/scan-codex-sessions", async (
            ToolType toolType,
            OneCodeDbContext db,
            HttpContext httpContext,
            CancellationToken cancellationToken) =>
        {
            var response = httpContext.Response;
            response.Headers.CacheControl = "no-cache";
            response.Headers.Connection = "keep-alive";
            response.Headers.Append("X-Accel-Buffering", "no");
            response.ContentType = "text/event-stream";

            await using var writer = new StreamWriter(response.Body, Encoding.UTF8, leaveOpen: true);
            var connected = true;

            async Task<bool> TrySendAsync(string eventName, string data)
            {
                if (!connected)
                {
                    return false;
                }

                try
                {
                    if (!string.IsNullOrWhiteSpace(eventName))
                    {
                        await writer.WriteAsync($"event: {eventName}\n");
                    }

                    var normalized = (data ?? string.Empty)
                        .Replace("\r\n", "\n", StringComparison.Ordinal)
                        .Replace('\r', '\n');

                    foreach (var line in normalized.Split('\n'))
                    {
                        await writer.WriteAsync($"data: {line}\n");
                    }

                    await writer.WriteAsync("\n");
                    await writer.FlushAsync(cancellationToken);
                    return true;
                }
                catch (OperationCanceledException)
                {
                    connected = false;
                    return false;
                }
                catch (IOException)
                {
                    connected = false;
                    return false;
                }
            }

            Task<bool> LogAsync(string message)
                => TrySendAsync("log", $"[{DateTimeOffset.Now:HH:mm:ss}] {message}");

            async Task SendDoneAsync(object payload)
            {
                await TrySendAsync("done", JsonSerializer.Serialize(payload));
            }

            if (toolType == ToolType.ClaudeCode)
            {
                var projectsRoot = GetClaudeProjectsPath();
                if (!await LogAsync($"开始扫描：{projectsRoot}"))
                {
                    return Results.Empty;
                }

                if (!Directory.Exists(projectsRoot))
                {
                    await LogAsync("Claude projects 目录不存在，未执行扫描。");
                    await SendDoneAsync(new
                    {
                        scannedFiles = 0,
                        uniqueCwds = 0,
                        created = 0,
                        skippedExisting = 0,
                        skippedMissingWorkspace = 0,
                        readErrors = 0,
                        jsonErrors = 0,
                    });
                    return Results.Empty;
                }

                string[] projectDirs;
                try
                {
                    projectDirs = Directory.EnumerateDirectories(projectsRoot).ToArray();
                }
                catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
                {
                    await LogAsync($"读取 Claude projects 目录失败：{ex.Message}");
                    await SendDoneAsync(new
                    {
                        scannedFiles = 0,
                        uniqueCwds = 0,
                        created = 0,
                        skippedExisting = 0,
                        skippedMissingWorkspace = 0,
                        readErrors = 0,
                        jsonErrors = 0,
                    });
                    return Results.Empty;
                }

                await LogAsync($"发现 Claude projects 目录：{projectDirs.Length}");

                var claudeUniqueCwds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var claudeReadErrors = 0;
                var claudeJsonErrors = 0;

                for (var i = 0; i < projectDirs.Length; i++)
                {
                    if (!connected || cancellationToken.IsCancellationRequested)
                    {
                        return Results.Empty;
                    }

                    var dir = projectDirs[i];
                    var dirName = Path.GetFileName(dir);
                    if (string.IsNullOrWhiteSpace(dirName))
                    {
                        continue;
                    }

                    string? cwd = null;
                    try
                    {
                        foreach (var filePath in Directory.EnumerateFiles(dir, "*.jsonl", SearchOption.TopDirectoryOnly))
                        {
                            cancellationToken.ThrowIfCancellationRequested();

                            string? firstLine;
                            try
                            {
                                await using var stream = File.OpenRead(filePath);
                                using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
                                firstLine = await reader.ReadLineAsync(cancellationToken);
                            }
                            catch (OperationCanceledException)
                            {
                                return Results.Empty;
                            }
                            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                            {
                                claudeReadErrors++;
                                if (claudeReadErrors <= 10)
                                {
                                    await LogAsync($"读取失败：{filePath}（{ex.Message}）");
                                }

                                continue;
                            }

                            if (string.IsNullOrWhiteSpace(firstLine))
                            {
                                continue;
                            }

                            firstLine = firstLine.Trim().TrimStart('\uFEFF');

                            try
                            {
                                using var doc = JsonDocument.Parse(firstLine);
                                if (doc.RootElement.TryGetProperty("cwd", out var cwdProp)
                                    && cwdProp.ValueKind == JsonValueKind.String)
                                {
                                    cwd = cwdProp.GetString();
                                }
                            }
                            catch (JsonException)
                            {
                                claudeJsonErrors++;
                                if (claudeJsonErrors <= 10)
                                {
                                    await LogAsync($"JSON 解析失败：{filePath}");
                                }

                                continue;
                            }

                            if (!string.IsNullOrWhiteSpace(cwd))
                            {
                                break;
                            }
                        }
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                    {
                        claudeReadErrors++;
                        if (claudeReadErrors <= 10)
                        {
                            await LogAsync($"读取 Claude 项目目录失败：{dir}（{ex.Message}）");
                        }
                    }

                    string workspacePath;
                    if (!string.IsNullOrWhiteSpace(cwd))
                    {
                        workspacePath = cwd!;
                    }
                    else if (!TryDecodeClaudeProjectDirectoryName(dirName, out workspacePath))
                    {
                        claudeJsonErrors++;
                        if (claudeJsonErrors <= 10)
                        {
                            await LogAsync($"Claude projects 目录无法解析，跳过：{dirName}");
                        }

                        continue;
                    }

                    var trimmed = workspacePath.Trim();
                    if (trimmed.Length == 0)
                    {
                        continue;
                    }

                    if (claudeUniqueCwds.Add(trimmed) && claudeUniqueCwds.Count <= 30)
                    {
                        await LogAsync($"发现项目 cwd：{trimmed}");
                    }

                    if ((i + 1) % 1000 == 0)
                    {
                        await LogAsync($"扫描进度：{i + 1}/{projectDirs.Length}，已发现 cwd：{claudeUniqueCwds.Count}");
                    }
                }

                if (claudeUniqueCwds.Count > 30)
                {
                    await LogAsync($"发现 cwd 数：{claudeUniqueCwds.Count}（后续仅展示创建/跳过日志）");
                }

                var claudeExistingProjects = await db.Projects
                    .Where(x => x.ToolType == toolType)
                    .Select(x => new { x.Name, x.WorkspacePath })
                    .ToListAsync(cancellationToken);

                var claudeExistingNameSet = new HashSet<string>(
                    claudeExistingProjects.Select(x => x.Name),
                    StringComparer.OrdinalIgnoreCase);
                var claudeExistingWorkspaceSet = new HashSet<string>(
                    claudeExistingProjects.Select(x => x.WorkspacePath),
                    StringComparer.OrdinalIgnoreCase);

                var claudeWorkspaceToName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var project in claudeExistingProjects)
                {
                    if (!claudeWorkspaceToName.ContainsKey(project.WorkspacePath))
                    {
                        claudeWorkspaceToName[project.WorkspacePath] = project.Name;
                    }
                }

                var claudeCreated = 0;
                var claudeSkippedExisting = 0;
                var claudeSkippedMissingWorkspace = 0;
                var claudeLoggedExistingSkips = 0;
                var claudeLoggedMissingSkips = 0;
                var claudeLoggedNameConflicts = 0;

                await LogAsync("开始创建项目…");

                foreach (var cwd in claudeUniqueCwds.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
                {
                    if (!connected || cancellationToken.IsCancellationRequested)
                    {
                        return Results.Empty;
                    }

                    var workspacePath = cwd.Trim();
                    if (!Directory.Exists(workspacePath))
                    {
                        claudeSkippedMissingWorkspace++;
                        if (claudeLoggedMissingSkips < 20)
                        {
                            claudeLoggedMissingSkips++;
                            await LogAsync($"目录不存在，跳过：{workspacePath}");
                        }

                        continue;
                    }

                    if (claudeExistingWorkspaceSet.Contains(workspacePath))
                    {
                        claudeSkippedExisting++;
                        if (claudeLoggedExistingSkips < 20)
                        {
                            claudeLoggedExistingSkips++;
                            if (claudeWorkspaceToName.TryGetValue(workspacePath, out var existingName))
                            {
                                await LogAsync($"工作空间已存在，跳过：{workspacePath}（{existingName}）");
                            }
                            else
                            {
                                await LogAsync($"工作空间已存在，跳过：{workspacePath}");
                            }
                        }

                        continue;
                    }

                    var name = BuildProjectNameFromCwd(workspacePath);
                    var uniqueName = EnsureUniqueProjectName(name, workspacePath, claudeExistingNameSet);
                    if (!string.Equals(uniqueName, name, StringComparison.OrdinalIgnoreCase))
                    {
                        if (claudeLoggedNameConflicts < 20)
                        {
                            claudeLoggedNameConflicts++;
                            await LogAsync($"项目名冲突，已自动追加后缀：{name} -> {uniqueName}");
                        }

                        name = uniqueName;
                    }

                    if (claudeExistingNameSet.Contains(name))
                    {
                        claudeSkippedExisting++;
                        if (claudeLoggedExistingSkips < 20)
                        {
                            claudeLoggedExistingSkips++;
                            await LogAsync($"已存在，跳过：{name}");
                        }

                        continue;
                    }

                    var entity = new ProjectEntity
                    {
                        Id = Guid.NewGuid(),
                        ToolType = toolType,
                        Name = name,
                        WorkspacePath = workspacePath,
                        ProviderId = null,
                        Model = null,
                        CreatedAtUtc = DateTimeOffset.UtcNow,
                        UpdatedAtUtc = DateTimeOffset.UtcNow,
                    };

                    db.Projects.Add(entity);
                    try
                    {
                        await db.SaveChangesAsync(cancellationToken);
                        claudeCreated++;
                        claudeExistingNameSet.Add(name);
                        claudeExistingWorkspaceSet.Add(workspacePath);
                        claudeWorkspaceToName[workspacePath] = name;
                        await LogAsync($"已创建：{name}");
                    }
                    catch (OperationCanceledException)
                    {
                        return Results.Empty;
                    }
                    catch (DbUpdateException)
                    {
                        db.Entry(entity).State = EntityState.Detached;
                        claudeSkippedExisting++;
                        if (claudeLoggedExistingSkips < 20)
                        {
                            claudeLoggedExistingSkips++;
                            await LogAsync($"创建冲突，跳过：{name}");
                        }
                    }
                }

                await LogAsync($"完成：创建 {claudeCreated}，跳过已存在 {claudeSkippedExisting}，跳过不存在目录 {claudeSkippedMissingWorkspace}。");
                await SendDoneAsync(new
                {
                    scannedFiles = projectDirs.Length,
                    uniqueCwds = claudeUniqueCwds.Count,
                    created = claudeCreated,
                    skippedExisting = claudeSkippedExisting,
                    skippedMissingWorkspace = claudeSkippedMissingWorkspace,
                    readErrors = claudeReadErrors,
                    jsonErrors = claudeJsonErrors,
                });

                return Results.Empty;
            }

            if (toolType != ToolType.Codex)
            {
                await LogAsync("当前仅支持从 Codex / Claude sessions 扫描项目。");
                await SendDoneAsync(new
                {
                    scannedFiles = 0,
                    uniqueCwds = 0,
                    created = 0,
                    skippedExisting = 0,
                    skippedMissingWorkspace = 0,
                    readErrors = 0,
                    jsonErrors = 0,
                });
                return Results.Empty;
            }

            var sessionsRoot = Path.Combine(GetCodexHomePath(), "sessions");
            if (!await LogAsync($"开始扫描：{sessionsRoot}"))
            {
                return Results.Empty;
            }

            if (!Directory.Exists(sessionsRoot))
            {
                await LogAsync("sessions 目录不存在，未执行扫描。");
                await SendDoneAsync(new
                {
                    scannedFiles = 0,
                    uniqueCwds = 0,
                    created = 0,
                    skippedExisting = 0,
                    skippedMissingWorkspace = 0,
                    readErrors = 0,
                    jsonErrors = 0,
                });
                return Results.Empty;
            }

            string[] jsonlFiles;
            try
            {
                jsonlFiles = Directory.EnumerateFiles(sessionsRoot, "*.jsonl", SearchOption.AllDirectories).ToArray();
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
            {
                await LogAsync($"读取 sessions 目录失败：{ex.Message}");
                await SendDoneAsync(new
                {
                    scannedFiles = 0,
                    uniqueCwds = 0,
                    created = 0,
                    skippedExisting = 0,
                    skippedMissingWorkspace = 0,
                    readErrors = 0,
                    jsonErrors = 0,
                });
                return Results.Empty;
            }

            await LogAsync($"发现 .jsonl 文件：{jsonlFiles.Length}");

            var uniqueCwds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var readErrors = 0;
            var jsonErrors = 0;

            for (var i = 0; i < jsonlFiles.Length; i++)
            {
                if (!connected || cancellationToken.IsCancellationRequested)
                {
                    return Results.Empty;
                }

                var file = jsonlFiles[i];
                string? firstLine;
                try
                {
                    await using var stream = File.OpenRead(file);
                    using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
                    firstLine = await reader.ReadLineAsync(cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    return Results.Empty;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    readErrors++;
                    if (readErrors <= 10)
                    {
                        await LogAsync($"读取失败：{file}（{ex.Message}）");
                    }

                    continue;
                }

                if (string.IsNullOrWhiteSpace(firstLine))
                {
                    continue;
                }

                firstLine = firstLine.Trim().TrimStart('\uFEFF');

                string? cwd = null;
                try
                {
                    using var doc = JsonDocument.Parse(firstLine);
                    if (doc.RootElement.TryGetProperty("payload", out var payload)
                        && payload.ValueKind == JsonValueKind.Object
                        && payload.TryGetProperty("cwd", out var cwdProp)
                        && cwdProp.ValueKind == JsonValueKind.String)
                    {
                        cwd = cwdProp.GetString();
                    }
                }
                catch (JsonException)
                {
                    jsonErrors++;
                    if (jsonErrors <= 10)
                    {
                        await LogAsync($"JSON 解析失败：{file}");
                    }

                    continue;
                }

                if (string.IsNullOrWhiteSpace(cwd))
                {
                    continue;
                }

                var trimmed = cwd.Trim();
                if (trimmed.Length == 0)
                {
                    continue;
                }

                if (uniqueCwds.Add(trimmed) && uniqueCwds.Count <= 30)
                {
                    await LogAsync($"发现项目 cwd：{trimmed}");
                }

                if ((i + 1) % 1000 == 0)
                {
                    await LogAsync($"扫描进度：{i + 1}/{jsonlFiles.Length}，已发现 cwd：{uniqueCwds.Count}");
                }
            }

            if (uniqueCwds.Count > 30)
            {
                await LogAsync($"发现 cwd 数：{uniqueCwds.Count}（后续仅展示创建/跳过日志）");
            }

            var existingProjects = await db.Projects
                .Where(x => x.ToolType == toolType)
                .Select(x => new { x.Name, x.WorkspacePath })
                .ToListAsync(cancellationToken);

            var existingNameSet = new HashSet<string>(
                existingProjects.Select(x => x.Name),
                StringComparer.OrdinalIgnoreCase);
            var existingWorkspaceSet = new HashSet<string>(
                existingProjects.Select(x => x.WorkspacePath),
                StringComparer.OrdinalIgnoreCase);

            var workspaceToName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var project in existingProjects)
            {
                if (!workspaceToName.ContainsKey(project.WorkspacePath))
                {
                    workspaceToName[project.WorkspacePath] = project.Name;
                }
            }

            var created = 0;
            var skippedExisting = 0;
            var skippedMissingWorkspace = 0;
            var loggedExistingSkips = 0;
            var loggedMissingSkips = 0;
            var loggedNameConflicts = 0;

            await LogAsync("开始创建项目…");

            foreach (var cwd in uniqueCwds.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                if (!connected || cancellationToken.IsCancellationRequested)
                {
                    return Results.Empty;
                }

                var workspacePath = cwd.Trim();
                if (!Directory.Exists(workspacePath))
                {
                    skippedMissingWorkspace++;
                    if (loggedMissingSkips < 20)
                    {
                        loggedMissingSkips++;
                        await LogAsync($"目录不存在，跳过：{workspacePath}");
                    }

                    continue;
                }

                if (existingWorkspaceSet.Contains(workspacePath))
                {
                    skippedExisting++;
                    if (loggedExistingSkips < 20)
                    {
                        loggedExistingSkips++;
                        if (workspaceToName.TryGetValue(workspacePath, out var existingName))
                        {
                            await LogAsync($"工作空间已存在，跳过：{workspacePath}（{existingName}）");
                        }
                        else
                        {
                            await LogAsync($"工作空间已存在，跳过：{workspacePath}");
                        }
                    }

                    continue;
                }

                var name = BuildProjectNameFromCwd(workspacePath);
                var uniqueName = EnsureUniqueProjectName(name, workspacePath, existingNameSet);
                if (!string.Equals(uniqueName, name, StringComparison.OrdinalIgnoreCase))
                {
                    if (loggedNameConflicts < 20)
                    {
                        loggedNameConflicts++;
                        await LogAsync($"项目名冲突，已自动追加后缀：{name} -> {uniqueName}");
                    }

                    name = uniqueName;
                }

                if (existingNameSet.Contains(name))
                {
                    skippedExisting++;
                    if (loggedExistingSkips < 20)
                    {
                        loggedExistingSkips++;
                        await LogAsync($"已存在，跳过：{name}");
                    }

                    continue;
                }

                var entity = new ProjectEntity
                {
                    Id = Guid.NewGuid(),
                    ToolType = toolType,
                    Name = name,
                    WorkspacePath = workspacePath,
                    ProviderId = null,
                    Model = null,
                    CreatedAtUtc = DateTimeOffset.UtcNow,
                    UpdatedAtUtc = DateTimeOffset.UtcNow,
                };

                db.Projects.Add(entity);
                try
                {
                    await db.SaveChangesAsync(cancellationToken);
                    created++;
                    existingNameSet.Add(name);
                    existingWorkspaceSet.Add(workspacePath);
                    workspaceToName[workspacePath] = name;
                    await LogAsync($"已创建：{name}");
                }
                catch (OperationCanceledException)
                {
                    return Results.Empty;
                }
                catch (DbUpdateException)
                {
                    db.Entry(entity).State = EntityState.Detached;
                    skippedExisting++;
                    if (loggedExistingSkips < 20)
                    {
                        loggedExistingSkips++;
                        await LogAsync($"创建冲突，跳过：{name}");
                    }
                }
            }

            await LogAsync($"完成：创建 {created}，跳过已存在 {skippedExisting}，跳过不存在目录 {skippedMissingWorkspace}。");
            await SendDoneAsync(new
            {
                scannedFiles = jsonlFiles.Length,
                uniqueCwds = uniqueCwds.Count,
                created,
                skippedExisting,
                skippedMissingWorkspace,
                readErrors,
                jsonErrors,
            });

            return Results.Empty;
        });
    }

    // Shared helpers implemented below

    private sealed record CodexSessionMeta(
        string Id,
        string Cwd,
        DateTimeOffset CreatedAtUtc);

    private sealed record ClaudeSessionMeta(
        string Id,
        string Cwd,
        DateTimeOffset CreatedAtUtc);

    private enum CodexSessionEventKind
    {
        Message = 0,
        FunctionCall = 1,
        AgentReasoning = 2,
        TokenCount = 3,
        Other = 4,
    }

    private sealed record CodexTokenUsageSnapshot(
        long InputTokens,
        long CachedInputTokens,
        long OutputTokens,
        long ReasoningOutputTokens)
    {
        public long PrefillTokens => InputTokens + CachedInputTokens;
        public long GenTokens => OutputTokens + ReasoningOutputTokens;
        public long TotalTokens => PrefillTokens + GenTokens;
    }

    private const string CodexTotalTokenUsageCacheKey = "codex:token-usage:total:v1";
    private static readonly SemaphoreSlim CodexTotalTokenUsageLock = new(1, 1);
    private static string GetCodexDailyTokenUsageCacheKey(int days) =>
        $"codex:token-usage:daily:{days}:v1";
    private static readonly SemaphoreSlim CodexDailyTokenUsageLock = new(1, 1);

    private const string ClaudeTotalTokenUsageCacheKey = "claude:token-usage:total:v1";
    private static readonly SemaphoreSlim ClaudeTotalTokenUsageLock = new(1, 1);
    private static string GetClaudeDailyTokenUsageCacheKey(int days) =>
        $"claude:token-usage:daily:{days}:v1";
    private static readonly SemaphoreSlim ClaudeDailyTokenUsageLock = new(1, 1);

    private static async Task<SessionTokenUsageDto> GetCodexTotalTokenUsageAsync(
        IMemoryCache cache,
        bool forceRefresh,
        CancellationToken cancellationToken)
    {
        if (!forceRefresh
            && cache.TryGetValue(CodexTotalTokenUsageCacheKey, out SessionTokenUsageDto? cached)
            && cached is not null)
        {
            return cached;
        }

        await CodexTotalTokenUsageLock.WaitAsync(cancellationToken);
        try
        {
            if (!forceRefresh
                && cache.TryGetValue(CodexTotalTokenUsageCacheKey, out cached)
                && cached is not null)
            {
                return cached;
            }

            var computed = await ComputeCodexTotalTokenUsageAsync(cancellationToken);
            cache.Set(
                CodexTotalTokenUsageCacheKey,
                computed,
                new MemoryCacheEntryOptions
                {
                    AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(2),
                });
            return computed;
        }
        finally
        {
            CodexTotalTokenUsageLock.Release();
        }
    }

    private static async Task<SessionTokenUsageDto> GetClaudeTotalTokenUsageAsync(
        IMemoryCache cache,
        bool forceRefresh,
        CancellationToken cancellationToken)
    {
        if (!forceRefresh
            && cache.TryGetValue(ClaudeTotalTokenUsageCacheKey, out SessionTokenUsageDto? cached)
            && cached is not null)
        {
            return cached;
        }

        await ClaudeTotalTokenUsageLock.WaitAsync(cancellationToken);
        try
        {
            if (!forceRefresh
                && cache.TryGetValue(ClaudeTotalTokenUsageCacheKey, out cached)
                && cached is not null)
            {
                return cached;
            }

            var computed = await ComputeClaudeTotalTokenUsageAsync(cancellationToken);
            cache.Set(
                ClaudeTotalTokenUsageCacheKey,
                computed,
                new MemoryCacheEntryOptions
                {
                    AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(2),
                });
            return computed;
        }
        finally
        {
            ClaudeTotalTokenUsageLock.Release();
        }
    }

    private static async Task<SessionTokenUsageDto> ComputeCodexTotalTokenUsageAsync(
        CancellationToken cancellationToken)
    {
        var sessionsRoot = Path.Combine(GetCodexHomePath(), "sessions");
        if (!Directory.Exists(sessionsRoot))
        {
            return new SessionTokenUsageDto(0, 0, 0, 0);
        }

        string[] jsonlFiles;
        try
        {
            jsonlFiles = Directory.EnumerateFiles(sessionsRoot, "*.jsonl", SearchOption.AllDirectories)
                .ToArray();
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            return new SessionTokenUsageDto(0, 0, 0, 0);
        }

        var inputTokens = 0L;
        var cachedInputTokens = 0L;
        var outputTokens = 0L;
        var reasoningOutputTokens = 0L;

        foreach (var filePath in jsonlFiles)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var usage = await TryReadCodexSessionTokenUsageAsync(filePath, cancellationToken);
            if (usage is null || usage.TotalTokens <= 0)
            {
                continue;
            }

            inputTokens += usage.InputTokens;
            cachedInputTokens += usage.CachedInputTokens;
            outputTokens += usage.OutputTokens;
            reasoningOutputTokens += usage.ReasoningOutputTokens;
        }

        return new SessionTokenUsageDto(inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens);
    }

    private static async Task<SessionTokenUsageDto> ComputeClaudeTotalTokenUsageAsync(
        CancellationToken cancellationToken)
    {
        var projectsRoot = GetClaudeProjectsPath();
        if (!Directory.Exists(projectsRoot))
        {
            return new SessionTokenUsageDto(0, 0, 0, 0);
        }

        string[] jsonlFiles;
        try
        {
            jsonlFiles = Directory.EnumerateFiles(projectsRoot, "*.jsonl", SearchOption.AllDirectories)
                .ToArray();
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            return new SessionTokenUsageDto(0, 0, 0, 0);
        }

        var inputTokens = 0L;
        var cachedInputTokens = 0L;
        var outputTokens = 0L;
        var reasoningOutputTokens = 0L;

        foreach (var filePath in jsonlFiles)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var usage = await TryReadClaudeSessionTokenUsageAsync(filePath, cancellationToken);
            if (usage is null || usage.TotalTokens <= 0)
            {
                continue;
            }

            inputTokens += usage.InputTokens;
            cachedInputTokens += usage.CachedInputTokens;
            outputTokens += usage.OutputTokens;
            reasoningOutputTokens += usage.ReasoningOutputTokens;
        }

        return new SessionTokenUsageDto(inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens);
    }

    private static async Task<IReadOnlyList<CodexDailyTokenUsageDto>> GetCodexDailyTokenUsageAsync(
        IMemoryCache cache,
        bool forceRefresh,
        int days,
        CancellationToken cancellationToken)
    {
        days = Math.Clamp(days, 1, 30);
        var cacheKey = GetCodexDailyTokenUsageCacheKey(days);

        if (!forceRefresh
            && cache.TryGetValue(cacheKey, out IReadOnlyList<CodexDailyTokenUsageDto>? cached)
            && cached is not null)
        {
            return cached;
        }

        await CodexDailyTokenUsageLock.WaitAsync(cancellationToken);
        try
        {
            if (!forceRefresh
                && cache.TryGetValue(cacheKey, out cached)
                && cached is not null)
            {
                return cached;
            }

            var computed = await ComputeCodexDailyTokenUsageAsync(days, cancellationToken);
            cache.Set(
                cacheKey,
                computed,
                new MemoryCacheEntryOptions
                {
                    AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(2),
                });
            return computed;
        }
        finally
        {
            CodexDailyTokenUsageLock.Release();
        }
    }

    private static async Task<IReadOnlyList<CodexDailyTokenUsageDto>> GetClaudeDailyTokenUsageAsync(
        IMemoryCache cache,
        bool forceRefresh,
        int days,
        CancellationToken cancellationToken)
    {
        days = Math.Clamp(days, 1, 30);
        var cacheKey = GetClaudeDailyTokenUsageCacheKey(days);

        if (!forceRefresh
            && cache.TryGetValue(cacheKey, out IReadOnlyList<CodexDailyTokenUsageDto>? cached)
            && cached is not null)
        {
            return cached;
        }

        await ClaudeDailyTokenUsageLock.WaitAsync(cancellationToken);
        try
        {
            if (!forceRefresh
                && cache.TryGetValue(cacheKey, out cached)
                && cached is not null)
            {
                return cached;
            }

            var computed = await ComputeClaudeDailyTokenUsageAsync(days, cancellationToken);
            cache.Set(
                cacheKey,
                computed,
                new MemoryCacheEntryOptions
                {
                    AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(2),
                });
            return computed;
        }
        finally
        {
            ClaudeDailyTokenUsageLock.Release();
        }
    }

    private static async Task<IReadOnlyList<CodexDailyTokenUsageDto>> ComputeCodexDailyTokenUsageAsync(
        int days,
        CancellationToken cancellationToken)
    {
        days = Math.Clamp(days, 1, 30);

        var today = DateOnly.FromDateTime(DateTimeOffset.Now.ToLocalTime().DateTime);
        var startDay = today.AddDays(-(days - 1));

        var sessionsRoot = Path.Combine(GetCodexHomePath(), "sessions");
        if (!Directory.Exists(sessionsRoot))
        {
            return BuildEmptyCodexDailyTokenUsage(days, startDay);
        }

        string[] jsonlFiles;
        try
        {
            jsonlFiles = Directory.EnumerateFiles(sessionsRoot, "*.jsonl", SearchOption.AllDirectories)
                .ToArray();
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            return BuildEmptyCodexDailyTokenUsage(days, startDay);
        }

        if (jsonlFiles.Length == 0)
        {
            return BuildEmptyCodexDailyTokenUsage(days, startDay);
        }

        var inputTokens = new long[days];
        var cachedInputTokens = new long[days];
        var outputTokens = new long[days];
        var reasoningOutputTokens = new long[days];

        foreach (var filePath in jsonlFiles)
        {
            cancellationToken.ThrowIfCancellationRequested();

            await AccumulateCodexDailyTokenUsageFromSessionAsync(
                filePath,
                startDay,
                today,
                inputTokens,
                cachedInputTokens,
                outputTokens,
                reasoningOutputTokens,
                cancellationToken);
        }

        var items = new List<CodexDailyTokenUsageDto>(days);
        for (var i = 0; i < days; i++)
        {
            var day = startDay.AddDays(i);
            items.Add(new CodexDailyTokenUsageDto(
                Date: day.ToString("yyyy-MM-dd"),
                TokenUsage: new SessionTokenUsageDto(
                    inputTokens[i],
                    cachedInputTokens[i],
                    outputTokens[i],
                    reasoningOutputTokens[i])));
        }

        return items;
    }

    private static async Task<IReadOnlyList<CodexDailyTokenUsageDto>> ComputeClaudeDailyTokenUsageAsync(
        int days,
        CancellationToken cancellationToken)
    {
        days = Math.Clamp(days, 1, 30);

        var today = DateOnly.FromDateTime(DateTimeOffset.Now.ToLocalTime().DateTime);
        var startDay = today.AddDays(-(days - 1));

        var projectsRoot = GetClaudeProjectsPath();
        if (!Directory.Exists(projectsRoot))
        {
            return BuildEmptyCodexDailyTokenUsage(days, startDay);
        }

        string[] jsonlFiles;
        try
        {
            jsonlFiles = Directory.EnumerateFiles(projectsRoot, "*.jsonl", SearchOption.AllDirectories)
                .ToArray();
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            return BuildEmptyCodexDailyTokenUsage(days, startDay);
        }

        if (jsonlFiles.Length == 0)
        {
            return BuildEmptyCodexDailyTokenUsage(days, startDay);
        }

        var inputTokens = new long[days];
        var cachedInputTokens = new long[days];
        var outputTokens = new long[days];
        var reasoningOutputTokens = new long[days];

        foreach (var filePath in jsonlFiles)
        {
            cancellationToken.ThrowIfCancellationRequested();

            await AccumulateClaudeDailyTokenUsageFromSessionAsync(
                filePath,
                startDay,
                today,
                inputTokens,
                cachedInputTokens,
                outputTokens,
                reasoningOutputTokens,
                cancellationToken);
        }

        var items = new List<CodexDailyTokenUsageDto>(days);
        for (var i = 0; i < days; i++)
        {
            var day = startDay.AddDays(i);
            items.Add(new CodexDailyTokenUsageDto(
                Date: day.ToString("yyyy-MM-dd"),
                TokenUsage: new SessionTokenUsageDto(
                    inputTokens[i],
                    cachedInputTokens[i],
                    outputTokens[i],
                    reasoningOutputTokens[i])));
        }

        return items;
    }

    private static IReadOnlyList<CodexDailyTokenUsageDto> BuildEmptyCodexDailyTokenUsage(
        int days,
        DateOnly startDay)
    {
        var items = new List<CodexDailyTokenUsageDto>(days);
        for (var i = 0; i < days; i++)
        {
            var day = startDay.AddDays(i);
            items.Add(new CodexDailyTokenUsageDto(
                Date: day.ToString("yyyy-MM-dd"),
                TokenUsage: new SessionTokenUsageDto(0, 0, 0, 0)));
        }

        return items;
    }

    private static async Task AccumulateClaudeDailyTokenUsageFromSessionAsync(
        string filePath,
        DateOnly startDay,
        DateOnly endDay,
        long[] inputTokens,
        long[] cachedInputTokens,
        long[] outputTokens,
        long[] reasoningOutputTokens,
        CancellationToken cancellationToken)
    {
        try
        {
            var seenMessageIds = new HashSet<string>(StringComparer.Ordinal);

            await using var stream = File.OpenRead(filePath);
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);

            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var line = await reader.ReadLineAsync(cancellationToken);
                if (line is null)
                {
                    break;
                }

                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;

                if (!TryReadClaudeMessageUsage(root, out var timestamp, out var messageId, out var usage))
                {
                    continue;
                }

                if (!seenMessageIds.Add(messageId))
                {
                    continue;
                }

                if (usage.TotalTokens <= 0)
                {
                    continue;
                }

                var localDay = DateOnly.FromDateTime(timestamp.ToLocalTime().DateTime);
                if (localDay < startDay || localDay > endDay)
                {
                    continue;
                }

                var idx = localDay.DayNumber - startDay.DayNumber;
                if ((uint)idx >= (uint)inputTokens.Length)
                {
                    continue;
                }

                inputTokens[idx] += usage.InputTokens;
                cachedInputTokens[idx] += usage.CachedInputTokens;
                outputTokens[idx] += usage.OutputTokens;
                reasoningOutputTokens[idx] += usage.ReasoningOutputTokens;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // ignore
        }
    }

    private static async Task AccumulateCodexDailyTokenUsageFromSessionAsync(
        string filePath,
        DateOnly startDay,
        DateOnly endDay,
        long[] inputTokens,
        long[] cachedInputTokens,
        long[] outputTokens,
        long[] reasoningOutputTokens,
        CancellationToken cancellationToken)
    {
        try
        {
            CodexTokenUsageSnapshot? lastTotalTokenUsage = null;

            await using var stream = File.OpenRead(filePath);
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);

            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var line = await reader.ReadLineAsync(cancellationToken);
                if (line is null)
                {
                    break;
                }

                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;

                if (!TryReadTimestamp(root, out var timestamp))
                {
                    continue;
                }

                if (!root.TryGetProperty("payload", out var payload)
                    || payload.ValueKind != JsonValueKind.Object
                    || !payload.TryGetProperty("type", out var payloadTypeProp)
                    || payloadTypeProp.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                var payloadType = payloadTypeProp.GetString();
                if (!string.Equals(payloadType, "token_count", StringComparison.Ordinal))
                {
                    continue;
                }

                if (!TryReadCodexTotalTokenUsage(payload, out var totalUsage))
                {
                    continue;
                }

                CodexTokenUsageSnapshot delta;
                if (lastTotalTokenUsage is null)
                {
                    delta = totalUsage;
                }
                else
                {
                    delta = new CodexTokenUsageSnapshot(
                        InputTokens: Math.Max(0, totalUsage.InputTokens - lastTotalTokenUsage.InputTokens),
                        CachedInputTokens: Math.Max(0, totalUsage.CachedInputTokens - lastTotalTokenUsage.CachedInputTokens),
                        OutputTokens: Math.Max(0, totalUsage.OutputTokens - lastTotalTokenUsage.OutputTokens),
                        ReasoningOutputTokens: Math.Max(0, totalUsage.ReasoningOutputTokens - lastTotalTokenUsage.ReasoningOutputTokens));
                }

                lastTotalTokenUsage = totalUsage;

                if (delta.TotalTokens <= 0)
                {
                    continue;
                }

                var localDay = DateOnly.FromDateTime(timestamp.ToLocalTime().DateTime);
                if (localDay < startDay || localDay > endDay)
                {
                    continue;
                }

                var idx = localDay.DayNumber - startDay.DayNumber;
                if ((uint)idx >= (uint)inputTokens.Length)
                {
                    continue;
                }

                inputTokens[idx] += delta.InputTokens;
                cachedInputTokens[idx] += delta.CachedInputTokens;
                outputTokens[idx] += delta.OutputTokens;
                reasoningOutputTokens[idx] += delta.ReasoningOutputTokens;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // ignore
        }
    }

    private static async Task<CodexTokenUsageSnapshot?> TryReadClaudeSessionTokenUsageAsync(
        string filePath,
        CancellationToken cancellationToken)
    {
        try
        {
            var inputTokens = 0L;
            var cachedInputTokens = 0L;
            var outputTokens = 0L;
            var reasoningOutputTokens = 0L;

            var seenMessageIds = new HashSet<string>(StringComparer.Ordinal);

            await using var stream = File.OpenRead(filePath);
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 8192);

            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var line = await reader.ReadLineAsync(cancellationToken);
                if (line is null)
                {
                    break;
                }

                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;

                if (!TryReadClaudeMessageUsage(root, out _, out var messageId, out var usage))
                {
                    continue;
                }

                if (!seenMessageIds.Add(messageId))
                {
                    continue;
                }

                if (usage.TotalTokens <= 0)
                {
                    continue;
                }

                inputTokens += usage.InputTokens;
                cachedInputTokens += usage.CachedInputTokens;
                outputTokens += usage.OutputTokens;
                reasoningOutputTokens += usage.ReasoningOutputTokens;
            }

            return new CodexTokenUsageSnapshot(inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    private static async Task<CodexTokenUsageSnapshot?> TryReadCodexSessionTokenUsageAsync(
        string filePath,
        CancellationToken cancellationToken)
    {
        try
        {
            var inputTokens = 0L;
            var cachedInputTokens = 0L;
            var outputTokens = 0L;
            var reasoningOutputTokens = 0L;

            CodexTokenUsageSnapshot? lastTotalTokenUsage = null;

            await using var stream = File.OpenRead(filePath);
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 8192);

            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var line = await reader.ReadLineAsync(cancellationToken);
                if (line is null)
                {
                    break;
                }

                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;

                if (!root.TryGetProperty("payload", out var payload)
                    || payload.ValueKind != JsonValueKind.Object
                    || !payload.TryGetProperty("type", out var payloadTypeProp)
                    || payloadTypeProp.ValueKind != JsonValueKind.String
                    || !string.Equals(payloadTypeProp.GetString(), "token_count", StringComparison.Ordinal))
                {
                    continue;
                }

                if (!TryReadCodexTotalTokenUsage(payload, out var totalUsage))
                {
                    continue;
                }

                CodexTokenUsageSnapshot delta;
                if (lastTotalTokenUsage is null)
                {
                    delta = totalUsage;
                }
                else
                {
                    delta = new CodexTokenUsageSnapshot(
                        InputTokens: Math.Max(0, totalUsage.InputTokens - lastTotalTokenUsage.InputTokens),
                        CachedInputTokens: Math.Max(0, totalUsage.CachedInputTokens - lastTotalTokenUsage.CachedInputTokens),
                        OutputTokens: Math.Max(0, totalUsage.OutputTokens - lastTotalTokenUsage.OutputTokens),
                        ReasoningOutputTokens: Math.Max(0, totalUsage.ReasoningOutputTokens - lastTotalTokenUsage.ReasoningOutputTokens));
                }

                lastTotalTokenUsage = totalUsage;

                if (delta.TotalTokens <= 0)
                {
                    continue;
                }

                inputTokens += delta.InputTokens;
                cachedInputTokens += delta.CachedInputTokens;
                outputTokens += delta.OutputTokens;
                reasoningOutputTokens += delta.ReasoningOutputTokens;
            }

            return new CodexTokenUsageSnapshot(inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    private static bool TryReadClaudeMessageUsage(
        JsonElement root,
        out DateTimeOffset timestamp,
        out string messageId,
        out CodexTokenUsageSnapshot usage)
    {
        timestamp = default;
        messageId = string.Empty;
        usage = new CodexTokenUsageSnapshot(0, 0, 0, 0);

        if (!TryReadTimestamp(root, out timestamp))
        {
            return false;
        }

        if (!root.TryGetProperty("type", out var typeProp)
            || typeProp.ValueKind != JsonValueKind.String
            || !string.Equals(typeProp.GetString(), "assistant", StringComparison.Ordinal))
        {
            return false;
        }

        if (!root.TryGetProperty("message", out var message)
            || message.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        if (!message.TryGetProperty("id", out var idProp)
            || idProp.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        var id = idProp.GetString();
        if (string.IsNullOrWhiteSpace(id))
        {
            return false;
        }

        if (!message.TryGetProperty("usage", out var usageProp)
            || usageProp.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        static long ReadLong(JsonElement obj, string name)
        {
            if (!obj.TryGetProperty(name, out var prop))
            {
                return 0;
            }

            if (prop.ValueKind == JsonValueKind.Number && prop.TryGetInt64(out var v))
            {
                return v;
            }

            if (prop.ValueKind == JsonValueKind.String && long.TryParse(prop.GetString(), out v))
            {
                return v;
            }

            return 0;
        }

        var inputTokens = ReadLong(usageProp, "input_tokens");
        var cacheCreateTokens = ReadLong(usageProp, "cache_creation_input_tokens");
        var cacheReadTokens = ReadLong(usageProp, "cache_read_input_tokens");
        var outputTokens = ReadLong(usageProp, "output_tokens");

        messageId = id;
        usage = new CodexTokenUsageSnapshot(
            InputTokens: inputTokens,
            CachedInputTokens: cacheCreateTokens + cacheReadTokens,
            OutputTokens: outputTokens,
            ReasoningOutputTokens: 0);
        return true;
    }

    private static async Task<CodexSessionMeta?> TryReadCodexSessionMetaAsync(
        string filePath,
        CancellationToken cancellationToken)
    {
        try
        {
            await using var stream = File.OpenRead(filePath);
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 4096);

            var line = await reader.ReadLineAsync(cancellationToken);
            if (string.IsNullOrWhiteSpace(line))
            {
                return null;
            }

            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;

            if (!TryReadTimestamp(root, out var createdAtUtc))
            {
                createdAtUtc = new DateTimeOffset(File.GetCreationTimeUtc(filePath), TimeSpan.Zero);
            }

            if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            var id = payload.TryGetProperty("id", out var idProp) && idProp.ValueKind == JsonValueKind.String
                ? idProp.GetString()
                : null;

            var cwd = payload.TryGetProperty("cwd", out var cwdProp) && cwdProp.ValueKind == JsonValueKind.String
                ? cwdProp.GetString()
                : null;

            if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(cwd))
            {
                return null;
            }

            return new CodexSessionMeta(id!, cwd!, createdAtUtc);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    private static async Task<ClaudeSessionMeta?> TryReadClaudeSessionMetaAsync(
        string filePath,
        CancellationToken cancellationToken)
    {
        try
        {
            DateTimeOffset? createdAtUtc = null;

            await using var stream = File.OpenRead(filePath);
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 4096);

            for (var i = 0; i < 80; i++)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var line = await reader.ReadLineAsync(cancellationToken);
                if (line is null)
                {
                    break;
                }

                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;

                if (createdAtUtc is null && TryReadTimestamp(root, out var timestamp))
                {
                    createdAtUtc = timestamp;
                }

                var sessionId = root.TryGetProperty("sessionId", out var sessionIdProp)
                    && sessionIdProp.ValueKind == JsonValueKind.String
                        ? sessionIdProp.GetString()
                        : null;

                var cwd = root.TryGetProperty("cwd", out var cwdProp)
                    && cwdProp.ValueKind == JsonValueKind.String
                        ? cwdProp.GetString()
                        : null;

                if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(cwd))
                {
                    continue;
                }

                return new ClaudeSessionMeta(
                    Id: sessionId!,
                    Cwd: cwd!,
                    CreatedAtUtc: createdAtUtc ?? new DateTimeOffset(File.GetCreationTimeUtc(filePath), TimeSpan.Zero));
            }

            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    private static async Task<ProjectSessionDto?> TryBuildCodexSessionSummaryAsync(
        string filePath,
        CodexSessionMeta meta,
        CancellationToken cancellationToken)
    {
        try
        {
            var startAt = meta.CreatedAtUtc;
            var minEventAt = startAt;
            var lastEventAt = startAt;

            var messageCount = 0;
            var functionCallCount = 0;
            var reasoningCount = 0;
            var tokenCount = 0;
            var otherCount = 0;

            var inputTokens = 0L;
            var cachedInputTokens = 0L;
            var outputTokens = 0L;
            var reasoningOutputTokens = 0L;

            var events = new List<(DateTimeOffset Timestamp, CodexSessionEventKind Kind)>();
            var userMessageTimes = new List<DateTimeOffset>();
            var assistantMessageTimes = new List<DateTimeOffset>();
            var toolStartByCallId = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);
            var toolIntervals = new List<(DateTimeOffset Start, DateTimeOffset End)>();
            CodexTokenUsageSnapshot? lastTotalTokenUsage = null;
            var tokenDeltas = new List<(DateTimeOffset Timestamp, CodexTokenUsageSnapshot Delta)>();

            await using var stream = File.OpenRead(filePath);
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);

            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var line = await reader.ReadLineAsync(cancellationToken);
                if (line is null)
                {
                    break;
                }

                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;

                if (!TryReadTimestamp(root, out var timestamp))
                {
                    continue;
                }

                if (timestamp < minEventAt)
                {
                    minEventAt = timestamp;
                }

                if (timestamp > lastEventAt)
                {
                    lastEventAt = timestamp;
                }

                if (root.TryGetProperty("payload", out var payload)
                    && payload.ValueKind == JsonValueKind.Object
                    && payload.TryGetProperty("type", out var payloadTypeProp)
                    && payloadTypeProp.ValueKind == JsonValueKind.String)
                {
                    var payloadType = payloadTypeProp.GetString();
                    if (string.Equals(payloadType, "message", StringComparison.Ordinal)
                        && payload.TryGetProperty("role", out var roleProp)
                        && roleProp.ValueKind == JsonValueKind.String)
                    {
                        var role = roleProp.GetString();
                        if (string.Equals(role, "user", StringComparison.Ordinal))
                        {
                            userMessageTimes.Add(timestamp);
                        }
                        else if (string.Equals(role, "assistant", StringComparison.Ordinal))
                        {
                            assistantMessageTimes.Add(timestamp);
                        }
                    }
                    else if (string.Equals(payloadType, "user_message", StringComparison.Ordinal))
                    {
                        userMessageTimes.Add(timestamp);
                    }
                    else if (string.Equals(payloadType, "agent_message", StringComparison.Ordinal))
                    {
                        assistantMessageTimes.Add(timestamp);
                    }
                    else if (string.Equals(payloadType, "function_call", StringComparison.Ordinal)
                        || string.Equals(payloadType, "custom_tool_call", StringComparison.Ordinal))
                    {
                        if (payload.TryGetProperty("call_id", out var callIdProp)
                            && callIdProp.ValueKind == JsonValueKind.String)
                        {
                            var callId = callIdProp.GetString();
                            if (!string.IsNullOrWhiteSpace(callId))
                            {
                                toolStartByCallId[callId!] = timestamp;
                            }
                        }
                    }
                    else if (string.Equals(payloadType, "function_call_output", StringComparison.Ordinal)
                        || string.Equals(payloadType, "custom_tool_call_output", StringComparison.Ordinal))
                    {
                        if (payload.TryGetProperty("call_id", out var callIdProp)
                            && callIdProp.ValueKind == JsonValueKind.String)
                        {
                            var callId = callIdProp.GetString();
                            if (!string.IsNullOrWhiteSpace(callId)
                                && toolStartByCallId.TryGetValue(callId!, out var toolStart))
                            {
                                if (timestamp > toolStart)
                                {
                                    toolIntervals.Add((toolStart, timestamp));
                                }

                                toolStartByCallId.Remove(callId!);
                            }
                        }
                    }
                    else if (string.Equals(payloadType, "token_count", StringComparison.Ordinal))
                    {
                        if (TryReadCodexTotalTokenUsage(payload, out var totalUsage))
                        {
                            CodexTokenUsageSnapshot delta;
                            if (lastTotalTokenUsage is null)
                            {
                                delta = totalUsage;
                            }
                            else
                            {
                                delta = new CodexTokenUsageSnapshot(
                                    InputTokens: Math.Max(0, totalUsage.InputTokens - lastTotalTokenUsage.InputTokens),
                                    CachedInputTokens: Math.Max(0, totalUsage.CachedInputTokens - lastTotalTokenUsage.CachedInputTokens),
                                    OutputTokens: Math.Max(0, totalUsage.OutputTokens - lastTotalTokenUsage.OutputTokens),
                                    ReasoningOutputTokens: Math.Max(0, totalUsage.ReasoningOutputTokens - lastTotalTokenUsage.ReasoningOutputTokens));
                            }

                            lastTotalTokenUsage = totalUsage;

                            if (delta.TotalTokens > 0)
                            {
                                tokenDeltas.Add((timestamp, delta));
                                inputTokens += delta.InputTokens;
                                cachedInputTokens += delta.CachedInputTokens;
                                outputTokens += delta.OutputTokens;
                                reasoningOutputTokens += delta.ReasoningOutputTokens;
                            }
                        }
                    }
                }

                var kind = GetCodexSessionEventKind(root);
                events.Add((timestamp, kind));
                switch (kind)
                {
                    case CodexSessionEventKind.Message:
                        messageCount++;
                        break;
                    case CodexSessionEventKind.FunctionCall:
                        functionCallCount++;
                        break;
                    case CodexSessionEventKind.AgentReasoning:
                        reasoningCount++;
                        break;
                    case CodexSessionEventKind.TokenCount:
                        tokenCount++;
                        break;
                    case CodexSessionEventKind.Other:
                        otherCount++;
                        break;
                }
            }

            startAt = minEventAt;

            var duration = lastEventAt - startAt;
            var durationMs = duration <= TimeSpan.Zero ? 0 : (long)duration.TotalMilliseconds;

            var timeline = BuildTimeline(events, startAt, lastEventAt);
            var trace = BuildTrace(
                startAt,
                lastEventAt,
                userMessageTimes,
                assistantMessageTimes,
                toolIntervals,
                tokenDeltas);
            return new ProjectSessionDto(
                Id: meta.Id,
                CreatedAtUtc: startAt,
                LastEventAtUtc: lastEventAt,
                DurationMs: durationMs,
                EventCounts: new SessionEventCountsDto(messageCount, functionCallCount, reasoningCount, tokenCount, otherCount),
                TokenUsage: new SessionTokenUsageDto(inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens),
                Timeline: timeline,
                Trace: trace);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    private static async Task<ProjectSessionDto?> TryBuildClaudeSessionSummaryAsync(
        IReadOnlyList<string> filePaths,
        ClaudeSessionMeta meta,
        CancellationToken cancellationToken)
    {
        try
        {
            var startAt = meta.CreatedAtUtc;
            var minEventAt = startAt;
            var lastEventAt = startAt;
            var hasTimestamp = false;

            var messageCount = 0;
            var functionCallCount = 0;
            var reasoningCount = 0;
            var tokenCount = 0;
            var otherCount = 0;

            var inputTokens = 0L;
            var cachedInputTokens = 0L;
            var outputTokens = 0L;
            var reasoningOutputTokens = 0L;

            var events = new List<(DateTimeOffset Timestamp, CodexSessionEventKind Kind)>();
            var userMessageTimes = new List<DateTimeOffset>();
            var assistantMessageTimes = new List<DateTimeOffset>();
            var assistantMessageIdSet = new HashSet<string>(StringComparer.Ordinal);

            var toolStartByToolUseId = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);
            var toolEndByToolUseId = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);
            var toolIntervals = new List<(DateTimeOffset Start, DateTimeOffset End)>();
            var tokenDeltas = new List<(DateTimeOffset Timestamp, CodexTokenUsageSnapshot Delta)>();

            foreach (var filePath in filePaths)
            {
                cancellationToken.ThrowIfCancellationRequested();

                await using var stream = File.OpenRead(filePath);
                using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);

                while (true)
                {
                    cancellationToken.ThrowIfCancellationRequested();

                    var line = await reader.ReadLineAsync(cancellationToken);
                    if (line is null)
                    {
                        break;
                    }

                    if (string.IsNullOrWhiteSpace(line))
                    {
                        continue;
                    }

                    using var doc = JsonDocument.Parse(line);
                    var root = doc.RootElement;

                    if (!TryReadTimestamp(root, out var timestamp))
                    {
                        continue;
                    }

                    hasTimestamp = true;
                    if (timestamp < minEventAt)
                    {
                        minEventAt = timestamp;
                    }

                    if (timestamp > lastEventAt)
                    {
                        lastEventAt = timestamp;
                    }

                    var type = root.TryGetProperty("type", out var typeProp) && typeProp.ValueKind == JsonValueKind.String
                        ? typeProp.GetString()
                        : null;

                    if (string.Equals(type, "assistant", StringComparison.Ordinal))
                    {
                        if (root.TryGetProperty("message", out var message)
                            && message.ValueKind == JsonValueKind.Object
                            && message.TryGetProperty("content", out var content)
                            && content.ValueKind == JsonValueKind.Array)
                        {
                            foreach (var item in content.EnumerateArray())
                            {
                                if (item.ValueKind != JsonValueKind.Object)
                                {
                                    continue;
                                }

                                if (!item.TryGetProperty("type", out var itemTypeProp)
                                    || itemTypeProp.ValueKind != JsonValueKind.String
                                    || !string.Equals(itemTypeProp.GetString(), "tool_use", StringComparison.Ordinal))
                                {
                                    continue;
                                }

                                functionCallCount++;
                                events.Add((timestamp, CodexSessionEventKind.FunctionCall));

                                if (item.TryGetProperty("id", out var toolUseIdProp)
                                    && toolUseIdProp.ValueKind == JsonValueKind.String)
                                {
                                    var toolUseId = toolUseIdProp.GetString();
                                    if (!string.IsNullOrWhiteSpace(toolUseId))
                                    {
                                        if (toolEndByToolUseId.TryGetValue(toolUseId!, out var endAt)
                                            && endAt > timestamp)
                                        {
                                            toolIntervals.Add((timestamp, endAt));
                                            toolEndByToolUseId.Remove(toolUseId!);
                                        }
                                        else
                                        {
                                            toolStartByToolUseId[toolUseId!] = timestamp;
                                        }
                                    }
                                }
                            }
                        }

                        if (TryReadClaudeMessageUsage(root, out _, out var messageId, out var usage)
                            && assistantMessageIdSet.Add(messageId))
                        {
                            messageCount++;
                            tokenCount++;
                            assistantMessageTimes.Add(timestamp);
                            events.Add((timestamp, CodexSessionEventKind.Message));
                            events.Add((timestamp, CodexSessionEventKind.TokenCount));

                            if (usage.TotalTokens > 0)
                            {
                                tokenDeltas.Add((timestamp, usage));
                                inputTokens += usage.InputTokens;
                                cachedInputTokens += usage.CachedInputTokens;
                                outputTokens += usage.OutputTokens;
                                reasoningOutputTokens += usage.ReasoningOutputTokens;
                            }
                        }

                        continue;
                    }

                    if (string.Equals(type, "user", StringComparison.Ordinal))
                    {
                        var isToolResult = false;

                        if (root.TryGetProperty("message", out var message)
                            && message.ValueKind == JsonValueKind.Object
                            && message.TryGetProperty("content", out var content)
                            && content.ValueKind == JsonValueKind.Array)
                        {
                            foreach (var item in content.EnumerateArray())
                            {
                                if (item.ValueKind != JsonValueKind.Object)
                                {
                                    continue;
                                }

                                if (!item.TryGetProperty("type", out var itemTypeProp)
                                    || itemTypeProp.ValueKind != JsonValueKind.String
                                    || !string.Equals(itemTypeProp.GetString(), "tool_result", StringComparison.Ordinal))
                                {
                                    continue;
                                }

                                isToolResult = true;
                                functionCallCount++;
                                events.Add((timestamp, CodexSessionEventKind.FunctionCall));

                                if (item.TryGetProperty("tool_use_id", out var toolUseIdProp)
                                    && toolUseIdProp.ValueKind == JsonValueKind.String)
                                {
                                    var toolUseId = toolUseIdProp.GetString();
                                    if (!string.IsNullOrWhiteSpace(toolUseId))
                                    {
                                        if (toolStartByToolUseId.TryGetValue(toolUseId!, out var toolStart))
                                        {
                                            if (timestamp > toolStart)
                                            {
                                                toolIntervals.Add((toolStart, timestamp));
                                            }

                                            toolStartByToolUseId.Remove(toolUseId!);
                                        }
                                        else
                                        {
                                            toolEndByToolUseId[toolUseId!] = timestamp;
                                        }
                                    }
                                }
                            }
                        }

                        if (!isToolResult)
                        {
                            messageCount++;
                            userMessageTimes.Add(timestamp);
                            events.Add((timestamp, CodexSessionEventKind.Message));
                        }

                        continue;
                    }

                    otherCount++;
                    events.Add((timestamp, CodexSessionEventKind.Other));
                }
            }

            if (!hasTimestamp)
            {
                return null;
            }

            startAt = minEventAt;

            var duration = lastEventAt - startAt;
            var durationMs = duration <= TimeSpan.Zero ? 0 : (long)duration.TotalMilliseconds;

            var timeline = BuildTimeline(events, startAt, lastEventAt);
            var trace = BuildTrace(
                startAt,
                lastEventAt,
                userMessageTimes,
                assistantMessageTimes,
                toolIntervals,
                tokenDeltas);
            return new ProjectSessionDto(
                Id: meta.Id,
                CreatedAtUtc: startAt,
                LastEventAtUtc: lastEventAt,
                DurationMs: durationMs,
                EventCounts: new SessionEventCountsDto(messageCount, functionCallCount, reasoningCount, tokenCount, otherCount),
                TokenUsage: new SessionTokenUsageDto(inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens),
                Timeline: timeline,
                Trace: trace);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    private static IReadOnlyList<SessionTimelineBucketDto> BuildTimeline(
        IReadOnlyList<(DateTimeOffset Timestamp, CodexSessionEventKind Kind)> events,
        DateTimeOffset startAt,
        DateTimeOffset lastEventAt)
    {
        if (events.Count == 0)
        {
            return Array.Empty<SessionTimelineBucketDto>();
        }

        var duration = lastEventAt - startAt;
        if (duration <= TimeSpan.Zero)
        {
            var message = 0;
            var functionCall = 0;
            var reasoning = 0;
            var tokenCount = 0;
            var other = 0;
            foreach (var (_, kind) in events)
            {
                switch (kind)
                {
                    case CodexSessionEventKind.Message:
                        message++;
                        break;
                    case CodexSessionEventKind.FunctionCall:
                        functionCall++;
                        break;
                    case CodexSessionEventKind.AgentReasoning:
                        reasoning++;
                        break;
                    case CodexSessionEventKind.TokenCount:
                        tokenCount++;
                        break;
                    case CodexSessionEventKind.Other:
                        other++;
                        break;
                }
            }

            return [new SessionTimelineBucketDto(message, functionCall, reasoning, tokenCount, other)];
        }

        var bucketCount = (int)Math.Ceiling(duration.TotalSeconds / 15);
        bucketCount = Math.Clamp(bucketCount, 12, 96);

        var messageCounts = new int[bucketCount];
        var functionCallCounts = new int[bucketCount];
        var reasoningCounts = new int[bucketCount];
        var tokenCountCounts = new int[bucketCount];
        var otherCounts = new int[bucketCount];

        var totalMs = duration.TotalMilliseconds;
        foreach (var (timestamp, kind) in events)
        {
            var offsetMs = (timestamp - startAt).TotalMilliseconds;
            var ratio = offsetMs <= 0 ? 0 : offsetMs / totalMs;
            var idx = (int)Math.Floor(ratio * bucketCount);
            idx = Math.Clamp(idx, 0, bucketCount - 1);

            switch (kind)
            {
                case CodexSessionEventKind.Message:
                    messageCounts[idx]++;
                    break;
                case CodexSessionEventKind.FunctionCall:
                    functionCallCounts[idx]++;
                    break;
                case CodexSessionEventKind.AgentReasoning:
                    reasoningCounts[idx]++;
                    break;
                case CodexSessionEventKind.TokenCount:
                    tokenCountCounts[idx]++;
                    break;
                case CodexSessionEventKind.Other:
                    otherCounts[idx]++;
                    break;
            }
        }

        var buckets = new SessionTimelineBucketDto[bucketCount];
        for (var i = 0; i < bucketCount; i++)
        {
            buckets[i] = new SessionTimelineBucketDto(
                messageCounts[i],
                functionCallCounts[i],
                reasoningCounts[i],
                tokenCountCounts[i],
                otherCounts[i]);
        }

        return buckets;
    }

    private static IReadOnlyList<SessionTraceSpanDto> BuildTraceLegacy(
        DateTimeOffset startAt,
        DateTimeOffset lastEventAt,
        IReadOnlyList<DateTimeOffset> userMessageTimes,
        IReadOnlyList<DateTimeOffset> assistantMessageTimes,
        IReadOnlyList<(DateTimeOffset Start, DateTimeOffset End)> toolIntervals,
        IReadOnlyList<(DateTimeOffset Timestamp, CodexTokenUsageSnapshot Usage)> tokenSnapshots)
    {
        var duration = lastEventAt - startAt;
        if (duration <= TimeSpan.Zero)
        {
            return Array.Empty<SessionTraceSpanDto>();
        }

        const string kindTool = "tool";
        const string kindWaiting = "waiting";
        const string kindNetwork = "network";
        const string kindPrefill = "prefill";
        const string kindGen = "gen";

        const long networkOverheadMsPerRequest = 400;
        const double prefillTokensPerSecond = 3000;
        const double genTokensPerSecond = 50;

        static bool Overlaps(DateTimeOffset startA, DateTimeOffset endA, DateTimeOffset startB, DateTimeOffset endB)
        {
            return startA < endB && endA > startB;
        }

        static List<(DateTimeOffset Start, DateTimeOffset End)> NormalizeIntervals(
            IEnumerable<(DateTimeOffset Start, DateTimeOffset End)> intervals,
            DateTimeOffset min,
            DateTimeOffset max)
        {
            var list = new List<(DateTimeOffset Start, DateTimeOffset End)>();
            foreach (var (start, end) in intervals)
            {
                var clampedStart = start < min ? min : start;
                var clampedEnd = end > max ? max : end;
                if (clampedEnd <= clampedStart)
                {
                    continue;
                }

                list.Add((clampedStart, clampedEnd));
            }

            list.Sort((a, b) => a.Start.CompareTo(b.Start));
            return list;
        }

        static List<(DateTimeOffset Start, DateTimeOffset End)> MergeIntervals(
            List<(DateTimeOffset Start, DateTimeOffset End)> intervals)
        {
            if (intervals.Count <= 1)
            {
                return intervals;
            }

            var merged = new List<(DateTimeOffset Start, DateTimeOffset End)>(intervals.Count);
            var currentStart = intervals[0].Start;
            var currentEnd = intervals[0].End;

            for (var idx = 1; idx < intervals.Count; idx++)
            {
                var next = intervals[idx];
                if (next.Start <= currentEnd)
                {
                    if (next.End > currentEnd)
                    {
                        currentEnd = next.End;
                    }

                    continue;
                }

                merged.Add((currentStart, currentEnd));
                currentStart = next.Start;
                currentEnd = next.End;
            }

            merged.Add((currentStart, currentEnd));
            return merged;
        }

        var toolsRaw = NormalizeIntervals(toolIntervals, startAt, lastEventAt);
        var tools = MergeIntervals(toolsRaw);

        var users = userMessageTimes
            .Where(t => t >= startAt && t <= lastEventAt)
            .OrderBy(t => t)
            .ToArray();

        var assistants = assistantMessageTimes
            .Where(t => t >= startAt && t <= lastEventAt)
            .OrderBy(t => t)
            .ToArray();

        var windows = new List<(DateTimeOffset Start, DateTimeOffset End)>();
        var assistantIdx = 0;
        foreach (var userAt in users)
        {
            while (assistantIdx < assistants.Length && assistants[assistantIdx] <= userAt)
            {
                assistantIdx++;
            }

            if (assistantIdx >= assistants.Length)
            {
                break;
            }

            var assistantAt = assistants[assistantIdx];
            assistantIdx++;

            if (assistantAt <= userAt)
            {
                continue;
            }

            windows.Add((userAt, assistantAt));
        }

        windows = NormalizeIntervals(windows, startAt, lastEventAt);

        var cutPoints = new List<DateTimeOffset>(2 + tools.Count * 2 + windows.Count * 2);
        cutPoints.Add(startAt);
        cutPoints.Add(lastEventAt);

        foreach (var (start, end) in tools)
        {
            cutPoints.Add(start);
            cutPoints.Add(end);
        }

        foreach (var (start, end) in windows)
        {
            cutPoints.Add(start);
            cutPoints.Add(end);
        }

        cutPoints.Sort();
        var uniqueCuts = new List<DateTimeOffset>(cutPoints.Count);
        foreach (var t in cutPoints)
        {
            if (uniqueCuts.Count == 0 || uniqueCuts[^1] != t)
            {
                uniqueCuts.Add(t);
            }
        }

        if (uniqueCuts.Count < 2)
        {
            return Array.Empty<SessionTraceSpanDto>();
        }

        var baseSegments = new List<(DateTimeOffset Start, DateTimeOffset End, string Kind)>();

        var toolIdx = 0;
        var windowIdx = 0;

        for (var idx = 0; idx < uniqueCuts.Count - 1; idx++)
        {
            var segStart = uniqueCuts[idx];
            var segEnd = uniqueCuts[idx + 1];
            if (segEnd <= segStart)
            {
                continue;
            }

            var durationMs = (long)(segEnd - segStart).TotalMilliseconds;
            if (durationMs <= 0)
            {
                continue;
            }

            while (toolIdx < tools.Count && tools[toolIdx].End <= segStart)
            {
                toolIdx++;
            }

            var inTool = toolIdx < tools.Count && Overlaps(segStart, segEnd, tools[toolIdx].Start, tools[toolIdx].End);

            while (windowIdx < windows.Count && windows[windowIdx].End <= segStart)
            {
                windowIdx++;
            }

            var inWindow = windowIdx < windows.Count && Overlaps(segStart, segEnd, windows[windowIdx].Start, windows[windowIdx].End);

            var kind = inTool ? kindTool : inWindow ? "model" : kindWaiting;
            baseSegments.Add((segStart, segEnd, kind));
        }

        if (baseSegments.Count == 0)
        {
            return Array.Empty<SessionTraceSpanDto>();
        }

        var sortedTokens = tokenSnapshots
            .Where(x => x.Timestamp >= startAt && x.Timestamp <= lastEventAt)
            .OrderBy(x => x.Timestamp)
            .ToArray();

        var tokenIdx = 0;

        var spans = new List<SessionTraceSpanDto>();

        void AddSpan(string kind, long durationMs, long tokenCount, int eventCount)
        {
            if (durationMs <= 0)
            {
                return;
            }

            if (spans.Count > 0 && string.Equals(spans[^1].Kind, kind, StringComparison.Ordinal))
            {
                var last = spans[^1];
                spans[^1] = new SessionTraceSpanDto(
                    Kind: last.Kind,
                    DurationMs: last.DurationMs + durationMs,
                    TokenCount: last.TokenCount + tokenCount,
                    EventCount: last.EventCount + eventCount);
                return;
            }

            spans.Add(new SessionTraceSpanDto(kind, durationMs, tokenCount, eventCount));
        }

        int CountToolCalls(DateTimeOffset start, DateTimeOffset end)
        {
            var count = 0;
            foreach (var interval in toolsRaw)
            {
                if (Overlaps(start, end, interval.Start, interval.End))
                {
                    count++;
                }
            }

            return count;
        }

        var segIdx = 0;
        while (segIdx < baseSegments.Count)
        {
            var seg = baseSegments[segIdx];
            var segStart = seg.Start;
            var segEnd = seg.End;
            var segDurationMs = (long)(segEnd - segStart).TotalMilliseconds;

            if (!string.Equals(seg.Kind, "model", StringComparison.Ordinal))
            {
                if (string.Equals(seg.Kind, kindTool, StringComparison.Ordinal))
                {
                    AddSpan(kindTool, segDurationMs, 0, CountToolCalls(segStart, segEnd));
                }
                else
                {
                    AddSpan(kindWaiting, segDurationMs, 0, 0);
                }

                segIdx++;
                continue;
            }

            var blockStart = segStart;
            var blockEnd = segEnd;
            segIdx++;

            while (segIdx < baseSegments.Count && string.Equals(baseSegments[segIdx].Kind, "model", StringComparison.Ordinal))
            {
                blockEnd = baseSegments[segIdx].End;
                segIdx++;
            }

            var blockDurationMs = (long)(blockEnd - blockStart).TotalMilliseconds;
            if (blockDurationMs <= 0)
            {
                continue;
            }

            while (tokenIdx < sortedTokens.Length && sortedTokens[tokenIdx].Timestamp < blockStart)
            {
                tokenIdx++;
            }

            var cutoff = blockEnd + TimeSpan.FromSeconds(1);
            var requestCount = 0;
            var prefillTokens = 0L;
            var genTokens = 0L;

            while (tokenIdx < sortedTokens.Length && sortedTokens[tokenIdx].Timestamp <= cutoff)
            {
                var usage = sortedTokens[tokenIdx].Usage;
                prefillTokens += usage.PrefillTokens;
                genTokens += usage.GenTokens;
                requestCount++;
                tokenIdx++;
            }

            var networkDurationMs = requestCount > 0
                ? Math.Min(blockDurationMs, requestCount * networkOverheadMsPerRequest)
                : 0;

            var remainingDurationMs = blockDurationMs - networkDurationMs;
            if (remainingDurationMs < 0)
            {
                remainingDurationMs = 0;
            }

            var prefillDurationMs = 0L;
            var genDurationMs = remainingDurationMs;

            if (remainingDurationMs > 0 && (prefillTokens > 0 || genTokens > 0))
            {
                var prefillCost = prefillTokensPerSecond <= 0
                    ? 0
                    : prefillTokens / prefillTokensPerSecond;

                var genCost = genTokensPerSecond <= 0
                    ? 0
                    : genTokens / genTokensPerSecond;

                var totalCost = prefillCost + genCost;
                var prefillShare = totalCost <= 0 ? 0 : prefillCost / totalCost;
                prefillDurationMs = (long)Math.Round(remainingDurationMs * prefillShare);

                if (prefillDurationMs < 0)
                {
                    prefillDurationMs = 0;
                }

                if (prefillDurationMs > remainingDurationMs)
                {
                    prefillDurationMs = remainingDurationMs;
                }

                genDurationMs = remainingDurationMs - prefillDurationMs;

                if (prefillTokens > 0 && prefillDurationMs == 0 && remainingDurationMs > 0)
                {
                    prefillDurationMs = 1;
                    genDurationMs = Math.Max(0, remainingDurationMs - 1);
                }

                if (genTokens > 0 && genDurationMs == 0 && remainingDurationMs > 0)
                {
                    genDurationMs = 1;
                    prefillDurationMs = Math.Max(0, remainingDurationMs - 1);
                }
            }

            if (networkDurationMs > 0)
            {
                AddSpan(kindNetwork, networkDurationMs, 0, requestCount);
            }

            if (prefillDurationMs > 0)
            {
                AddSpan(kindPrefill, prefillDurationMs, prefillTokens, requestCount);
            }

            if (genDurationMs > 0)
            {
                AddSpan(kindGen, genDurationMs, genTokens, requestCount);
            }
        }

        return spans;
    }

    private static IReadOnlyList<SessionTraceSpanDto> BuildTrace(
        DateTimeOffset startAt,
        DateTimeOffset lastEventAt,
        IReadOnlyList<DateTimeOffset> userMessageTimes,
        IReadOnlyList<DateTimeOffset> assistantMessageTimes,
        IReadOnlyList<(DateTimeOffset Start, DateTimeOffset End)> toolIntervals,
        IReadOnlyList<(DateTimeOffset Timestamp, CodexTokenUsageSnapshot Delta)> tokenDeltas)
    {
        var duration = lastEventAt - startAt;
        if (duration <= TimeSpan.Zero)
        {
            return Array.Empty<SessionTraceSpanDto>();
        }

        const string kindTool = "tool";
        const string kindWaiting = "waiting";
        const string kindThink = "think";
        const string kindGen = "gen";

        static bool Overlaps(DateTimeOffset startA, DateTimeOffset endA, DateTimeOffset startB, DateTimeOffset endB)
            => startA < endB && endA > startB;

        static List<(DateTimeOffset Start, DateTimeOffset End)> NormalizeIntervals(
            IEnumerable<(DateTimeOffset Start, DateTimeOffset End)> intervals,
            DateTimeOffset min,
            DateTimeOffset max)
        {
            var list = new List<(DateTimeOffset Start, DateTimeOffset End)>();
            foreach (var (start, end) in intervals)
            {
                var clampedStart = start < min ? min : start;
                var clampedEnd = end > max ? max : end;
                if (clampedEnd <= clampedStart)
                {
                    continue;
                }

                list.Add((clampedStart, clampedEnd));
            }

            list.Sort((a, b) => a.Start.CompareTo(b.Start));
            return list;
        }

        static List<(DateTimeOffset Start, DateTimeOffset End)> MergeIntervals(
            List<(DateTimeOffset Start, DateTimeOffset End)> intervals)
        {
            if (intervals.Count <= 1)
            {
                return intervals;
            }

            var merged = new List<(DateTimeOffset Start, DateTimeOffset End)>(intervals.Count);
            var currentStart = intervals[0].Start;
            var currentEnd = intervals[0].End;

            for (var idx = 1; idx < intervals.Count; idx++)
            {
                var next = intervals[idx];
                if (next.Start <= currentEnd)
                {
                    if (next.End > currentEnd)
                    {
                        currentEnd = next.End;
                    }

                    continue;
                }

                merged.Add((currentStart, currentEnd));
                currentStart = next.Start;
                currentEnd = next.End;
            }

            merged.Add((currentStart, currentEnd));
            return merged;
        }

        static DateTimeOffset[] DistinctSortedTimes(
            IEnumerable<DateTimeOffset> times,
            DateTimeOffset min,
            DateTimeOffset max)
        {
            var sorted = times
                .Where(t => t >= min && t <= max)
                .OrderBy(t => t)
                .ToArray();

            if (sorted.Length <= 1)
            {
                return sorted;
            }

            var unique = new List<DateTimeOffset>(sorted.Length);
            foreach (var t in sorted)
            {
                if (unique.Count == 0 || unique[^1] != t)
                {
                    unique.Add(t);
                }
            }

            return unique.ToArray();
        }

        static List<(DateTimeOffset Start, DateTimeOffset End)> BuildWaitingIntervals(
            DateTimeOffset[] users,
            DateTimeOffset[] assistants,
            DateTimeOffset endAt)
        {
            var intervals = new List<(DateTimeOffset Start, DateTimeOffset End)>();

            var userIdx = 0;
            var assistantIdx = 0;
            DateTimeOffset? waitingStart = null;

            while (userIdx < users.Length || assistantIdx < assistants.Length)
            {
                var nextUser = userIdx < users.Length ? users[userIdx] : (DateTimeOffset?)null;
                var nextAssistant = assistantIdx < assistants.Length ? assistants[assistantIdx] : (DateTimeOffset?)null;

                if (nextAssistant.HasValue && (!nextUser.HasValue || nextAssistant.Value <= nextUser.Value))
                {
                    waitingStart = nextAssistant.Value;
                    assistantIdx++;
                    continue;
                }

                if (!nextUser.HasValue)
                {
                    break;
                }

                if (waitingStart.HasValue && nextUser.Value > waitingStart.Value)
                {
                    intervals.Add((waitingStart.Value, nextUser.Value));
                }

                waitingStart = null;
                userIdx++;
            }

            if (waitingStart.HasValue && endAt > waitingStart.Value)
            {
                intervals.Add((waitingStart.Value, endAt));
            }

            return intervals;
        }

        var toolsRaw = NormalizeIntervals(toolIntervals, startAt, lastEventAt);
        var tools = MergeIntervals(new List<(DateTimeOffset Start, DateTimeOffset End)>(toolsRaw));

        var users = DistinctSortedTimes(userMessageTimes, startAt, lastEventAt);
        var assistants = DistinctSortedTimes(assistantMessageTimes, startAt, lastEventAt);

        var waitingRaw = NormalizeIntervals(BuildWaitingIntervals(users, assistants, lastEventAt), startAt, lastEventAt);
        var waiting = MergeIntervals(new List<(DateTimeOffset Start, DateTimeOffset End)>(waitingRaw));

        var assistantSet = new HashSet<DateTimeOffset>(assistants);
        var userSet = new HashSet<DateTimeOffset>(users);
        var toolStartSet = new HashSet<DateTimeOffset>(toolsRaw.Select(x => x.Start));

        var cutPoints = new List<DateTimeOffset>(
            2
            + toolsRaw.Count * 2
            + waitingRaw.Count * 2
            + users.Length
            + assistants.Length);

        cutPoints.Add(startAt);
        cutPoints.Add(lastEventAt);

        foreach (var (start, end) in toolsRaw)
        {
            cutPoints.Add(start);
            cutPoints.Add(end);
        }

        foreach (var (start, end) in waitingRaw)
        {
            cutPoints.Add(start);
            cutPoints.Add(end);
        }

        foreach (var t in users)
        {
            cutPoints.Add(t);
        }

        foreach (var t in assistants)
        {
            cutPoints.Add(t);
        }

        cutPoints.Sort();
        var uniqueCuts = new List<DateTimeOffset>(cutPoints.Count);
        foreach (var t in cutPoints)
        {
            if (uniqueCuts.Count == 0 || uniqueCuts[^1] != t)
            {
                uniqueCuts.Add(t);
            }
        }

        if (uniqueCuts.Count < 2)
        {
            return Array.Empty<SessionTraceSpanDto>();
        }

        var baseSegments = new List<(DateTimeOffset Start, DateTimeOffset End, string Kind)>();
        var toolIdx = 0;
        var waitingIdx = 0;

        for (var idx = 0; idx < uniqueCuts.Count - 1; idx++)
        {
            var segStart = uniqueCuts[idx];
            var segEnd = uniqueCuts[idx + 1];
            if (segEnd <= segStart)
            {
                continue;
            }

            while (toolIdx < tools.Count && tools[toolIdx].End <= segStart)
            {
                toolIdx++;
            }

            var inTool = toolIdx < tools.Count && Overlaps(segStart, segEnd, tools[toolIdx].Start, tools[toolIdx].End);

            while (waitingIdx < waiting.Count && waiting[waitingIdx].End <= segStart)
            {
                waitingIdx++;
            }

            var inWaiting = waitingIdx < waiting.Count && Overlaps(segStart, segEnd, waiting[waitingIdx].Start, waiting[waitingIdx].End);

            string kind;
            if (inTool)
            {
                kind = kindTool;
            }
            else if (inWaiting || userSet.Contains(segEnd))
            {
                kind = kindWaiting;
            }
            else if (assistantSet.Contains(segEnd))
            {
                kind = kindGen;
            }
            else if (toolStartSet.Contains(segEnd))
            {
                kind = kindThink;
            }
            else
            {
                kind = kindThink;
            }

            baseSegments.Add((segStart, segEnd, kind));
        }

        if (baseSegments.Count == 0)
        {
            return Array.Empty<SessionTraceSpanDto>();
        }

        var mergedSegments = new List<(DateTimeOffset Start, DateTimeOffset End, string Kind)>(baseSegments.Count);
        foreach (var seg in baseSegments)
        {
            if (mergedSegments.Count > 0 && string.Equals(mergedSegments[^1].Kind, seg.Kind, StringComparison.Ordinal))
            {
                mergedSegments[^1] = (mergedSegments[^1].Start, seg.End, seg.Kind);
                continue;
            }

            mergedSegments.Add(seg);
        }

        int CountToolCalls(DateTimeOffset start, DateTimeOffset end)
        {
            var count = 0;
            foreach (var interval in toolsRaw)
            {
                if (Overlaps(start, end, interval.Start, interval.End))
                {
                    count++;
                }
            }

            return count;
        }

        var tokenCounts = new long[mergedSegments.Count];
        var eventCounts = new int[mergedSegments.Count];

        for (var i = 0; i < mergedSegments.Count; i++)
        {
            var seg = mergedSegments[i];
            if (string.Equals(seg.Kind, kindTool, StringComparison.Ordinal))
            {
                eventCounts[i] = CountToolCalls(seg.Start, seg.End);
            }
        }

        var sortedTokens = tokenDeltas
            .Where(x => x.Timestamp >= startAt && x.Timestamp <= lastEventAt)
            .OrderBy(x => x.Timestamp)
            .ToArray();

        var segPtr = 0;
        int? lastModelSegIdx = null;

        for (var i = 0; i < sortedTokens.Length; i++)
        {
            var tokenAt = sortedTokens[i].Timestamp;
            var delta = sortedTokens[i].Delta;
            if (delta.TotalTokens <= 0)
            {
                continue;
            }

            while (segPtr < mergedSegments.Count && mergedSegments[segPtr].End <= tokenAt)
            {
                var kind = mergedSegments[segPtr].Kind;
                if (string.Equals(kind, kindThink, StringComparison.Ordinal)
                    || string.Equals(kind, kindGen, StringComparison.Ordinal))
                {
                    lastModelSegIdx = segPtr;
                }

                segPtr++;
            }

            var targetIdx = -1;

            if (segPtr < mergedSegments.Count)
            {
                var cur = mergedSegments[segPtr];
                if (cur.Start <= tokenAt && tokenAt < cur.End
                    && (string.Equals(cur.Kind, kindThink, StringComparison.Ordinal)
                        || string.Equals(cur.Kind, kindGen, StringComparison.Ordinal)))
                {
                    targetIdx = segPtr;
                }
            }

            if (targetIdx < 0 && lastModelSegIdx.HasValue)
            {
                targetIdx = lastModelSegIdx.Value;
            }

            if (targetIdx >= 0)
            {
                tokenCounts[targetIdx] += delta.TotalTokens;
                eventCounts[targetIdx] += 1;
            }
        }

        var spans = new List<SessionTraceSpanDto>(mergedSegments.Count);
        for (var i = 0; i < mergedSegments.Count; i++)
        {
            var seg = mergedSegments[i];
            var segDurationMs = (long)(seg.End - seg.Start).TotalMilliseconds;
            if (segDurationMs <= 0)
            {
                continue;
            }

            spans.Add(new SessionTraceSpanDto(
                Kind: seg.Kind,
                DurationMs: segDurationMs,
                TokenCount: tokenCounts[i],
                EventCount: eventCounts[i]));
        }

        return spans;
    }

    private static bool TryReadTimestamp(JsonElement root, out DateTimeOffset timestamp)
    {
        timestamp = default;

        if (root.TryGetProperty("timestamp", out var tsProp) && tsProp.ValueKind == JsonValueKind.String)
        {
            var raw = tsProp.GetString();
            if (TryParseUtcTimestamp(raw, out timestamp))
            {
                return true;
            }
        }

        if (root.TryGetProperty("payload", out var payload) &&
            payload.ValueKind == JsonValueKind.Object &&
            payload.TryGetProperty("timestamp", out var payloadTs) &&
            payloadTs.ValueKind == JsonValueKind.String)
        {
            var raw = payloadTs.GetString();
            if (TryParseUtcTimestamp(raw, out timestamp))
            {
                return true;
            }
        }

        return false;
    }

    private static bool TryParseUtcTimestamp(string? raw, out DateTimeOffset timestamp)
    {
        timestamp = default;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }

        return DateTimeOffset.TryParse(
            raw,
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
            out timestamp);
    }

    private static CodexSessionEventKind GetCodexSessionEventKind(JsonElement root)
    {
        if (root.TryGetProperty("payload", out var payload) &&
            payload.ValueKind == JsonValueKind.Object &&
            payload.TryGetProperty("type", out var payloadType) &&
            payloadType.ValueKind == JsonValueKind.String)
        {
            var value = payloadType.GetString();
            if (string.IsNullOrWhiteSpace(value))
            {
                return CodexSessionEventKind.Other;
            }

            return value switch
            {
                "message" or "user_message" or "agent_message" => CodexSessionEventKind.Message,
                "function_call" or "function_call_output" or "custom_tool_call" or "custom_tool_call_output" => CodexSessionEventKind.FunctionCall,
                "agent_reasoning" or "reasoning" => CodexSessionEventKind.AgentReasoning,
                "token_count" => CodexSessionEventKind.TokenCount,
                _ => CodexSessionEventKind.Other,
            };
        }

        return CodexSessionEventKind.Other;
    }

    private static bool TryReadCodexTotalTokenUsage(JsonElement payload, out CodexTokenUsageSnapshot snapshot)
    {
        snapshot = new CodexTokenUsageSnapshot(0, 0, 0, 0);

        if (payload.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        if (!payload.TryGetProperty("type", out var payloadType) || payloadType.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        if (!string.Equals(payloadType.GetString(), "token_count", StringComparison.Ordinal))
        {
            return false;
        }

        if (!payload.TryGetProperty("info", out var info) || info.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        if (!info.TryGetProperty("total_token_usage", out var totalUsage) || totalUsage.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        var inputTokens = 0L;
        var cachedInputTokens = 0L;
        var outputTokens = 0L;
        var reasoningOutputTokens = 0L;

        if (totalUsage.TryGetProperty("input_tokens", out var inputProp) && inputProp.TryGetInt64(out var input))
        {
            inputTokens = input;
        }

        if (totalUsage.TryGetProperty("cached_input_tokens", out var cachedProp) && cachedProp.TryGetInt64(out var cached))
        {
            cachedInputTokens = cached;
        }

        if (totalUsage.TryGetProperty("output_tokens", out var outputProp) && outputProp.TryGetInt64(out var output))
        {
            outputTokens = output;
        }

        if (totalUsage.TryGetProperty("reasoning_output_tokens", out var reasoningProp) && reasoningProp.TryGetInt64(out var reasoning))
        {
            reasoningOutputTokens = reasoning;
        }

        snapshot = new CodexTokenUsageSnapshot(inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens);
        return true;
    }

    private static bool TryReadCodexTokenUsageSnapshot(JsonElement payload, out CodexTokenUsageSnapshot snapshot)
    {
        snapshot = new CodexTokenUsageSnapshot(0, 0, 0, 0);

        if (payload.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        if (!payload.TryGetProperty("type", out var payloadType) || payloadType.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        if (!string.Equals(payloadType.GetString(), "token_count", StringComparison.Ordinal))
        {
            return false;
        }

        if (!payload.TryGetProperty("info", out var info) || info.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        if (!info.TryGetProperty("last_token_usage", out var lastUsage) || lastUsage.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        var inputTokens = 0L;
        var cachedInputTokens = 0L;
        var outputTokens = 0L;
        var reasoningOutputTokens = 0L;

        if (lastUsage.TryGetProperty("input_tokens", out var inputProp) && inputProp.TryGetInt64(out var input))
        {
            inputTokens = input;
        }

        if (lastUsage.TryGetProperty("cached_input_tokens", out var cachedProp) && cachedProp.TryGetInt64(out var cached))
        {
            cachedInputTokens = cached;
        }

        if (lastUsage.TryGetProperty("output_tokens", out var outputProp) && outputProp.TryGetInt64(out var output))
        {
            outputTokens = output;
        }

        if (lastUsage.TryGetProperty("reasoning_output_tokens", out var reasoningProp) && reasoningProp.TryGetInt64(out var reasoning))
        {
            reasoningOutputTokens = reasoning;
        }

        snapshot = new CodexTokenUsageSnapshot(inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens);
        return true;
    }

    private static bool TryAccumulateCodexTokenUsage(
        JsonElement root,
        ref long inputTokens,
        ref long cachedInputTokens,
        ref long outputTokens,
        ref long reasoningOutputTokens)
    {
        if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        if (!payload.TryGetProperty("type", out var payloadType) || payloadType.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        if (!string.Equals(payloadType.GetString(), "token_count", StringComparison.Ordinal))
        {
            return false;
        }

        if (!payload.TryGetProperty("info", out var info) || info.ValueKind != JsonValueKind.Object)
        {
            return true;
        }

        if (!info.TryGetProperty("last_token_usage", out var lastUsage) || lastUsage.ValueKind != JsonValueKind.Object)
        {
            return true;
        }

        if (lastUsage.TryGetProperty("input_tokens", out var inputProp) && inputProp.TryGetInt64(out var input))
        {
            inputTokens += input;
        }

        if (lastUsage.TryGetProperty("cached_input_tokens", out var cachedProp) && cachedProp.TryGetInt64(out var cached))
        {
            cachedInputTokens += cached;
        }

        if (lastUsage.TryGetProperty("output_tokens", out var outProp) && outProp.TryGetInt64(out var output))
        {
            outputTokens += output;
        }

        if (lastUsage.TryGetProperty("reasoning_output_tokens", out var reasoningProp) && reasoningProp.TryGetInt64(out var reasoning))
        {
            reasoningOutputTokens += reasoning;
        }

        return true;
    }

    private static bool IsSameOrDescendantPath(string rootPath, string path)
    {
        if (string.IsNullOrWhiteSpace(rootPath) || string.IsNullOrWhiteSpace(path))
        {
            return false;
        }

        string rootFull;
        string candidateFull;
        try
        {
            rootFull = Path.GetFullPath(rootPath.Trim());
            candidateFull = Path.GetFullPath(path.Trim());
        }
        catch
        {
            return false;
        }

        if (candidateFull.Equals(rootFull, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var rootWithSep = rootFull.EndsWith(Path.DirectorySeparatorChar)
            ? rootFull
            : rootFull + Path.DirectorySeparatorChar;

        return candidateFull.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase);
    }

    private static string GetCodexHomePath()
    {
        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var codexHome = Environment.GetEnvironmentVariable("CODEX_HOME");
        return string.IsNullOrWhiteSpace(codexHome)
            ? Path.Combine(userProfile, ".codex")
            : codexHome;
    }

    private static bool TryDecodeClaudeProjectDirectoryName(
        string directoryName,
        out string workspacePath)
    {
        workspacePath = string.Empty;

        if (string.IsNullOrWhiteSpace(directoryName))
        {
            return false;
        }

        // Claude Code stores projects under ~/.claude/projects/<encoded-path>/...
        // On Windows this looks like: c--code-RoutinAI
        // Where:
        //   "--" => ":\"
        //   "-"  => "\"
        var trimmed = directoryName.Trim();
        var idx = trimmed.IndexOf("--", StringComparison.Ordinal);
        if (idx <= 0)
        {
            return false;
        }

        var driveToken = trimmed[..idx];
        if (driveToken.Length != 1 || !char.IsLetter(driveToken[0]))
        {
            return false;
        }

        var driveLetter = char.ToUpperInvariant(driveToken[0]);
        var rest = trimmed[(idx + 2)..];

        if (rest.Length == 0)
        {
            workspacePath = $"{driveLetter}:{Path.DirectorySeparatorChar}";
            return true;
        }

        workspacePath = $"{driveLetter}:{Path.DirectorySeparatorChar}{rest.Replace('-', Path.DirectorySeparatorChar)}";
        return true;
    }

    private const int ProjectNameMaxLength = 200;

    private static string BuildProjectNameFromCwd(string cwd)
    {
        var trimmed = cwd.Trim();
        if (trimmed.Length == 0)
        {
            return trimmed;
        }

        var withoutTrailingSeparators = trimmed.TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar);
        if (withoutTrailingSeparators.Length == 0)
        {
            withoutTrailingSeparators = trimmed;
        }

        var folderName = Path.GetFileName(withoutTrailingSeparators);
        if (string.IsNullOrWhiteSpace(folderName))
        {
            folderName = withoutTrailingSeparators;
        }

        folderName = folderName.Trim();
        if (folderName.Length == 0)
        {
            folderName = "root";
        }

        if (folderName.Length <= ProjectNameMaxLength)
        {
            return folderName;
        }

        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(folderName)));
        var suffix = "-" + hash[..8];
        var prefixLength = ProjectNameMaxLength - suffix.Length;
        if (prefixLength <= 0)
        {
            return hash[..ProjectNameMaxLength];
        }

        return folderName[..prefixLength] + suffix;
    }

    private static string EnsureUniqueProjectName(
        string baseName,
        string workspacePath,
        HashSet<string> existingNameSet)
    {
        if (!existingNameSet.Contains(baseName))
        {
            return baseName;
        }

        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(workspacePath)));
        foreach (var size in new[] { 8, 12, 16 })
        {
            var suffix = "-" + hash[..size];
            var prefixLength = ProjectNameMaxLength - suffix.Length;
            if (prefixLength <= 0)
            {
                var candidate = hash[..ProjectNameMaxLength];
                if (!existingNameSet.Contains(candidate))
                {
                    return candidate;
                }

                continue;
            }

            var prefix = baseName.Length > prefixLength
                ? baseName[..prefixLength]
                : baseName;
            var candidateName = prefix + suffix;
            if (!existingNameSet.Contains(candidateName))
            {
                return candidateName;
            }
        }

        for (var attempt = 0; attempt < 10; attempt++)
        {
            var random = Guid.NewGuid().ToString("N")[..8];
            var suffix = "-" + random;
            var prefixLength = ProjectNameMaxLength - suffix.Length;
            var prefix = baseName.Length > prefixLength
                ? baseName[..prefixLength]
                : baseName;
            var candidateName = prefix + suffix;
            if (!existingNameSet.Contains(candidateName))
            {
                return candidateName;
            }
        }

        return baseName;
    }

    private static string GetCodexConfigPath()
    {
        return Path.Combine(GetCodexHomePath(), "config.toml");
    }

    private static string GetClaudeConfigDir()
    {
        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var claudeConfigDir = Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR");
        return string.IsNullOrWhiteSpace(claudeConfigDir)
            ? Path.Combine(userProfile, ".claude")
            : claudeConfigDir;
    }

    private static string GetClaudeProjectsPath()
    {
        return Path.Combine(GetClaudeConfigDir(), "projects");
    }

    private static string GetClaudeSettingsPath()
    {
        return Path.Combine(GetClaudeConfigDir(), "settings.json");
    }

    private static async Task<ToolStatusDto> GetToolStatusAsync(
        string toolName,
        string versionArgs,
        string configPath,
        Func<string, string?> parseVersion,
        CancellationToken cancellationToken)
    {
        var configExists = File.Exists(configPath);

        var npmBin = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "npm");

        var environment = new Dictionary<string, string>(StringComparer.Ordinal);
        if (Directory.Exists(npmBin))
        {
            var existingPath = Environment.GetEnvironmentVariable("PATH") ?? "";
            if (!existingPath.Split(';', StringSplitOptions.RemoveEmptyEntries).Contains(npmBin, StringComparer.OrdinalIgnoreCase))
            {
                environment["PATH"] = $"{npmBin};{existingPath}";
            }
        }

        string? exePath = null;
        if (Directory.Exists(npmBin))
        {
            var shim = Path.Combine(npmBin, $"{toolName}.cmd");
            if (File.Exists(shim))
            {
                exePath = shim;
            }
        }

        string? versionOutput = null;

        if (!string.IsNullOrWhiteSpace(exePath))
        {
            versionOutput = await TryRunAndReadFirstLineAsync(
                fileName: "cmd.exe",
                argumentList: ["/c", exePath, versionArgs],
                timeoutMs: 15000,
                cancellationToken,
                environment);
        }

        if (string.IsNullOrWhiteSpace(versionOutput))
        {
            versionOutput = await TryRunAndReadFirstLineAsync(
                fileName: "cmd.exe",
                argumentList: ["/c", toolName, versionArgs],
                timeoutMs: 15000,
                cancellationToken,
                environment);
        }

        var version = versionOutput is null ? null : parseVersion(versionOutput);
        var installed = version is not null;

        return new ToolStatusDto(
            Installed: installed,
            Version: version,
            ExecutablePath: exePath,
            ConfigPath: configPath,
            ConfigExists: configExists);
    }

    private static string? ParseCodexVersion(string versionLine)
    {
        var tokens = versionLine.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (tokens.Length >= 2 && TryParseVersionToken(tokens[1], out var parsed))
        {
            return parsed;
        }

        if (tokens.Length >= 1 && TryParseVersionToken(tokens[0], out parsed))
        {
            return parsed;
        }

        return null;
    }

    private static string? ParseClaudeVersion(string versionLine)
    {
        var tokens = versionLine.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return tokens.Length >= 1 && TryParseVersionToken(tokens[0], out var parsed) ? parsed : null;
    }

    private static bool TryParseVersionToken(string token, out string parsed)
    {
        var trimmed = token.Trim().TrimStart('v', 'V');
        if (Version.TryParse(trimmed, out _))
        {
            parsed = trimmed;
            return true;
        }

        parsed = string.Empty;
        return false;
    }

    private static async Task<string?> TryRunAndReadFirstLineAsync(
        string fileName,
        IReadOnlyList<string> argumentList,
        int timeoutMs,
        CancellationToken cancellationToken,
        IReadOnlyDictionary<string, string>? environment = null)
    {
        var output = await TryRunAndReadOutputAsync(
            fileName,
            argumentList,
            timeoutMs,
            cancellationToken,
            environment);

        if (string.IsNullOrWhiteSpace(output))
        {
            return null;
        }

        foreach (var line in output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!string.IsNullOrWhiteSpace(line))
            {
                return line.Trim();
            }
        }

        return null;
    }

    private static async Task<string?> TryRunAndReadOutputAsync(
        string fileName,
        IReadOnlyList<string> argumentList,
        int timeoutMs,
        CancellationToken cancellationToken,
        IReadOnlyDictionary<string, string>? environment = null)
    {
        try
        {
            using var process = new Process();
            process.StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };

            foreach (var argument in argumentList)
            {
                process.StartInfo.ArgumentList.Add(argument);
            }

            if (environment is not null)
            {
                foreach (var (key, value) in environment)
                {
                    process.StartInfo.Environment[key] = value;
                }
            }

            process.Start();

            var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
            var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
            var exitTask = process.WaitForExitAsync(cancellationToken);

            var completed = await Task.WhenAny(exitTask, Task.Delay(timeoutMs, cancellationToken));
            if (completed != exitTask)
            {
                try
                {
                    if (!process.HasExited)
                    {
                        process.Kill(entireProcessTree: true);
                    }
                }
                catch
                {
                    // ignore
                }

                return null;
            }

            if (process.ExitCode != 0)
            {
                return null;
            }

            var stdout = await stdoutTask;
            if (!string.IsNullOrWhiteSpace(stdout))
            {
                return stdout.Trim();
            }

            var stderr = await stderrTask;
            return string.IsNullOrWhiteSpace(stderr) ? null : stderr.Trim();
        }
        catch
        {
            return null;
        }
    }

    private static async Task<IReadOnlyList<string>> FetchModelsAsync(
        IHttpClientFactory httpClientFactory,
        ProviderEntity provider,
        CancellationToken cancellationToken)
    {
        var client = httpClientFactory.CreateClient();

        try
        {
            return provider.RequestType switch
            {
                ProviderRequestType.OpenAI => await FetchOpenAiModelsAsync(client, provider, cancellationToken),
                ProviderRequestType.OpenAIResponses => await FetchOpenAiModelsAsync(client, provider, cancellationToken),
                ProviderRequestType.AzureOpenAI => await FetchAzureDeploymentsAsync(client, provider, cancellationToken),
                ProviderRequestType.Anthropic => await FetchAnthropicModelsAsync(client, provider, cancellationToken),
                _ => Array.Empty<string>(),
            };
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            throw new ApiHttpException(StatusCodes.Status502BadGateway, "Failed to fetch models.");
        }
    }

    private static async Task<IReadOnlyList<string>> FetchOpenAiModelsAsync(
        HttpClient client,
        ProviderEntity provider,
        CancellationToken cancellationToken)
    {
        var primaryUrl = CombineUrl(provider.Address, "/models");
        var legacyUrl = CombineUrl(provider.Address, "/v1/models");

        var urls = string.Equals(primaryUrl, legacyUrl, StringComparison.Ordinal)
            ? new[] { primaryUrl }
            : new[] { primaryUrl, legacyUrl };

        for (var i = 0; i < urls.Length; i++)
        {
            var url = urls[i];
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", provider.ApiKey);

            using var response = await client.SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                if (i < urls.Length - 1)
                {
                    continue;
                }

                response.EnsureSuccessStatusCode();
            }

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
            if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
            {
                if (i < urls.Length - 1)
                {
                    continue;
                }

                return Array.Empty<string>();
            }

            var results = new List<string>();
            foreach (var item in data.EnumerateArray())
            {
                if (item.TryGetProperty("id", out var idProp) && idProp.ValueKind == JsonValueKind.String)
                {
                    var value = idProp.GetString();
                    if (!string.IsNullOrWhiteSpace(value))
                    {
                        results.Add(value);
                    }
                }
            }

            return results;
        }

        return Array.Empty<string>();
    }

    private static async Task<IReadOnlyList<string>> FetchAnthropicModelsAsync(
        HttpClient client,
        ProviderEntity provider,
        CancellationToken cancellationToken)
    {
        var modelsUrl = CombineUrl(provider.Address, "/v1/models");

        using var request = new HttpRequestMessage(HttpMethod.Get, modelsUrl);
        request.Headers.Add("x-api-key", provider.ApiKey);
        request.Headers.Add("anthropic-version", "2023-06-01");

        using var response = await client.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<string>();
        }

        var results = new List<string>();
        foreach (var item in data.EnumerateArray())
        {
            if (item.TryGetProperty("id", out var idProp) && idProp.ValueKind == JsonValueKind.String)
            {
                var value = idProp.GetString();
                if (!string.IsNullOrWhiteSpace(value))
                {
                    results.Add(value);
                }
            }
        }

        return results;
    }

    private static async Task<IReadOnlyList<string>> FetchAzureDeploymentsAsync(
        HttpClient client,
        ProviderEntity provider,
        CancellationToken cancellationToken)
    {
        var apiVersion = string.IsNullOrWhiteSpace(provider.AzureApiVersion)
            ? "2025-04-01-preview"
            : provider.AzureApiVersion;

        var baseUrl = provider.Address.TrimEnd('/');
        var deploymentsUrl = $"{baseUrl}/openai/deployments?api-version={Uri.EscapeDataString(apiVersion)}";

        using var request = new HttpRequestMessage(HttpMethod.Get, deploymentsUrl);
        request.Headers.Add("api-key", provider.ApiKey);

        using var response = await client.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<string>();
        }

        var results = new List<string>();
        foreach (var item in data.EnumerateArray())
        {
            if (item.TryGetProperty("id", out var idProp) && idProp.ValueKind == JsonValueKind.String)
            {
                var value = idProp.GetString();
                if (!string.IsNullOrWhiteSpace(value))
                {
                    results.Add(value);
                }
            }
        }

        return results;
    }

    private static string CombineUrl(string baseUrl, string path)
    {
        var trimmedBase = baseUrl.TrimEnd('/');
        if (trimmedBase.EndsWith("/v1", StringComparison.OrdinalIgnoreCase) && path.StartsWith("/v1/", StringComparison.Ordinal))
        {
            return trimmedBase + path[3..];
        }

        return trimmedBase + path;
    }

    private static ProviderDto ToDto(ProviderEntity entity)
    {
        var hasKey = !string.IsNullOrWhiteSpace(entity.ApiKey);
        string? last4 = null;
        if (hasKey)
        {
            var trimmed = entity.ApiKey.Trim();
            last4 = trimmed.Length >= 4 ? trimmed[^4..] : trimmed;
        }

        return new ProviderDto(
            Id: entity.Id,
            Name: entity.Name,
            Address: entity.Address,
            Logo: entity.Logo,
            RequestType: entity.RequestType,
            AzureApiVersion: entity.AzureApiVersion,
            HasApiKey: hasKey,
            ApiKeyLast4: last4,
            Models: entity.Models,
            ModelsRefreshedAtUtc: entity.ModelsRefreshedAtUtc);
    }

    private static ProjectDto ToDto(ProjectEntity entity)
    {
        return new ProjectDto(
            Id: entity.Id,
            ToolType: entity.ToolType,
            Name: entity.Name,
            WorkspacePath: entity.WorkspacePath,
            ProviderId: entity.ProviderId,
            ProviderName: entity.Provider?.Name,
            Model: entity.Model,
            LastStartedAtUtc: entity.LastStartedAtUtc,
            CreatedAtUtc: entity.CreatedAtUtc,
            UpdatedAtUtc: entity.UpdatedAtUtc);
    }

    private static (string Command, IReadOnlyDictionary<string, string>? Env) BuildCodexLaunch(ProjectEntity project)
    {
        if (project.Provider is not null && project.Provider.RequestType == ProviderRequestType.Anthropic)
        {
            throw new InvalidOperationException("Codex projects do not support Anthropic providers.");
        }

        const string providerId = "onecode";
        const string envKeyName = "ONECODE_API_KEY";

        var args = new List<string>
        {
            "codex",
            "--cd",
            PsQuote(project.WorkspacePath),
        };

        if (!string.IsNullOrWhiteSpace(project.Model))
        {
            args.Add("-m");
            args.Add(PsQuote(project.Model!));

            args.Add("-c");
            args.Add(PsQuote($"model=\"{EscapeTomlString(project.Model!)}\""));
        }

        Dictionary<string, string>? env = null;
        if (project.Provider is not null)
        {
            env = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [envKeyName] = project.Provider.ApiKey,
            };

            args.Add("-c");
            args.Add(PsQuote($"model_provider=\"{providerId}\""));

            args.Add("-c");
            args.Add(PsQuote($"model_providers.{providerId}.name=\"OneCode\""));

            args.Add("-c");
            args.Add(PsQuote($"model_providers.{providerId}.base_url=\"{EscapeTomlString(project.Provider.Address)}\""));

            switch (project.Provider.RequestType)
            {
                case ProviderRequestType.OpenAI:
                    args.Add("-c");
                    args.Add(PsQuote($"model_providers.{providerId}.wire_api=\"chat\""));
                    args.Add("-c");
                    args.Add(PsQuote($"model_providers.{providerId}.env_key=\"{envKeyName}\""));
                    break;

                case ProviderRequestType.OpenAIResponses:
                    args.Add("-c");
                    args.Add(PsQuote($"model_providers.{providerId}.wire_api=\"responses\""));
                    args.Add("-c");
                    args.Add(PsQuote($"model_providers.{providerId}.env_key=\"{envKeyName}\""));
                    break;

                case ProviderRequestType.AzureOpenAI:
                {
                    var apiVersion = string.IsNullOrWhiteSpace(project.Provider.AzureApiVersion)
                        ? "2025-04-01-preview"
                        : project.Provider.AzureApiVersion;

                    args.Add("-c");
                    args.Add(PsQuote($"model_providers.{providerId}.wire_api=\"responses\""));

                    args.Add("-c");
                    args.Add(PsQuote($"model_providers.{providerId}.env_http_headers={{ \"api-key\" = \"{envKeyName}\" }}"));

                    args.Add("-c");
                    args.Add(PsQuote($"model_providers.{providerId}.query_params={{ \"api-version\" = \"{EscapeTomlString(apiVersion)}\" }}"));

                    break;
                }

                case ProviderRequestType.Anthropic:
                default:
                    throw new ArgumentOutOfRangeException(nameof(project.Provider.RequestType), project.Provider.RequestType, null);
            }
        }

        return (Command: string.Join(' ', args), Env: env);
    }

    private static (string Command, IReadOnlyDictionary<string, string>? Env) BuildClaudeLaunch(ProjectEntity project)
    {
        Dictionary<string, string>? env = null;

        if (project.Provider is not null)
        {
            if (project.Provider.RequestType != ProviderRequestType.Anthropic)
            {
                throw new InvalidOperationException("Claude Code projects require an Anthropic-compatible provider.");
            }

            env = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["ANTHROPIC_API_KEY"] = project.Provider.ApiKey,
                ["ANTHROPIC_BASE_URL"] = project.Provider.Address,
            };
        }

        var args = new List<string> { "claude" };
        if (!string.IsNullOrWhiteSpace(project.Model))
        {
            args.Add("--model");
            args.Add(PsQuote(project.Model!));
        }

        return (Command: string.Join(' ', args), Env: env);
    }

    private static string PsQuote(string value)
    {
        return $"'{value.Replace("'", "''", StringComparison.Ordinal)}'";
    }

    private static string EscapeTomlString(string value)
    {
        return value
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal);
    }
}
