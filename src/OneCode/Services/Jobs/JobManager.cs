using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using OneCode.Contracts.Jobs;

namespace OneCode.Services.Jobs;

public sealed class JobManager(ILogger<JobManager> logger)
{
    private readonly ConcurrentDictionary<Guid, JobState> _jobs = new();

    public JobDto StartProcessJob(
        string kind,
        string fileName,
        string arguments,
        string? workingDirectory = null,
        IReadOnlyDictionary<string, string>? environment = null)
    {
        var state = new JobState(kind);
        if (!_jobs.TryAdd(state.Id, state))
        {
            throw new InvalidOperationException("Failed to create job.");
        }

        _ = Task.Run(async () =>
        {
            await RunProcessAsync(state, fileName, arguments, workingDirectory, environment);
        });

        return state.ToDto();
    }

    public bool TryGetJob(Guid id, out JobDto job)
    {
        if (_jobs.TryGetValue(id, out var state))
        {
            job = state.ToDto();
            return true;
        }

        job = default!;
        return false;
    }

    private async Task RunProcessAsync(
        JobState state,
        string fileName,
        string arguments,
        string? workingDirectory,
        IReadOnlyDictionary<string, string>? environment)
    {
        state.MarkRunning();
        state.AddLog($"$ {fileName} {arguments}");
        var resolvedWorkingDirectory = workingDirectory ?? Environment.CurrentDirectory;

        logger.LogInformation(
            "Job {JobId} ({Kind}) starting: {FileName} {Arguments} (WorkingDirectory={WorkingDirectory})",
            state.Id,
            state.Kind,
            fileName,
            arguments,
            resolvedWorkingDirectory);

        try
        {
            using var process = new Process();
            process.StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                WorkingDirectory = resolvedWorkingDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };

            if (environment is not null)
            {
                foreach (var (key, value) in environment)
                {
                    process.StartInfo.Environment[key] = value;
                }
            }

            process.Start();

            var stdoutTask = ReadLinesAsync(process.StandardOutput, state);
            var stderrTask = ReadLinesAsync(process.StandardError, state);

            await Task.WhenAll(stdoutTask, stderrTask, process.WaitForExitAsync());

            var exitCode = process.ExitCode;
            state.MarkFinished(exitCode);

            if (exitCode == 0)
            {
                logger.LogInformation("Job {JobId} ({Kind}) finished with exit code 0.", state.Id, state.Kind);
            }
            else
            {
                logger.LogWarning(
                    "Job {JobId} ({Kind}) finished with exit code {ExitCode}.",
                    state.Id,
                    state.Kind,
                    exitCode);
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Job {JobId} ({Kind}) failed.", state.Id, state.Kind);
            state.AddLog(ex.ToString());
            state.MarkFailed();
        }
    }

    private static async Task ReadLinesAsync(StreamReader reader, JobState state)
    {
        while (true)
        {
            var line = await reader.ReadLineAsync();
            if (line is null)
            {
                break;
            }

            if (!string.IsNullOrWhiteSpace(line))
            {
                state.AddLog(line);
            }
        }
    }

    private sealed class JobState
    {
        private const int MaxLogLines = 4000;

        private readonly object _gate = new();
        private readonly List<string> _logs = [];

        public JobState(string kind)
        {
            Id = Guid.NewGuid();
            Kind = kind;
            Status = JobStatus.Pending;
            CreatedAtUtc = DateTimeOffset.UtcNow;
        }

        public Guid Id { get; }

        public string Kind { get; }

        public JobStatus Status { get; private set; }

        public DateTimeOffset CreatedAtUtc { get; }

        public DateTimeOffset? StartedAtUtc { get; private set; }

        public DateTimeOffset? FinishedAtUtc { get; private set; }

        public int? ExitCode { get; private set; }

        public void AddLog(string line)
        {
            lock (_gate)
            {
                _logs.Add(line);
                if (_logs.Count > MaxLogLines)
                {
                    _logs.RemoveRange(0, _logs.Count - MaxLogLines);
                }
            }
        }

        public void MarkRunning()
        {
            Status = JobStatus.Running;
            StartedAtUtc = DateTimeOffset.UtcNow;
        }

        public void MarkFinished(int exitCode)
        {
            ExitCode = exitCode;
            FinishedAtUtc = DateTimeOffset.UtcNow;
            Status = exitCode == 0 ? JobStatus.Succeeded : JobStatus.Failed;
        }

        public void MarkFailed()
        {
            FinishedAtUtc = DateTimeOffset.UtcNow;
            Status = JobStatus.Failed;
        }

        public JobDto ToDto()
        {
            IReadOnlyList<string> logsSnapshot;
            lock (_gate)
            {
                logsSnapshot = _logs.ToList();
            }

            return new JobDto(
                Id: Id,
                Kind: Kind,
                Status: Status,
                CreatedAtUtc: CreatedAtUtc,
                StartedAtUtc: StartedAtUtc,
                FinishedAtUtc: FinishedAtUtc,
                ExitCode: ExitCode,
                Logs: logsSnapshot);
        }
    }
}

