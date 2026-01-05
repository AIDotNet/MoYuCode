using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace OneCode.Services.Shell;

public sealed class TerminalWindowLauncher(
    PowerShellLauncher powerShellLauncher,
    ILogger<TerminalWindowLauncher> logger)
{
    public void LaunchShellWindow(
        string workingDirectory,
        string windowTitle,
        IReadOnlyDictionary<string, string>? environment = null)
    {
        if (OperatingSystem.IsWindows())
        {
            powerShellLauncher.LaunchNewWindow(workingDirectory, windowTitle, command: string.Empty, environment);
            return;
        }

        LaunchUnixTerminal(workingDirectory, windowTitle, command: null, environment);
    }

    public void LaunchCommandWindow(
        string workingDirectory,
        string windowTitle,
        IReadOnlyList<string> argv,
        IReadOnlyDictionary<string, string>? environment = null)
    {
        if (argv.Count == 0)
        {
            LaunchShellWindow(workingDirectory, windowTitle, environment);
            return;
        }

        if (OperatingSystem.IsWindows())
        {
            var command = BuildPowerShellCommand(argv);
            powerShellLauncher.LaunchNewWindow(workingDirectory, windowTitle, command, environment);
            return;
        }

        var commandLine = BuildShellCommand(argv);
        LaunchUnixTerminal(workingDirectory, windowTitle, commandLine, environment);
    }

    private void LaunchUnixTerminal(
        string workingDirectory,
        string windowTitle,
        string? command,
        IReadOnlyDictionary<string, string>? environment)
    {
        if (OperatingSystem.IsMacOS())
        {
            LaunchMacOsTerminal(workingDirectory, windowTitle, command, environment);
            return;
        }

        if (OperatingSystem.IsLinux())
        {
            LaunchLinuxTerminal(workingDirectory, windowTitle, command, environment);
            return;
        }

        throw new InvalidOperationException("Unsupported operating system.");
    }

    private void LaunchLinuxTerminal(
        string workingDirectory,
        string windowTitle,
        string? command,
        IReadOnlyDictionary<string, string>? environment)
    {
        var script = BuildShellScript(workingDirectory, windowTitle, command, keepOpen: true, environmentPrefix: null);
        var (shell, shellArgs) = BuildShellInvocation(script);

        var candidates = new List<(string FileName, IReadOnlyList<string> Args)>
        {
            ("x-terminal-emulator", BuildGenericTerminalArgs(shell, shellArgs)),
            ("gnome-terminal", BuildGnomeTerminalArgs(workingDirectory, shell, shellArgs)),
            ("konsole", BuildKonsoleArgs(workingDirectory, shell, shellArgs)),
            ("xfce4-terminal", BuildXfceTerminalArgs(workingDirectory, shell, shellArgs)),
            ("alacritty", BuildAlacrittyArgs(workingDirectory, shell, shellArgs)),
            ("kitty", BuildKittyArgs(workingDirectory, shell, shellArgs)),
            ("wezterm", BuildWezTermArgs(workingDirectory, shell, shellArgs)),
            ("xterm", BuildXtermArgs(windowTitle, shell, shellArgs)),
        };

        foreach (var (fileName, args) in candidates)
        {
            if (TryStartDetached(fileName, args, workingDirectory, environment))
            {
                return;
            }
        }

        throw new InvalidOperationException("No supported terminal emulator found.");
    }

    private void LaunchMacOsTerminal(
        string workingDirectory,
        string windowTitle,
        string? command,
        IReadOnlyDictionary<string, string>? environment)
    {
        var envPrefix = environment is null || environment.Count == 0
            ? null
            : string.Join(' ', environment.Select(kvp => $"{kvp.Key}={ShQuote(kvp.Value)}"));

        var script = BuildShellScript(
            workingDirectory,
            windowTitle,
            command,
            keepOpen: false,
            environmentPrefix: envPrefix);

        var appleScriptCommand = $"tell application \"Terminal\" to do script \"{EscapeAppleScriptString(script)}\"";

        var startInfo = new ProcessStartInfo
        {
            FileName = "osascript",
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = workingDirectory,
        };

        startInfo.ArgumentList.Add("-e");
        startInfo.ArgumentList.Add("tell application \"Terminal\" to activate");
        startInfo.ArgumentList.Add("-e");
        startInfo.ArgumentList.Add(appleScriptCommand);

        try
        {
            Process.Start(startInfo);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to launch macOS Terminal.");
            throw;
        }
    }

    private static (string FileName, string[] Args) BuildShellInvocation(string script)
    {
        try
        {
            var bash = new ProcessStartInfo
            {
                FileName = "bash",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            bash.ArgumentList.Add("-lc");
            bash.ArgumentList.Add("exit 0");
            using var probe = Process.Start(bash);
            if (probe is not null)
            {
                probe.WaitForExit(2000);
                if (probe.ExitCode == 0)
                {
                    return ("bash", ["-lc", script]);
                }
            }
        }
        catch
        {
            // ignore
        }

        return ("sh", ["-c", script]);
    }

    private static IReadOnlyList<string> BuildGenericTerminalArgs(string shell, string[] shellArgs)
    {
        var args = new List<string>(2 + shellArgs.Length)
        {
            "-e",
            shell,
        };
        args.AddRange(shellArgs);
        return args;
    }

    private static IReadOnlyList<string> BuildGnomeTerminalArgs(
        string workingDirectory,
        string shell,
        string[] shellArgs)
    {
        var args = new List<string>(4 + shellArgs.Length)
        {
            "--working-directory",
            workingDirectory,
            "--",
            shell,
        };
        args.AddRange(shellArgs);
        return args;
    }

    private static IReadOnlyList<string> BuildKonsoleArgs(
        string workingDirectory,
        string shell,
        string[] shellArgs)
    {
        var args = new List<string>(4 + shellArgs.Length)
        {
            "--workdir",
            workingDirectory,
            "-e",
            shell,
        };
        args.AddRange(shellArgs);
        return args;
    }

    private static IReadOnlyList<string> BuildXfceTerminalArgs(
        string workingDirectory,
        string shell,
        string[] shellArgs)
    {
        var args = new List<string>(4 + shellArgs.Length)
        {
            "--working-directory",
            workingDirectory,
            "-e",
            shell,
        };
        args.AddRange(shellArgs);
        return args;
    }

    private static IReadOnlyList<string> BuildAlacrittyArgs(
        string workingDirectory,
        string shell,
        string[] shellArgs)
    {
        var args = new List<string>(5 + shellArgs.Length)
        {
            "--working-directory",
            workingDirectory,
            "-e",
            shell,
        };
        args.AddRange(shellArgs);
        return args;
    }

    private static IReadOnlyList<string> BuildKittyArgs(
        string workingDirectory,
        string shell,
        string[] shellArgs)
    {
        var args = new List<string>(3 + shellArgs.Length)
        {
            "--directory",
            workingDirectory,
            shell,
        };
        args.AddRange(shellArgs);
        return args;
    }

    private static IReadOnlyList<string> BuildWezTermArgs(
        string workingDirectory,
        string shell,
        string[] shellArgs)
    {
        var args = new List<string>(6 + shellArgs.Length)
        {
            "start",
            "--cwd",
            workingDirectory,
            "--",
            shell,
        };
        args.AddRange(shellArgs);
        return args;
    }

    private static IReadOnlyList<string> BuildXtermArgs(
        string windowTitle,
        string shell,
        string[] shellArgs)
    {
        var args = new List<string>(4 + shellArgs.Length)
        {
            "-T",
            windowTitle,
            "-e",
            shell,
        };
        args.AddRange(shellArgs);
        return args;
    }

    private static bool TryStartDetached(
        string fileName,
        IReadOnlyList<string> args,
        string workingDirectory,
        IReadOnlyDictionary<string, string>? environment)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = workingDirectory,
        };

        foreach (var arg in args)
        {
            startInfo.ArgumentList.Add(arg);
        }

        if (environment is not null)
        {
            foreach (var (key, value) in environment)
            {
                startInfo.Environment[key] = value;
            }
        }

        try
        {
            Process.Start(startInfo);
            return true;
        }
        catch (Win32Exception)
        {
            return false;
        }
        catch
        {
            return false;
        }
    }

    private static string BuildPowerShellCommand(IReadOnlyList<string> argv)
    {
        if (argv.Count == 0)
        {
            return string.Empty;
        }

        var sb = new StringBuilder();
        sb.Append(argv[0]);
        for (var i = 1; i < argv.Count; i++)
        {
            sb.Append(' ');
            sb.Append(PsQuote(argv[i]));
        }

        return sb.ToString();
    }

    private static string BuildShellCommand(IReadOnlyList<string> argv)
    {
        return string.Join(' ', argv.Select(ShQuote));
    }

    private static string BuildShellScript(
        string workingDirectory,
        string windowTitle,
        string? command,
        bool keepOpen,
        string? environmentPrefix)
    {
        var segments = new List<string>
        {
            $"cd {ShQuote(workingDirectory)}",
        };

        if (!string.IsNullOrWhiteSpace(windowTitle))
        {
            segments.Add($"printf '\\033]0;%s\\007' {ShQuote(windowTitle)}");
        }

        if (!string.IsNullOrWhiteSpace(command))
        {
            var prefixed = string.IsNullOrWhiteSpace(environmentPrefix)
                ? command
                : $"{environmentPrefix} {command}";
            segments.Add(prefixed);
        }

        if (keepOpen)
        {
            segments.Add("if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi");
        }

        return string.Join("; ", segments);
    }

    private static string EscapeAppleScriptString(string value)
    {
        return value
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal);
    }

    private static string PsQuote(string value)
    {
        return $"'{value.Replace("'", "''", StringComparison.Ordinal)}'";
    }

    private static string ShQuote(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return "''";
        }

        return "'" + value.Replace("'", "'\\''", StringComparison.Ordinal) + "'";
    }
}
